"""Automatic, one-time AI model pre-warm + an internal readiness gate.

Purpose
-------
Load YOLO (ultralytics/torch process-global cost) and InsightFace
(buffalo_l download + onnxruntime session build — minutes on a cold
machine) ONCE, on a background thread, the moment the backend starts —
so the first camera turned on never pays that cost on the live-view /
request path.

This module does NOT change detection, ByteTrack, face recognition,
thresholds, drawing, dashboard, or RTSP behaviour. It only calls the
existing `detection.detector.warmup()` / `face.face_detector.warmup()`
functions earlier, and lets the camera processor threads wait until
they have finished instead of kicking off their own concurrent cold
load.

Readiness state — get_state() returns one of:
    AI_PREWARMING       a warm-up pass is currently running
    AI_READY            YOLO + InsightFace are loaded in this process
    AI_PREWARM_FAILED   the last pass raised; a retry is allowed
    AI_NOT_STARTED      start_prewarm() has not been called yet
                        (only ever seen for the brief moment between
                        import and the boot sequence calling it)

Concurrency contract
--------------------
- start_prewarm() is idempotent — it never creates a second pre-warm
  thread while one is already running or has already succeeded. A call
  after AI_PREWARM_FAILED starts exactly one fresh retry.
- wait_until_ready() only ever blocks the CALLER (a camera processor
  thread). Nothing here is called from a Flask request handler, so the
  web server / port 5000 is never blocked.
"""

import threading
import time

from error_logging import log_exception

AI_NOT_STARTED = "AI_NOT_STARTED"
AI_PREWARMING = "AI_PREWARMING"
AI_READY = "AI_READY"
AI_PREWARM_FAILED = "AI_PREWARM_FAILED"

# One throwaway key so the boot pass pays YOLO's process-global cost
# (ultralytics/torch import, weight-file parse, ByteTrack registration)
# without holding a model instance that no real camera would ever reuse
# — each camera builds its own per-tracking_key model (ByteTrack
# isolation, see detection/detector.py), which is cheap once the globals
# above are warm.
_PREWARM_YOLO_KEY = "__boot_prewarm__"

_state = AI_NOT_STARTED
_last_error = None
_started_at = None
_completed_at = None

_lock = threading.Lock()
_thread = None
_ready_event = threading.Event()


def get_state():
    """Current readiness state (one of the module-level AI_* constants)."""
    with _lock:
        return _state


def get_status():
    """Full internal snapshot — state, last error string, and timings.
    Read-only; safe to call from anywhere (no model work happens here)."""
    with _lock:
        return {
            "state": _state,
            "ready": _ready_event.is_set(),
            "last_error": _last_error,
            "started_at": _started_at,
            "completed_at": _completed_at,
        }


def get_last_error():
    """repr() of the exception from the last failed pre-warm pass, or
    None. The full traceback is always also sent to the error log via
    error_logging.log_exception when the failure happens."""
    with _lock:
        return _last_error


def is_ready():
    return _ready_event.is_set()


def _run_prewarm():
    global _state, _last_error, _completed_at

    t0 = time.perf_counter()
    try:
        # Heavy imports kept inside the thread (and inside this try) so
        # importing THIS module stays cheap and so an import failure is
        # caught like any other pre-warm failure — never leaving the
        # state stuck at AI_PREWARMING with a dead thread.
        from detection.detector import warmup as warmup_yolo, drop_model as drop_yolo_model
        from face.face_detector import warmup as warmup_face

        # InsightFace first — it is the expensive, process-global one
        # (single cached _app in face/face_detector.py).
        warmup_face()

        # Then YOLO's globals via the throwaway key.
        warmup_yolo(_PREWARM_YOLO_KEY)
        drop_yolo_model(_PREWARM_YOLO_KEY)
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        with _lock:
            _state = AI_PREWARM_FAILED
            _last_error = repr(exc)
            _completed_at = time.time()
        log_exception(exc, "AI boot pre-warm")
        print(
            f"[AI ENGINE] Boot pre-warm FAILED after {elapsed_ms}ms: {exc!r} — "
            f"camera AI will fall back to loading models on first use; "
            f"call start_prewarm() again to retry"
        )
        return

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
    with _lock:
        _state = AI_READY
        _last_error = None
        _completed_at = time.time()
    _ready_event.set()
    print(f"[AI ENGINE] Boot pre-warm complete (YOLO + InsightFace loaded) in {elapsed_ms}ms")


def start_prewarm():
    """Start the one background pre-warm pass. Idempotent:
      - AI_PREWARMING / AI_READY  -> no-op, returns current state
      - AI_NOT_STARTED            -> starts the pass
      - AI_PREWARM_FAILED         -> starts exactly one fresh retry
    Never creates a second live pre-warm thread."""
    global _state, _thread, _started_at

    with _lock:
        if _state in (AI_PREWARMING, AI_READY):
            return _state
        if _thread is not None and _thread.is_alive():
            return _state

        retry = _last_error is not None
        _state = AI_PREWARMING
        _started_at = time.time()
        _thread = threading.Thread(target=_run_prewarm, name="ai-prewarm", daemon=True)
        _thread.start()

    print(f"[AI ENGINE] Boot pre-warm {'retry ' if retry else ''}starting (state={AI_PREWARMING})")
    return AI_PREWARMING


def wait_until_ready(timeout=None):
    """Block the CALLING thread (a camera processor thread — never the
    web server) until the pre-warm has finished.

    Returns True once AI_READY. Returns False on timeout, or if the
    pre-warm has failed — in the failed case it also kicks off one safe
    retry so a camera turned on after a transient failure still recovers
    on its own. The caller is expected to then fall through to its own
    existing warmup() call (which is a no-op if a retry just succeeded,
    or does the load itself as a last resort)."""

    if _ready_event.is_set():
        return True

    # Safety net: make sure a pass is actually running. Normally
    # start_prewarm() was already called at boot; this covers the odd
    # case where a camera worker somehow starts first, and doubles as
    # the AI_PREWARM_FAILED retry trigger. Idempotent — never spawns a
    # second live thread.
    if get_state() in (AI_NOT_STARTED, AI_PREWARM_FAILED):
        start_prewarm()

    if _ready_event.wait(timeout=timeout):
        return True

    if get_state() == AI_PREWARM_FAILED:
        start_prewarm()  # safe retry; caller still falls through this cycle

    return False
