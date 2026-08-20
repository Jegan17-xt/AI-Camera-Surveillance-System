import threading

import numpy as np
import torch

# --- CPU Oversubscription Fix ---
# Mirrors the reasoning already applied to onnxruntime (face/face_detector.
# py's _build_session_options: intra_op_num_threads=2, inter_op_num_threads=1)
# and OpenCV (camera/detection_service.py's cv2.setNumThreads(2)) — both were
# capped after a live incident where an uncapped per-session thread pool
# starved the RTSP reader thread of CPU on this machine's 4 cores. PyTorch/
# Ultralytics (used by every YOLO model instance below — one per camera) was
# never given the same cap: left at its own default, it sizes its intra-op
# thread pool to the full core count, PER PROCESS, and with multiple camera
# worker threads calling model.track() concurrently that oversubscribes the
# exact same cores the onnxruntime/cv2 caps already protect. Set once, here,
# before `import ultralytics` (transitively, via `from ultralytics import
# YOLO` below) or any model is constructed — torch.set_num_interop_threads()
# can only be set once per process and must run before any parallel work
# starts, so this must happen at first import, not lazily inside _get_model().
# This only changes how many OS threads PyTorch is allowed to use internally;
# it changes no model weights, inputs, outputs, or tracking/detection
# decision, so accuracy and behavior are unaffected.
torch.set_num_threads(2)
try:
    torch.set_num_interop_threads(1)
except RuntimeError:
    # Already set (e.g. some other import path touched torch's interop
    # pool first) — non-fatal, intra-op cap above still applies.
    pass

from ultralytics import YOLO

# --- Startup Fix: lazy model load ---
# Same reasoning as face/face_detector.py's get_app(): this used to
# construct YOLO("yolov8n.pt") at import time, which blocked Flask's
# startup (app.run() was never reached until this — and InsightFace's
# model load right after it — finished). Loads once per tracking_key (see
# below), on the first real call to detect() for that camera, which only
# happens inside a camera worker's background thread after Flask is
# already listening.

# --- ByteTrack: one model instance per camera/tracking_key ---
# model.track(frame, persist=True) attaches its tracker state directly to
# the calling YOLO instance's own predictor (ultralytics.trackers.
# register_tracker / on_predict_postprocess_end): for a single-image
# (non-"stream") source it creates and reuses exactly ONE tracker object
# per model instance, regardless of which camera the frame came from. A
# single model shared across every camera (the previous design) would
# therefore silently merge ByteTrack's track IDs and continuity across
# unrelated physical cameras — a real correctness bug, not just a style
# issue. Keying model instances by tracking_key (the same key frame_
# processor.py/track_verifier.py already use to scope a camera's own
# consensus tracking) gives each camera its own isolated tracker, at the
# cost of a small amount of extra memory/one-time load per distinct
# camera ever seen by this process — accepted trade-off, confirmed with
# the user before implementing.
_models = {}
_models_lock = threading.Lock()

# --- Diagnostic only: pre-ByteTrack detection visibility ---
# model.track() REPLACES predictor.results[i] with only the
# tracker-confirmed subset before returning (see ultralytics.trackers.
# track.on_predict_postprocess_end: `predictor.results[i] = result[idx]`,
# where idx are the boxes the tracker actually matched/kept this cycle).
# So len(results[0].boxes) on detect()'s return value is POST-ByteTrack,
# not the raw count YOLO itself found — the two CAN legitimately differ
# (YOLO finds a person, ByteTrack doesn't confirm/keep it this cycle).
# To tell these two cases apart (per this investigation's explicit ask)
# without a second inference call — which would violate "YOLO must be
# called exactly once per cycle" — a callback is registered on the SAME
# model instance for the SAME event ByteTrack itself hooks
# ("on_predict_postprocess_end"), at model-creation time, i.e. BEFORE
# register_tracker() ever runs (that only happens lazily, inside the
# FIRST real .track() call). Ultralytics fires same-event callbacks in
# registration order, so this one always observes predictor.results
# BEFORE ByteTrack's own callback replaces them. Purely observational:
# it never mutates predictor.results, never touches confidence/classes/
# tracker config, and detect() below still returns exactly what
# model.track() actually returns, completely unchanged.
_pretrack_info = {}  # tracking_key -> {"count": int, "confs": [float, ...]}
_pretrack_lock = threading.Lock()


def _record_pretrack_detections(tracking_key):

    def _callback(predictor):
        try:
            boxes = predictor.results[0].boxes
            confs = [float(c) for c in boxes.conf.tolist()] if len(boxes) else []
            with _pretrack_lock:
                _pretrack_info[tracking_key] = {"count": len(boxes), "confs": confs}
        except Exception:
            pass  # diagnostic only — must never affect real detection

    return _callback


def get_pretrack_info(tracking_key):
    """Most recent pre-ByteTrack YOLO detection count/confidences for
    this tracking_key — diagnostic only, see _record_pretrack_detections
    above. Returns {"count": None, "confs": []} before the first
    completed cycle for this tracking_key."""

    with _pretrack_lock:
        return _pretrack_info.get(tracking_key, {"count": None, "confs": []})


def drop_model(tracking_key):
    """Releases a camera's cached YOLO model instance + its diagnostic
    pre-track info — call this when a camera is genuinely DELETED (never
    on disable/restart, which reuse the same tracking_key and should
    keep their already-loaded model exactly as before). A deleted camera
    that's later re-added gets a brand-new camera_id, i.e. a brand-new
    tracking_key — without this, the old entry (a full loaded YOLO
    model, non-trivial memory) would sit in _models forever with nothing
    left able to reach it again. Safe to call for a tracking_key with no
    cached model (no-op)."""

    with _models_lock:
        _models.pop(tracking_key, None)

    with _pretrack_lock:
        _pretrack_info.pop(tracking_key, None)


def _get_model(tracking_key):
    if tracking_key not in _models:
        with _models_lock:
            if tracking_key not in _models:
                print(f"[INIT] Loading YOLO model (yolov8n.pt) for tracking_key={tracking_key} — first use...")
                model = YOLO("yolov8n.pt")
                model.add_callback("on_predict_postprocess_end", _record_pretrack_detections(tracking_key))
                _models[tracking_key] = model
                print(f"[INIT] YOLO model ready for tracking_key={tracking_key}")

    return _models[tracking_key]


def warmup(tracking_key):
    """AI Performance Fix: pays YOLO's one-time cold-start cost (weight
    load off disk, PyTorch thread-pool/oneDNN init, ByteTrack tracker
    registration — historically 5-30+ seconds on a CPU-only machine, the
    exact cost the "--- Startup Fix: lazy model load ---" comment above
    already documents) ONCE, at camera worker startup, instead of on
    whichever real frame happens to be first through detect() during
    live detection. Same _get_model()/model.track() code path as a real
    call — this IS the first real call for this tracking_key, just made
    at a moment nothing is waiting on its result, rather than blocking
    the AI processing cycle for a frame a viewer is actively watching.
    A tiny dummy frame is enough to trigger every one-time cost; its
    content and size never affect what gets cached."""

    dummy_frame = np.zeros((64, 64, 3), dtype=np.uint8)
    detect(dummy_frame, tracking_key)


def detect(frame, tracking_key):
    # persist=True: keep THIS camera's own tracker state (track IDs,
    # motion prediction, lost-track buffer) alive between calls instead
    # of resetting it every frame — required for continuous track IDs.
    # tracker="bytetrack.yaml": Ultralytics' built-in ByteTrack config,
    # unmodified/default. conf is passed explicitly so it keeps using
    # this project's existing 0.35 threshold — model.track() otherwise
    # falls back to its own default of 0.1 for tracking mode.
    results = _get_model(tracking_key).track(
        frame,
        persist=True,
        tracker="bytetrack.yaml",
        classes=[0],      # Person only
        conf=0.35,        # Confidence threshold
        verbose=False     # Remove terminal logs
    )
    return results
