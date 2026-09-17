import cv2
import datetime
import threading
import time

from detection.detector import (
    detect,
    get_pretrack_info,
    PERSON_CLASS_ID,
    VEHICLE_CLASS_IDS,
    ANIMAL_CLASS_IDS,
    BIRD_CLASS_ID,
    COCO_CLASS_NAMES,
)
from detection import fire_detector
from events import manager as event_manager
from face.face_detector import detect_faces
from face.recognizer import recognize
from face.quality import assess_face_quality
from face.track_verifier import update_track, peek_track
from face.unknown_manager import save_unknown, is_new_unknown_save_allowed, mark_unknown_batch_saved
from attendance.attendance import mark_attendance
from face.database import get_database
from error_logging import log_exception

# --- Temporary debug logging (Critical AI Pipeline Debug) ---
# One line per named stage of Camera Frame -> YOLO -> Face Detection ->
# Quality -> Embedding -> Registered Matching -> Unknown Logic ->
# Attendance, so a stalled pipeline shows exactly which stage it stopped
# at instead of just "nothing happened". Remove once the pipeline is
# confirmed healthy against real camera traffic.
PIPELINE_DEBUG = True

# --- AI Performance Optimization: per-stage timing ---
# Prints a full timing breakdown for every processed frame — this is
# what actually located the bottleneck (see camera/detection_service.py
# and face/face_detector.py for what changed as a result) instead of
# guessing which of YOLO / face detection / embedding / recognition /
# consensus / attendance was slow.
STAGE_TIMING = True

# --- Temporary [AI DEBUG] trace (AI Detection Pipeline Debug) ---
# Six explicit, uniquely-tagged checkpoints across one process_frame()
# call — "frame received" / "process_frame called" / "YOLO inference
# started" / "YOLO detections count = X" / "Face detection count = X" /
# "frame processing completed" — so it is unambiguous, from the log
# alone, that the pipeline is actually running every frame (not just
# streaming) and exactly how many raw YOLO boxes / faces each frame
# produced. Layered on top of the existing [AI-CYCLE]/[PIPELINE] logs,
# changes no detection logic. Flip AI_DEBUG off once the pipeline is
# confirmed healthy on the target hardware.
AI_DEBUG = True


def _aidbg(msg):
    if AI_DEBUG:
        print(f"[AI DEBUG] {msg}")

# --- AI Input Resize (display quality is never affected) ---
# Profiling (see the [TIMING] breakdown this same flag prints) showed
# YOLO/InsightFace wall-clock cost is roughly FLAT across 640x480 through
# 2560x1440 — both models internally letterbox/resize to a fixed inference
# size (YOLO's default 640, InsightFace's det_size=(640,640)) regardless of
# what's handed to them, so raw CPU inference time, not resolution, is the
# dominant cost. Resizing the AI input still cuts real, if modest, overhead
# (letterbox/resize work + memory copies scale with input size) and is what
# was explicitly requested: AI runs against a shrunk copy, while
# annotated_frame is built from the untouched full-resolution `frame` — the
# live stream's displayed quality never changes. 1280px keeps the longest
# side comfortably above InsightFace's own 640 internal detection size, so
# it isn't discarding any more detail than InsightFace's own det_size
# already would.
AI_INPUT_MAX_DIMENSION = 1280

# --- Short-Term Detection Persistence (purely visual, never re-fires
# recognition/attendance/unknown-save) ---
# Root cause of "detection appears for a moment and disappears": every
# process_frame() call produces a BRAND NEW annotated_frame from scratch.
# A single missed YOLO/face detection (occlusion, motion blur, or the
# person_count gate below skipping face detection when YOLO itself missed
# for one cycle) draws NOTHING that cycle — even though the PREVIOUS
# cycle's detection is still well within ANNOTATION_STALE_SECONDS
# (detection_service.py), the box vanishes the instant a single cycle
# comes back empty, then reappears next cycle. That read-and-reappear is
# exactly the "intermittent" symptom.
#
# This cache holds only the last successfully DRAWN boxes/labels per
# tracking_key (camera_id, or a customer-scoped key — same key
# face/track_verifier.py uses), with a timestamp. When a cycle finds
# nothing to draw, it redraws the cached boxes onto the CURRENT frame
# instead of leaving it blank — but only for PERSISTENCE_WINDOW_SECONDS,
# so a genuine, sustained absence (person actually left frame) still
# correctly clears the overlay. It never touches recognition, consensus,
# attendance, or unknown-person saving — those only ever fire from a
# real, fresh detection in the block above; a persisted box is a pure
# redraw of already-processed information, so persisting it can't
# double-mark attendance or double-save an unknown person. Zero added
# latency: no extra model call, just a few cv2.rectangle/putText calls
# against already-known coordinates.
_detection_cache = {}
_detection_cache_lock = threading.Lock()

# Continuous Bounding Box Investigation (Task E): the 0.45s band above
# was sized for a ~200ms/cycle assumption. Live [AI-CYCLE] evidence on a
# busy RTSP scene (camera 18, 8-11 people) showed total_ms per cycle
# ranging 4.4s-46.3s, and even the local webcam runs multi-second cycles
# under real model-warm conditions. A within-cycle miss (this cache's
# job — bridging a single empty YOLO/face result inside one
# process_frame() call) can therefore span several seconds, not
# milliseconds. 5.0s covers a full missed cycle at the slower end of
# measured single-person timings while still clearing quickly once a
# person genuinely leaves (detection_service.py's separate
# ANNOTATION_STALE_SECONDS, raised alongside this for the same reason,
# governs the coarser reader-thread fallback).
PERSISTENCE_WINDOW_SECONDS = 5.0

# --- Smart Face Detection Gate ---
# The CPU-saving gate below ("only run InsightFace when YOLO found a
# person") is correct for the common empty-room case but was too strict:
# a single missed YOLO detection skipped InsightFace outright, even
# though InsightFace scans the whole frame independently of YOLO's box
# and would often have found the face anyway (confirmed by direct
# measurement: 20/20 YOLO hits vs 19/20 InsightFace hits on the same
# frames — the two are not coupled by anything except this gate).
#
# Fix, without removing the optimization: remember the last wall-clock
# time (per tracking_key) that EITHER a person (YOLO) or a face
# (InsightFace) was actually seen. Face detection now runs whenever
# EITHER is true this cycle:
#   - YOLO found a person this cycle (the original condition), OR
#   - neither did, but the grace window since the last time either
#     signal fired hasn't elapsed yet (person/face genuinely still
#     likely in frame, YOLO just missed this one cycle).
# Only once FACE_DETECTION_GRACE_SECONDS passes with NEITHER signal does
# the gate actually skip InsightFace again — the exact same CPU saving
# as before for a real, sustained empty room, just no longer triggered
# by a single transient YOLO miss.
_face_gate_last_seen = {}
_face_gate_lock = threading.Lock()

FACE_DETECTION_GRACE_SECONDS = 2.0

# --- Multi-Object & Fire Detection ---
# Vehicles/animals ride along on the SAME single YOLO model.track() call
# as person detection (detection/detector.py) — essentially free. Fire/
# smoke is a SEPARATE optional model, so it runs at most once per this
# interval per camera to keep its extra CPU cost bounded on this 4-core
# box (a real fire does not go out in 1.5s, and the on-frame banner is
# persisted between checks — see FIRE_OVERLAY_PERSIST_SECONDS).
FIRE_DETECTION_INTERVAL_SECONDS = 1.5
# How long the "FIRE DETECTED" banner + boxes keep being redrawn after
# the last positive fire pass — comfortably longer than the check
# interval so the warning is steady, not flickering, while still
# clearing within a few seconds once the fire is genuinely gone. Purely
# visual; never re-records an event.
FIRE_OVERLAY_PERSIST_SECONDS = 4.0

_fire_last_run = {}  # tracking_key -> last wall-clock time detect_fire() ran
_fire_gate_lock = threading.Lock()


def drop_tracking_state(tracking_key):
    """Releases this camera's cached detection-persistence overlay
    (_detection_cache) and face-detection-gate timestamp
    (_face_gate_last_seen) — call this when a camera is genuinely
    DELETED, same "never on disable/restart" rule as detection/detector.
    py's drop_model(). Both caches are small (a handful of boxes/labels,
    one float) per camera, but with nothing left able to reach a deleted
    camera's tracking_key again, entries would otherwise accumulate here
    forever across every camera ever deleted. Safe to call for a
    tracking_key with no cached state (no-op)."""

    with _detection_cache_lock:
        _detection_cache.pop(tracking_key, None)

    with _face_gate_lock:
        _face_gate_last_seen.pop(tracking_key, None)

    with _fire_gate_lock:
        _fire_last_run.pop(tracking_key, None)

    # A real camera's tracking_key IS its integer camera_id (see
    # compute_tracking_key) — that's exactly what the event manager keys
    # its dedup state on. The customer-scoped string fallback has no
    # camera_id and no per-camera dedup rows to prune.
    if isinstance(tracking_key, int):
        event_manager.drop_recent_state(tracking_key)


def compute_tracking_key(customer_id, camera_id):
    """The one shared rule for which tracking_key a given (customer_id,
    camera_id) pair uses — YOLO/ByteTrack model caching (detection/
    detector.py) and camera/detection_service.py's startup warmup must
    both compute the exact same key process_frame() below does, or
    warmup would pre-load a model instance that never actually gets
    reused."""

    return camera_id if camera_id is not None else f"customer:{customer_id}"


def _log(msg):
    if PIPELINE_DEBUG:
        print(f"[PIPELINE] {msg}")


def _camlog(camera_id, msg):
    """Uniform `[CAMERA <id>] <MESSAGE>` line — same helper/shape as
    camera/detection_service.py's own _camlog (kept as a separate,
    tiny, dependency-free copy here rather than importing across that
    module boundary), used for the per-frame PERSONS/FACES/OBJECTS/
    FIRE-SMOKE/DETECTION EVENT CREATED counts this function has direct
    access to. Skipped for the local-webcam debug source (camera_id is
    None there) and for the standalone script (camera/camera.py, also
    None) — neither is a real "added camera"."""

    if camera_id is not None:
        print(f"[CAMERA {camera_id}] {msg}")


def _ms(seconds):
    return round(seconds * 1000, 1)


def _resize_for_ai(frame):
    """Returns (ai_frame, scale). scale is 1.0 (frame unchanged) when the
    frame is already at or below AI_INPUT_MAX_DIMENSION — the local webcam
    (640x480) is never touched, only genuinely large sources like the
    2560x1440 RTSP camera are. Every box/bbox/kps coordinate produced from
    ai_frame must be divided by `scale` to map back to `frame`'s space."""

    h, w = frame.shape[:2]
    longest = max(w, h)

    if longest <= AI_INPUT_MAX_DIMENSION:
        return frame, 1.0

    scale = AI_INPUT_MAX_DIMENSION / longest
    resized = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def process_frame(frame, customer_id, camera_id=None, capture_time=None, source_label="RTSP", owner_user_id=None):
    """Runs the existing YOLO + InsightFace + recognition + attendance +
    unknown-detection pipeline on a single frame and returns the
    annotated frame.

    This is THE ONE shared AI pipeline — camera/detection_service.py
    calls this exact function for both real RTSP cameras and the local
    webcam debug source (see start_camera_worker(..., is_local=True) and
    camera/stream.py). Nothing in this function branches on where the
    frame came from except the `source_label` used for logging below;
    quality/recognition/consensus/attendance/unknown logic is identical
    either way, by construction (there's only one code path to run).

    `customer_id` scopes every write this frame produces (attendance
    marks, newly-saved unknown people) and every read used to recognize a
    face (the registered-persons embedding database) to one customer —
    without it, whichever customer's face happened to be in front of the
    single shared camera would have been matched against, and would have
    written into, every other customer's data.

    `camera_id` (optional) scopes the multi-frame consensus tracker
    (face/track_verifier.py) to this specific physical camera, so two
    different cameras never share/interfere with each other's tracks.
    Falls back to a customer-scoped key when absent — both the standalone
    interactive script (camera/camera.py) and the local webcam worker
    (which has no row in the `cameras` table to reference) have no real
    camera_id to pass, so they share one tracking key per customer
    instead.

    `capture_time` (optional) is the wall-clock time the raw frame was
    actually pulled off the RTSP/webcam source (camera/detection_service.
    py's reader thread) — used only to report real "Frame Capture"
    latency (queueing/backlog) in the timing breakdown below; absent for
    the standalone script, which has no separate reader thread.

    `source_label` ("RTSP" or "WEBCAM") is purely for the debug log line
    below — camera/detection_service.py sets it from the worker's
    is_local flag. It never affects any detection/recognition decision.

    `owner_user_id` (optional) is passed straight through to
    face/unknown_manager.py's save_unknown() as its Per-User Data
    Isolation fallback — only used there when `camera_id` is None (the
    local-webcam debug source has no `cameras` table row to derive an
    owner from otherwise). Ignored whenever a real camera_id is present,
    since that already resolves ownership itself, unchanged.

    This is the exact per-frame logic that used to live inline inside
    camera.start_camera()'s loop, lifted out unchanged so both the
    standalone interactive script (camera.py) and the Flask MJPEG stream
    (camera/stream.py) call the same code instead of two copies of it."""

    pipeline_start = time.perf_counter()
    timings = {}
    print("[AI-CYCLE] start")
    _aidbg(f"process_frame called (camera={camera_id} customer={customer_id})")

    if capture_time is not None:
        timings["Frame Capture"] = _ms(pipeline_start - capture_time)
        print(f"[AI-CYCLE] frame_age_ms={timings['Frame Capture']}")
    else:
        print("[AI-CYCLE] frame_age_ms=n/a")

    tracking_key = compute_tracking_key(customer_id, camera_id)

    _log(f"Source={source_label} | Frame received customer={customer_id} camera={camera_id} size={frame.shape[1]}x{frame.shape[0]}")

    ai_frame, ai_scale = _resize_for_ai(frame)
    if ai_scale != 1.0:
        _log(f"AI input resized: {frame.shape[1]}x{frame.shape[0]} -> {ai_frame.shape[1]}x{ai_frame.shape[0]} (scale={ai_scale:.3f}); display stays full resolution")

    # Lazily imported (same reasoning as face/unknown_manager.py's lazy
    # `from api.settings import get_settings`) — the per-customer AI
    # Configuration. Read ONCE per frame here (a ~3s-TTL cached read, see
    # api/ai_config.py) and consulted by every gate below: the YOLO class
    # list (person / vehicles / animals), the fire pass, face
    # recognition, unknown-save, attendance.
    from api.ai_config import get_ai_config
    ai_config = get_ai_config(customer_id)

    # ---------------- YOLO ----------------
    # annotated_frame is always built from the untouched full-resolution
    # `frame`, never from ai_frame — results[0].plot() is no longer used
    # for the base image because it would return an image at ai_frame's
    # (possibly downscaled) size. Each box is drawn manually instead,
    # scaled back up to full-resolution coordinates first.
    t0 = time.perf_counter()
    person_count = 0
    annotated_frame = frame.copy()
    person_boxes_drawn = []
    # (x1, y1, x2, y2, label_text, color) for vehicles/animals drawn this
    # cycle — used only for the short-term persistence redraw below, same
    # as person_boxes_drawn. Never re-fires an event on redraw.
    object_boxes_drawn = []

    # Multi-Object Detection: person is always requested; vehicles and/or
    # animals are appended only when this customer has them enabled.
    # Still exactly ONE model.track() call — box.cls disambiguates.
    wanted_classes = [PERSON_CLASS_ID]
    if ai_config.get("object_detection_enabled", True):
        wanted_classes += list(VEHICLE_CLASS_IDS)
    if ai_config.get("animal_detection_enabled", True):
        wanted_classes += list(ANIMAL_CLASS_IDS)

    try:
        _aidbg(f"YOLO inference started (classes={wanted_classes})")
        results = detect(ai_frame, tracking_key, classes=wanted_classes)
        _aidbg(f"YOLO detections count = {len(results[0].boxes)}")

        for box in results[0].boxes:
            cls_id = int(box.cls[0]) if box.cls is not None else PERSON_CLASS_ID
            bx1, by1, bx2, by2 = [v / ai_scale for v in box.xyxy[0].tolist()]
            conf = float(box.conf[0])
            bx1, by1, bx2, by2 = int(bx1), int(by1), int(bx2), int(by2)
            # ByteTrack (Ultralytics built-in, see detection/detector.py) —
            # box.id is this physical object's persistent track ID across
            # frames, or None on the rare box the tracker hasn't confirmed/
            # assigned an ID to yet this cycle. Purely a display label:
            # never fed into recognition/consensus/attendance/unknown-save
            # below, which stay driven only by face embeddings, unchanged.
            track_id = int(box.id[0]) if box.id is not None else None

            if cls_id == PERSON_CLASS_ID:
                person_count += 1
                label = f"person id={track_id} {conf:.2f}" if track_id is not None else f"person {conf:.2f}"
                cv2.rectangle(annotated_frame, (bx1, by1), (bx2, by2), (0, 255, 0), 2)
                cv2.putText(
                    annotated_frame,
                    label,
                    (bx1, max(0, by1 - 10)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 255, 0),
                    2
                )
                person_boxes_drawn.append((bx1, by1, bx2, by2, conf, track_id))
                continue

            # --- Vehicle / bird / animal ---
            # The specific COCO class (obj_name) is kept only as the
            # internal object_type on the event; everything the operator
            # sees — the on-frame label, the event category, the
            # dashboard — uses the generic category. Bird is its own
            # category; every other non-bird animal collapses to ANIMAL;
            # every vehicle class collapses to VEHICLE.
            obj_name = COCO_CLASS_NAMES.get(cls_id, str(cls_id))

            if cls_id == BIRD_CLASS_ID:
                category, event_type, color = "bird", event_manager.EVENT_BIRD, (0, 200, 255)
            elif cls_id in VEHICLE_CLASS_IDS:
                category, event_type, color = "vehicle", event_manager.EVENT_CAR, (255, 128, 0)
            else:
                category, event_type, color = "animal", event_manager.EVENT_ANIMAL, (0, 165, 255)

            obj_label = f"{category.upper()} {int(round(conf * 100))}%"
            cv2.rectangle(annotated_frame, (bx1, by1), (bx2, by2), color, 2)
            cv2.putText(
                annotated_frame,
                obj_label,
                (bx1, max(0, by1 - 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                color,
                2
            )
            object_boxes_drawn.append((bx1, by1, bx2, by2, obj_label, color))

            # Event Manager owns dedup/"no duplicate events" + the row
            # write + the ONE snapshot per new event — a lingering object
            # just bumps detection_count, no new row, no new image. Never
            # raises (see events/manager.py). dedup_bucket is the generic
            # category so a car then a bus share one VEHICLE event.
            # snapshot: this frame with the box already drawn on it.
            event_manager.record_detection(
                customer_id,
                event_type,
                camera_id=camera_id,
                owner_user_id=owner_user_id,
                object_type=obj_name,
                confidence=conf,
                dedup_bucket=category,
                snapshot=annotated_frame,
            )

        if person_count:
            _log(f"Person detected: {person_count}")
        else:
            _log("No person detected")
        if object_boxes_drawn:
            _log(f"Vehicles/animals/birds detected: {len(object_boxes_drawn)}")
        _camlog(camera_id, f"PERSONS: {person_count}")
        _camlog(camera_id, f"OBJECTS: {len(object_boxes_drawn)}")
    except Exception as e:
        log_exception(e, "YOLO detection")
        _log("YOLO detection failed — see [ERROR] above")
        _camlog(camera_id, "PERSONS: 0")
        _camlog(camera_id, "OBJECTS: 0")
    timings["YOLO Detection"] = _ms(time.perf_counter() - t0)
    print(f"[AI-CYCLE] YOLO_ms={timings['YOLO Detection']}")
    # Diagnostic only — reads the exact same person_count/track_id values
    # already computed above for drawing; adds no new computation and
    # changes no detection/tracking decision.
    _track_ids = [tid for (_x1, _y1, _x2, _y2, _conf, tid) in person_boxes_drawn]
    print(f"[AI-CYCLE] person_count={person_count} track_ids={_track_ids}")

    # ---------------- Intermittent Detection Investigation (diagnostic
    # only — no threshold/ByteTrack/tracking decision is read, used, or
    # changed by any of this) ----------------
    # frame_timestamp is when THIS cycle actually ran (wall clock) — not
    # a separately-tracked capture-side timestamp, since the reader
    # thread only stores a monotonic perf_counter value (see
    # capture_time above and its own comment on why). Combined with
    # frame_age_ms (already computed above from that same perf_counter
    # value), the two together tell you both "when" and "how stale".
    _pretrack = get_pretrack_info(tracking_key)
    _pretrack_count = _pretrack["count"]
    _best_conf = max(_pretrack["confs"]) if _pretrack["confs"] else None

    print("[DETECT-DEBUG]")
    print(f"camera={camera_id}")
    print(f"frame_timestamp={datetime.datetime.now().strftime('%d-%m-%Y %H:%M:%S.%f')[:-3]}")
    print(f"frame_age_ms={timings.get('Frame Capture', 'n/a')}")
    print(f"frame_width={frame.shape[1]}")
    print(f"frame_height={frame.shape[0]}")
    print(f"yolo_ms={timings['YOLO Detection']}")
    print(f"person_count={person_count}")
    print(f"track_ids={_track_ids}")

    # person_candidates == final_person_count in this codebase's current
    # implementation UNLESS ByteTrack itself dropped a detection this
    # cycle: conf=0.35/classes=[0] are applied INSIDE the single
    # model.track() call (detection/detector.py) — there is no separate
    # "before this filter" stage to observe without a second inference
    # call, which would violate "YOLO must be called exactly once per
    # cycle". best_person_conf is only ever known for a box YOLO actually
    # returned — when YOLO returns zero candidates outright, there is
    # nothing to report a confidence FOR, so this is 'n/a' rather than an
    # invented number; that itself is the answer to "did YOLO fail to
    # detect a visible person" (as opposed to detecting-but-filtering).
    print("[YOLO-DEBUG]")
    print(f"person_candidates={_pretrack_count if _pretrack_count is not None else person_count}")
    print(f"best_person_conf={_best_conf if _best_conf is not None else 'n/a'}")
    print(f"final_person_count={person_count}")

    # ByteTrack visibility: _pretrack_count is exactly what this cycle
    # handed to the tracker (detection/detector.py's
    # _record_pretrack_detections observes predictor.results BEFORE
    # ByteTrack's own callback replaces them with only the
    # confirmed/kept subset); person_count is what the tracker actually
    # kept. A gap between the two means YOLO found a person but
    # ByteTrack didn't confirm/keep a track for it THIS cycle — a
    # different failure mode than YOLO returning zero candidates.
    print(
        f"[BYTETRACK-DEBUG] yolo_person_count={_pretrack_count if _pretrack_count is not None else 'n/a'} "
        f"bytetrack_input_count={_pretrack_count if _pretrack_count is not None else 'n/a'} "
        f"confirmed_track_count={person_count}"
    )

    # ---------------- Short-Term Person Detection Persistence ----------------
    now_wall = time.time()
    with _detection_cache_lock:
        cache = _detection_cache.setdefault(tracking_key, {})

        if person_boxes_drawn:
            cache["person"] = {"items": person_boxes_drawn, "time": now_wall}
        else:
            cached_person = cache.get("person")

    if not person_boxes_drawn and cached_person and (now_wall - cached_person["time"]) <= PERSISTENCE_WINDOW_SECONDS:
        for (bx1, by1, bx2, by2, conf, track_id) in cached_person["items"]:
            label = f"person id={track_id} {conf:.2f}" if track_id is not None else f"person {conf:.2f}"
            cv2.rectangle(annotated_frame, (bx1, by1), (bx2, by2), (0, 255, 0), 2)
            cv2.putText(
                annotated_frame,
                label,
                (bx1, max(0, by1 - 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (0, 255, 0),
                2
            )
        _log(f"Person detection persisted from last known ({_ms(now_wall - cached_person['time'])}ms ago)")

    # ---------------- Short-Term Vehicle/Animal Detection Persistence ----------------
    # Same purely-visual redraw as person persistence above — bridges a
    # single missed YOLO cycle so a car/dog box doesn't flicker. Never
    # re-records an event (record_detection only fires from a fresh
    # detection in the YOLO block).
    with _detection_cache_lock:
        cache = _detection_cache.setdefault(tracking_key, {})

        if object_boxes_drawn:
            cache["objects"] = {"items": object_boxes_drawn, "time": now_wall}
        else:
            cached_objects = cache.get("objects")

    if not object_boxes_drawn and cached_objects and (now_wall - cached_objects["time"]) <= PERSISTENCE_WINDOW_SECONDS:
        for (bx1, by1, bx2, by2, obj_label, color) in cached_objects["items"]:
            cv2.rectangle(annotated_frame, (bx1, by1), (bx2, by2), color, 2)
            cv2.putText(
                annotated_frame,
                obj_label,
                (bx1, max(0, by1 - 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                color,
                2
            )
        _log(f"Vehicle/animal detection persisted from last known ({_ms(now_wall - cached_objects['time'])}ms ago)")

    # ai_config was already fetched once, near the top of this function
    # (it also gates the YOLO class list above and the fire pass below).

    if not ai_config["face_recognition_enabled"]:
        _log("Face Recognition disabled for this customer — pipeline stops here")

    # ---------------- Face Detection (Smart Gate) ----------------
    # AI Performance Optimization: the entire InsightFace pass (5 ONNX
    # model forward passes per detected face — by far the most expensive
    # part of this pipeline) is still skipped for a genuinely empty
    # scene — that CPU saving is unchanged. What changed: a single missed
    # YOLO detection no longer skips it by itself. See
    # FACE_DETECTION_GRACE_SECONDS above for the full reasoning.
    faces = []
    t0 = time.perf_counter()

    now_wall_face_gate = time.time()
    with _face_gate_lock:
        last_seen = _face_gate_last_seen.get(tracking_key)

    within_grace_period = (
        last_seen is not None and (now_wall_face_gate - last_seen) <= FACE_DETECTION_GRACE_SECONDS
    )
    should_run_face_detection = person_count > 0 or within_grace_period

    if ai_config["face_recognition_enabled"] and should_run_face_detection:
        try:
            faces = detect_faces(ai_frame)

            # Map every detection back to full-resolution coordinates ONCE,
            # here — mutating face.bbox/face.kps in place means every
            # consumer below (quality assessment, cropping, tracking,
            # overlay drawing) keeps using `frame`-space coordinates
            # exactly as before, with zero further changes needed. Face
            # crops therefore still come from the full-resolution frame
            # (best quality for saved unknown-person images and quality
            # metrics); only the detection/embedding pass itself ran
            # against the smaller ai_frame.
            if ai_scale != 1.0:
                for f in faces:
                    f.bbox = f.bbox / ai_scale
                    if getattr(f, "kps", None) is not None:
                        f.kps = f.kps / ai_scale

            if faces:
                _log(f"Face detected: {len(faces)}")
            elif person_count == 0:
                _log(f"No person this cycle, but within {FACE_DETECTION_GRACE_SECONDS}s grace window "
                     f"({_ms(now_wall_face_gate - last_seen)}ms since last seen) — face detection still ran, found none")
            else:
                _log("No face detected")
        except Exception as e:
            log_exception(e, "Face detection")
            _log("Face detection failed — see [ERROR] above")
            faces = []
    elif ai_config["face_recognition_enabled"]:
        _log("No person or face seen recently — grace window expired, skipping face detection entirely")

    # Refresh the "last seen" clock whenever EITHER signal fired this
    # cycle — either one extends the grace window for the NEXT cycle.
    if person_count > 0 or faces:
        with _face_gate_lock:
            _face_gate_last_seen[tracking_key] = now_wall_face_gate

    timings["Face Detection"] = _ms(time.perf_counter() - t0)
    _aidbg(f"Face detection count = {len(faces)}")
    _camlog(camera_id, f"FACES: {len(faces)}")

    # Decided ONCE for this whole frame — every unrecognized face in it is
    # judged against the same cooldown clock, so several different brand
    # -new unknown people appearing at the same time are all still saved,
    # instead of the first one's save wrongly blocking the rest (see
    # face/unknown_manager.py).
    frame_time = time.time()
    new_unknown_save_allowed = is_new_unknown_save_allowed(customer_id, frame_time)
    any_new_unknown_saved = False

    timings["Face Quality"] = 0.0
    timings["Embedding Generation"] = 0.0
    timings["Recognition"] = 0.0
    timings["Consensus"] = 0.0
    timings["Attendance"] = 0.0

    # ---------------- Face Recognition ----------------
    faces_drawn_this_cycle = []

    for face in faces:

        x1, y1, x2, y2 = face.bbox.astype(int)

        # Safe Crop
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(frame.shape[1], x2)
        y2 = min(frame.shape[0], y2)

        face_crop = frame[y1:y2, x1:x2]

        if face_crop.size == 0:
            _log("Face crop failed (empty crop region)")
            continue

        _log(f"Face crop created ({x2 - x1}x{y2 - y1})")

        # ---------------- Face Quality (informational only) ----------------
        # Critical Fix: quality (blur/small size/angle/brightness) must
        # NEVER block Registered Person recognition/attendance or Unknown
        # Person saving — the only two valid rejection reasons are "no
        # face detected" (faces=[] above already handles that — this loop
        # never runs) and "embedding cannot be generated" (checked right
        # below). Quality is still measured and logged/drawn so the
        # operator can see it, but it no longer gates anything downstream.
        t0 = time.perf_counter()

        if ai_config["face_quality_enabled"]:
            quality_ok, quality_reason, _metrics = assess_face_quality(frame, face, customer_id)
        else:
            quality_ok, quality_reason, _metrics = True, "", {}

        timings["Face Quality"] += _ms(time.perf_counter() - t0)

        if not quality_ok:
            _log(f"Quality low ({quality_reason}) — not rejecting, recognition still runs")
        else:
            _log("Quality passed")
            _log(f"Quality score: {_metrics.get('quality_score', 'n/a')}")

        # ---------------- Embedding Gate ----------------
        # Embedding Generation isn't a separate model call — InsightFace's
        # single detect_faces()/app.get() pass (timed under "Face
        # Detection" above) already computes face.embedding for every
        # detected face in the same forward pass. Timed here as ~0ms on
        # purpose: it documents that fact rather than re-running anything.
        # This is the one gate that's still allowed to reject a face: if
        # no embedding came out of that pass, there is nothing to
        # recognize or save against, for either a registered or an
        # unknown person.
        t0 = time.perf_counter()

        if face.embedding is None or len(face.embedding) == 0:
            timings["Embedding Generation"] += _ms(time.perf_counter() - t0)
            _log("Embedding generation failed — skipping face (no embedding to recognize or save)")
            continue

        embedding_dim = len(face.embedding)
        timings["Embedding Generation"] += _ms(time.perf_counter() - t0)
        _log(f"Embedding generated: dim={embedding_dim}")

        # Registered Person Detection OFF: never compare this face against
        # the registered-persons database at all — every face is then
        # handled purely through the Unknown Person Detection path below,
        # since without recognition there's no way to know it's actually
        # a registered person.
        t0 = time.perf_counter()

        if ai_config["registered_detection_enabled"]:

            # "Do not repeatedly recognize the same face" / "recognition
            # should happen only when required": if this bbox already
            # matches a track this SAME physical face already got
            # CONFIRMED on, reuse that identity directly instead of
            # paying for another cosine-similarity comparison pass — the
            # question "who is this" was already answered and nothing
            # about re-asking it every single processed frame makes the
            # answer more reliable. A track that's aged out (person left
            # frame) or never confirmed always falls through to a real
            # recognize() call. tracking_enabled=False disables only this
            # shortcut — the multi-frame consensus state machine below
            # always stays on regardless, since that's a reliability
            # guarantee, not a performance knob.
            existing_track = (
                peek_track(tracking_key, (x1, y1, x2, y2), face.embedding) if ai_config["tracking_enabled"] else None
            )

            if existing_track is not None and existing_track["status"] == "confirmed":
                name = existing_track["confirmed_name"]
                score = existing_track["last_score"]
                _log(f"Skipping re-recognition — track#{existing_track['track_id']} already confirmed as {name}")
            else:
                if len(get_database(customer_id)) == 0:
                    _log("Recognition cache empty (no registered persons loaded for this customer)")

                name, score = recognize(face, customer_id)
                _log(f"Similarity score: {score:.2f}")

                if name != "Unknown":
                    _log(f"Matched: {name}")
                else:
                    _log("Recognition threshold too high / no match")
        else:
            name, score = "Unknown", 0.0
            _log("Registered Person Detection disabled — skipping recognition")

        timings["Recognition"] += _ms(time.perf_counter() - t0)

        if name != "Unknown":

            # ---------------- Registered Person: Multi-Frame Verification ----------------
            # UNCHANGED — a single frame's recognition never directly
            # drives attendance; the same identity has to hold across
            # several recent frames of the same physical face first. See
            # face/track_verifier.py, which prints its own
            # "[CONSENSUS] ... progress=x/y" line per attempt. This path
            # only ever runs for an actual registered-person match now —
            # Unknown faces no longer feed votes into it at all (see the
            # else branch below).
            t0 = time.perf_counter()
            decision, confirmed_name = update_track(tracking_key, (x1, y1, x2, y2), name, score, face.embedding)
            timings["Consensus"] += _ms(time.perf_counter() - t0)

            if decision == "confirmed":

                _log(f"Recognition confirmed: {confirmed_name}")

                if ai_config["attendance_enabled"]:

                    t0 = time.perf_counter()
                    saved = mark_attendance(confirmed_name, customer_id, camera_id=camera_id)
                    timings["Attendance"] += _ms(time.perf_counter() - t0)

                    if saved:
                        _log("Attendance saved")
                        _log("Dashboard updated (MySQL committed — Registered/Attendance Today/Live Attendance/Activity Logs reflect this on next read)")
                        _camlog(camera_id, f"DETECTION EVENT CREATED (type=ATTENDANCE, name={confirmed_name})")
                    else:
                        _log("Attendance skipped (duplicate within cooldown window, or person no longer registered)")
                else:
                    _log("Attendance skipped (Attendance Tracking disabled)")

                color = (0, 255, 0)
                display_name = confirmed_name

            else:
                # "pending" — still gathering evidence across frames,
                # commit nothing yet. face/track_verifier.py already
                # printed the detailed "[CONSENSUS] ... progress=x/y"
                # line for this vote.
                _log(f"Consensus progress: pending ({decision})")
                color = (0, 255, 255)
                display_name = f"{name}?"

        else:

            # ---------------- Unknown Person: single-attempt, no consensus ----------------
            # Critical Fix (simplification): an unrecognized face is no
            # longer put through the 3-frame consensus tracker at all —
            # the moment recognition comes back below the recognition
            # threshold, it's classified Unknown and save_unknown() is
            # tried immediately, once, this frame. save_unknown() itself
            # (face/unknown_manager.py) is what decides new-vs-duplicate,
            # by comparing this embedding against every already-saved
            # unknown person for this customer — that duplicate check,
            # not multi-frame voting, is what stops the same physical
            # unknown person from spawning a new record every frame they
            # stay in view.
            _log("UNKNOWN DETECTED")
            _log(f"Similarity Score: {score:.4f}")

            if not ai_config["unknown_detection_enabled"]:
                _log("Unknown save skipped (Unknown Person Detection disabled)")
                continue

            saved = False

            if ai_config["save_unknown_persons"]:

                t0 = time.perf_counter()

                # Saved-image annotation only: draw the exact same red box
                # + "Unknown (score)" label the live stream draws for this
                # detection (see the shared cv2.rectangle/putText block
                # below) onto a private copy of the frame, so the persisted
                # Unknown images match what was on screen. Built from
                # `frame` (never `annotated_frame`) and only used for the
                # two images handed to save_unknown() below — detection,
                # recognition, the embedding already computed above, and
                # the live annotated_frame drawn later are untouched.
                unknown_frame_for_save = frame.copy()
                cv2.rectangle(unknown_frame_for_save, (x1, y1), (x2, y2), (0, 0, 255), 2)
                cv2.putText(
                    unknown_frame_for_save,
                    f"Unknown ({score:.2f})",
                    (x1, y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 0, 255),
                    2
                )

                # Pad the saved face crop a few pixels beyond the bbox so
                # the box's own border (drawn ON the bbox edge above)
                # stays visible in the crop instead of being sliced off by
                # an exact-edge crop.
                pad = 6
                fx1 = max(0, x1 - pad)
                fy1 = max(0, y1 - pad)
                fx2 = min(unknown_frame_for_save.shape[1], x2 + pad)
                fy2 = min(unknown_frame_for_save.shape[0], y2 + pad)
                face_crop_with_box = unknown_frame_for_save[fy1:fy2, fx1:fx2]

                if face_crop_with_box.size == 0:
                    face_crop_with_box = face_crop

                saved = save_unknown(
                    customer_id,
                    face_crop_with_box,
                    unknown_frame_for_save,
                    face.embedding,
                    allow_new_save=new_unknown_save_allowed,
                    camera_id=camera_id,
                    confidence=score,
                    owner_user_id_fallback=owner_user_id,
                )
                timings["Attendance"] += _ms(time.perf_counter() - t0)

                if saved:
                    _log("Dashboard updated (MySQL committed — Unknown count reflects this on next read)")
                    _camlog(camera_id, "DETECTION EVENT CREATED (type=UNKNOWN_FACE)")
            else:
                _log("Unknown save skipped (Unknown Person Auto Save disabled)")

            any_new_unknown_saved = any_new_unknown_saved or saved

            color = (0, 0, 255)
            display_name = "Unknown"

        cv2.rectangle(
            annotated_frame,
            (x1, y1),
            (x2, y2),
            color,
            2
        )

        cv2.putText(
            annotated_frame,
            f"{display_name} ({score:.2f})",
            (x1, y1 - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            color,
            2
        )

        faces_drawn_this_cycle.append((x1, y1, x2, y2, color, display_name, score))

    if any_new_unknown_saved:
        mark_unknown_batch_saved(customer_id, frame_time)

    # ---------------- Short-Term Face Detection Persistence ----------------
    # Covers BOTH a genuine InsightFace miss and the person_count gate
    # above skipping face detection entirely for this cycle — either way,
    # "no face drawn this cycle" falls back to the same short-lived cache.
    # Never re-runs recognition/attendance/unknown-save: this only redraws
    # the box/name/score/color already committed by a real detection.
    with _detection_cache_lock:
        cache = _detection_cache.setdefault(tracking_key, {})

        if faces_drawn_this_cycle:
            cache["faces"] = {"items": faces_drawn_this_cycle, "time": frame_time}
        else:
            cached_faces = cache.get("faces")

    if not faces_drawn_this_cycle and cached_faces and (frame_time - cached_faces["time"]) <= PERSISTENCE_WINDOW_SECONDS:
        for (fx1, fy1, fx2, fy2, fcolor, fdisplay_name, fscore) in cached_faces["items"]:
            cv2.rectangle(annotated_frame, (fx1, fy1), (fx2, fy2), fcolor, 2)
            cv2.putText(
                annotated_frame,
                f"{fdisplay_name} ({fscore:.2f})",
                (fx1, fy1 - 10),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                fcolor,
                2
            )
        _log(f"Face detection persisted from last known ({_ms(frame_time - cached_faces['time'])}ms ago)")

    # ---------------- Fire / Smoke Detection (separate optional model, reduced cadence) ----------------
    # Runs at most once per FIRE_DETECTION_INTERVAL_SECONDS per camera so
    # its extra CPU cost can't scale with frame rate. Fully isolated in
    # its own try/except — a fire-model failure leaves every overlay
    # already drawn above (person/face/vehicle/animal) untouched, and the
    # rest of the pipeline (which already ran) unaffected. Inactive with
    # zero per-frame cost when no fire model is installed
    # (fire_detector.is_available() short-circuits).
    if ai_config.get("fire_detection_enabled", True) and fire_detector.is_available():
        now_fire = time.time()
        with _fire_gate_lock:
            fire_due = (now_fire - _fire_last_run.get(tracking_key, 0.0)) >= FIRE_DETECTION_INTERVAL_SECONDS
            if fire_due:
                _fire_last_run[tracking_key] = now_fire

        if fire_due:
            try:
                t0 = time.perf_counter()
                fire_hits = fire_detector.detect_fire(ai_frame)
                timings["Fire Detection"] = _ms(time.perf_counter() - t0)

                _camlog(camera_id, f"FIRE/SMOKE: {len(fire_hits)}")

                if fire_hits:
                    labels_present = {h["label"] for h in fire_hits}
                    banner = "FIRE DETECTED" if "fire" in labels_present else "SMOKE DETECTED"
                    scaled_boxes = [tuple(int(v / ai_scale) for v in h["bbox"]) for h in fire_hits]

                    # Draw the banner + boxes NOW so the saved snapshot
                    # carries the same "FIRE DETECTED" evidence overlay a
                    # viewer sees live (the persist-redraw block below
                    # keeps it on screen between checks).
                    _fh, _fw = annotated_frame.shape[:2]
                    cv2.rectangle(annotated_frame, (0, 0), (_fw, 62), (0, 0, 255), -1)
                    cv2.putText(annotated_frame, banner, (20, 45), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3)
                    for (bx1, by1, bx2, by2) in scaled_boxes:
                        cv2.rectangle(annotated_frame, (bx1, by1), (bx2, by2), (0, 0, 255), 3)

                    with _detection_cache_lock:
                        cache = _detection_cache.setdefault(tracking_key, {})
                        cache["fire"] = {"boxes": scaled_boxes, "banner": banner, "time": now_fire}

                    for label in labels_present:
                        best = max(h["conf"] for h in fire_hits if h["label"] == label)
                        event_manager.record_detection(
                            customer_id,
                            event_manager.EVENT_FIRE if label == "fire" else event_manager.EVENT_SMOKE,
                            camera_id=camera_id,
                            owner_user_id=owner_user_id,
                            object_type=label,
                            confidence=best,
                            dedup_bucket=label,
                            snapshot=annotated_frame.copy(),
                        )
                    _log(f"FIRE/SMOKE DETECTED: {sorted(labels_present)} (conf up to {max(h['conf'] for h in fire_hits):.2f})")
            except Exception as e:
                log_exception(e, "Fire/smoke detection")

    # Fire overlay — drawn every frame while a recent positive is still
    # fresh (bridges the gap between reduced-cadence checks so the warning
    # is steady, not flickering). Purely visual, never records an event.
    with _detection_cache_lock:
        cached_fire = _detection_cache.get(tracking_key, {}).get("fire")

    if cached_fire and (time.time() - cached_fire["time"]) <= FIRE_OVERLAY_PERSIST_SECONDS:
        fh, fw = annotated_frame.shape[:2]
        cv2.rectangle(annotated_frame, (0, 0), (fw, 62), (0, 0, 255), -1)
        cv2.putText(
            annotated_frame,
            cached_fire["banner"],
            (20, 45),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.4,
            (255, 255, 255),
            3
        )
        for (bx1, by1, bx2, by2) in cached_fire["boxes"]:
            cv2.rectangle(annotated_frame, (bx1, by1), (bx2, by2), (0, 0, 255), 3)

    # ---------------- Date & Time ----------------
    current_datetime = datetime.datetime.now().strftime(
        "%d-%m-%Y %H:%M:%S"
    )

    cv2.putText(
        annotated_frame,
        current_datetime,
        (10, 30),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 0),
        2
    )

    timings["Total Pipeline Time"] = _ms(time.perf_counter() - pipeline_start)
    print(f"[AI-CYCLE] total_ms={timings['Total Pipeline Time']}")

    if STAGE_TIMING:
        print("[TIMING] " + " | ".join(f"{k}={v}ms" for k, v in timings.items()))

    print("[AI-CYCLE] end")
    _aidbg(
        f"frame processing completed (camera={camera_id} "
        f"persons={person_count} faces={len(faces)} "
        f"objects={len(object_boxes_drawn)} total_ms={timings['Total Pipeline Time']})"
    )

    return annotated_frame
