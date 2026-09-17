"""Optional, pluggable Fire / Smoke detection model.

Fire and smoke are NOT COCO classes, so — unlike vehicles/animals, which
the existing yolov8n.pt already covers — this needs its own model. None
ships with the repo. This module is written so the whole feature stays
completely inert (one warning line, nothing else) until a model file is
dropped in:

    Backend/models/fire.pt            (default path)
    FIRE_MODEL_PATH=/some/other.pt    (env override)

Any Ultralytics-loadable YOLO detection model whose class names contain
"fire" / "flame" / "smoke" works — swap or upgrade it by replacing the
file, no code change. Mirrors face/face_detector.py's lazy-load / warmup
/ thread-safety shape; the torch thread caps set at
detection/detector.py import time apply here too (same process).
"""

import os
import threading
import time

import numpy as np

from error_logging import log_exception

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRE_MODEL_PATH = os.environ.get(
    "FIRE_MODEL_PATH", os.path.join(_BACKEND_DIR, "models", "fire.pt")
)

# Detections below this confidence are dropped. Deliberately a bit higher
# than the person threshold (0.35) — a false "FIRE DETECTED" banner is
# far more disruptive than a missed low-confidence frame, and the model
# gets another look ~1.5s later anyway (see FIRE_DETECTION_INTERVAL_SECONDS
# in camera/frame_processor.py).
DEFAULT_CONF = 0.40

# _model states: None = not tried yet; False = tried, unavailable (no
# file / load error) — never retried; a YOLO instance = ready.
_model = None
_model_lock = threading.Lock()
_warned_missing = False


def _load_model():
    global _model, _warned_missing

    if not os.path.isfile(FIRE_MODEL_PATH):
        if not _warned_missing:
            print(
                f"[FIRE] No fire/smoke model at {FIRE_MODEL_PATH} — fire/smoke detection "
                f"is INACTIVE. Drop a YOLO fire model there (or set FIRE_MODEL_PATH) to enable it. "
                f"All other detection is unaffected."
            )
            _warned_missing = True
        _model = False
        return

    try:
        from ultralytics import YOLO

        print(f"[FIRE] Loading fire/smoke model ({FIRE_MODEL_PATH}) — first use...")
        model = YOLO(FIRE_MODEL_PATH)
        print(f"[FIRE] Fire/smoke model ready (classes={getattr(model, 'names', {})})")
        _model = model
    except Exception as e:
        log_exception(e, f"fire_detector model load ({FIRE_MODEL_PATH})")
        _model = False


def _get_model():
    global _model

    if _model is None:
        with _model_lock:
            if _model is None:
                _load_model()

    return _model


def is_available():
    """True only once a model has actually loaded. camera/frame_processor.py
    checks this before every fire pass so a missing/broken model costs
    nothing per frame."""

    return _get_model() not in (None, False)


def warmup():
    """Pays the one-time model-load cost at camera-worker startup instead
    of on a live frame — same reasoning as face_detector.warmup(). No-op
    (and no error) when no model is installed."""

    model = _get_model()

    if model in (None, False):
        return

    try:
        model.predict(np.zeros((64, 64, 3), dtype=np.uint8), verbose=False)
    except Exception as e:
        log_exception(e, "fire_detector.warmup")


def _label_for(raw_name):
    name = (raw_name or "").strip().lower()

    if "smoke" in name:
        return "smoke"
    if "fire" in name or "flame" in name:
        return "fire"

    return None


def detect_fire(frame, conf=DEFAULT_CONF):
    """Returns a list of {"label": "fire"|"smoke", "conf": float,
    "bbox": (x1, y1, x2, y2)}. Empty list when no model is installed, on
    any inference error (logged), or when nothing is found — the caller
    treats all three the same way."""

    model = _get_model()

    if model in (None, False):
        return []

    try:
        results = model.predict(frame, conf=conf, verbose=False)
    except Exception as e:
        log_exception(e, "fire_detector.detect_fire inference")
        return []

    names = getattr(model, "names", {}) or {}
    out = []

    for result in results:
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue

        for box in boxes:
            try:
                cls_id = int(box.cls[0])
                label = _label_for(names.get(cls_id, str(cls_id)))
                if label is None:
                    continue
                x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
                out.append({"label": label, "conf": float(box.conf[0]), "bbox": (x1, y1, x2, y2)})
            except Exception as e:
                log_exception(e, "fire_detector.detect_fire box parse")

    return out
