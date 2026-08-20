import os
import shutil
import threading
import time

import numpy as np
from insightface.app import FaceAnalysis
from insightface.utils import ensure_available

# --- Startup Fix: lazy model load ---
# Constructing FaceAnalysis + calling .prepare() (5-30+ seconds,
# including onnxruntime session setup for every submodel — the "Applied
# providers: ['CPUExecutionProvider']" lines) used to run at IMPORT TIME,
# because `app` used to be built directly at module level. app.py's very
# first import (`from api.routes import api`) pulls this module in
# transitively, LONG before app.run() — so the whole Flask process used
# to block on this before the server ever bound its port, before any of
# app.py's own init_*() calls even ran. Now the model is built once, on
# the FIRST actual call to detect_faces() — which only ever happens
# inside a camera worker's background thread (camera/detection_service.
# py), started after Flask is already listening. Nothing about detection
# itself changed: same model, same allowed_modules, same det_size, same
# return value — only WHEN the constructor runs.
_app = None
_app_lock = threading.Lock()

# --- AI Performance Optimization ---
# buffalo_l ships 5 separate ONNX sub-models (detection, landmark_3d_68,
# landmark_2d_106, genderage, recognition) and by default FaceAnalysis
# runs ALL of them on every detected face — 5 sequential CPU forward
# passes per face, every frame. Audited the entire codebase for actual
# usage of the Face object's attributes: genderage (.gender/.age) and
# landmark_2d_106 (.landmark_2d_106) are not read ANYWHERE in this app —
# only .bbox/.det_score/.kps (from detection), .pose (derived from
# landmark_3d_68, used by face/quality.py and face/recognizer.py for
# angle gating), and .embedding (from recognition) are ever used.
_ALLOWED_MODULES = ["detection", "landmark_3d_68", "recognition"]

# buffalo_l's fixed, versioned release layout (filenames confirmed
# against the actual cached model directory) — needed below because
# insightface.app.FaceAnalysis.__init__ builds a full onnxruntime
# InferenceSession for EVERY .onnx file it finds in the model directory
# BEFORE checking allowed_modules (see insightface/app/face_analysis.py:
# `model = model_zoo.get_model(onnx_file, **kwargs)` runs first, the
# allowed_modules check and `del model` for a rejected one happens
# after). So passing allowed_modules alone does NOT skip constructing
# the 2 unused sessions (genderage, landmark_2d_106) — it only discards
# them once already built, which was still paying their full one-time
# session-construction cost (confirmed live: constructing all 5
# sessions took 153s; the 3 wanted ones alone are the real target).
# There is no cheaper way to learn an onnx file's task ahead of time —
# ModelRouter.get_model() (insightface's own lookup) determines it by
# building the session first, which is exactly the cost being avoided.
_BUFFALO_L_FILE_TASKS = {
    "det_10g.onnx": "detection",
    "1k3d68.onnx": "landmark_3d_68",
    "w600k_r50.onnx": "recognition",
    "2d106det.onnx": "landmark_2d_106",
    "genderage.onnx": "genderage",
}

_INSIGHTFACE_ROOT = os.path.expanduser("~/.insightface")


def _slim_model_dir():
    """Copies only the 3 wanted buffalo_l .onnx files into their own
    directory (once) so FaceAnalysis's own `glob('*.onnx')` never even
    finds the other two — see _BUFFALO_L_FILE_TASKS above for why
    allowed_modules by itself isn't enough. ensure_available() is cheap
    (a directory-exists check, or a one-time download) — it does not
    construct any onnxruntime session, so calling it here adds no
    meaningful cost."""

    full_dir = ensure_available("models", "buffalo_l", root=_INSIGHTFACE_ROOT)
    slim_dir = os.path.join(_INSIGHTFACE_ROOT, "models", "buffalo_l_slim")
    os.makedirs(slim_dir, exist_ok=True)

    for filename, task in _BUFFALO_L_FILE_TASKS.items():
        if task not in _ALLOWED_MODULES:
            continue
        dst = os.path.join(slim_dir, filename)
        if not os.path.exists(dst):
            shutil.copy2(os.path.join(full_dir, filename), dst)

    return slim_dir


def _build_session_options():
    """RTSP Camera 18 intermittent-detection investigation: onnxruntime
    defaults to sizing its own intra-op thread pool to the number of CPU
    cores, PER SESSION — and FaceAnalysis constructs 3 of them (detection,
    landmark_3d_68, recognition), each run sequentially per detected
    face. On this machine's 4 cores, that leaves the RTSP reader thread
    (cap.grab()/cap.retrieve()) starved of real CPU time for however long
    each of those forward passes takes — confirmed live: Face Detection
    alone measured up to 32.5 SECONDS in a single cycle
    ([TIMING] logs), landing exactly inside the same windows RTSP-HEALTH
    logging showed grab()/retrieve() failing at up to an 89% rate and
    the camera being declared dead and reconnected. Capping the thread
    pool below the core count leaves real, guaranteed headroom for the
    reader thread and every other thread on this process. This changes
    ONLY how many OS threads onnxruntime is allowed to use internally —
    the model, its inputs, its outputs, and every recognition/quality
    decision downstream of it are completely unchanged."""

    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    return options


def get_app():
    global _app

    if _app is None:
        with _app_lock:
            if _app is None:  # re-check: another thread may have built it while we waited for the lock
                print("[INIT] Loading InsightFace model (buffalo_l) — first use...")

                _slim_model_dir()

                new_app = FaceAnalysis(
                    name="buffalo_l_slim",
                    root=_INSIGHTFACE_ROOT,
                    providers=["CPUExecutionProvider"],
                    allowed_modules=_ALLOWED_MODULES,
                    sess_options=_build_session_options(),
                )

                new_app.prepare(
                    ctx_id=-1,
                    det_size=(640, 640)
                )

                print("[INIT] InsightFace model ready")
                _app = new_app

    return _app


def warmup():
    """AI Performance Fix: same reasoning as detection/detector.py's
    warmup() — pays InsightFace's one-time model-load/onnxruntime
    session-init cost (the "5-30+ seconds" the comment above already
    documents) ONCE, at camera worker startup, instead of on whichever
    real frame happens to be first through detect_faces() during live
    detection. A tiny dummy frame is enough to trigger get_app()'s full
    lazy construction; its content/size never affect what gets cached."""

    dummy_frame = np.zeros((64, 64, 3), dtype=np.uint8)
    get_app().get(dummy_frame)


def detect_faces(frame):
    t0 = time.perf_counter()
    faces = get_app().get(frame)
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
    print(f"[TIMING] InsightFace app.get(): {elapsed_ms}ms, faces={len(faces)}")
    return faces