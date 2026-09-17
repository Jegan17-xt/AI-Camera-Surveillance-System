"""The AI Detection Engine — a background service independent of the
React frontend and of any HTTP request.

Ownership: this module is the ONLY place that starts, stops, or restarts
a camera's capture+detection thread. Nothing else may reach into
`_camera_streams` directly.

Lifecycle:
  - start_all_enabled_cameras() runs once at backend boot (api/app.py) —
    every camera with detection_enabled=True gets its own worker thread
    immediately, with no frontend request involved.
  - start_camera_worker() is called the moment a camera is added, or
    re-enabled after being disabled.
  - stop_camera_worker() is called when a camera is disabled or deleted.
  - restart_camera_worker() is called when a camera's connection details
    (IP/brand/credentials/etc, i.e. its RTSP URL) are edited.
  - A worker keeps running — reconnecting on its own after a dropped or
    never-established RTSP connection — until one of the three lifecycle
    calls above stops it, or the backend process itself exits. Nobody
    viewing (or not viewing) the Live Camera page has any effect on it;
    camera/stream.py only ever READS a worker's current state/latest
    frame for the MJPEG endpoint, it never starts or stops one.

--- Critical Production Fix: smooth IP camera streaming ---
Each camera now runs TWO cooperating threads instead of one:
  - _camera_reader_loop: does NOTHING except cap.read() as fast as the
    RTSP source delivers frames, overwrite entry["raw_frame"] with
    whatever just arrived, AND publish the live JPEG (entry["latest_
    jpeg"]) that camera/stream.py serves. No AI, no queueing, nothing
    that can ever make it fall behind the source — which is exactly
    what a single combined read+AI loop could not guarantee (a slow
    process_frame() call left frames piling up in FFmpeg's own internal
    buffer, so every read returned an increasingly stale, queued frame —
    the "slideshow" symptom — until the RTSP source itself dropped the
    now-unresponsive client, producing the "frame read failed,
    reconnecting" cycle in the logs).
  - _camera_processor_loop: runs AI at PROCESSING_FPS_CAP (unchanged),
    always against whichever raw frame is CURRENTLY newest — it never
    queues, so a slow AI pass simply skips whatever arrived in the
    meantime instead of working through a backlog. It ONLY updates
    entry["last_annotated_frame"] when a pass finishes; it does not
    publish the live JPEG itself.

Why the live JPEG moved from the processor thread to the reader thread:
process_frame() is a synchronous, CPU-bound call — on real hardware it
can take anywhere from tens of milliseconds to multiple seconds per
frame (worse still on its very first call ever, which pays a one-time,
possibly minutes-long model-load cost). As long as THAT call was also
the thing responsible for encoding and publishing the live frame, the
entire live view sat frozen for its full duration, every single AI
cycle — not just at startup. The reader thread never blocks on AI at
all, so publishing from there guarantees the live view keeps moving at
DISPLAY_FPS_CAP regardless of how slow (or far behind) AI is running.
The reader thread prefers the most recent AI-annotated frame when one
exists AND is fresh (produced within ANNOTATION_STALE_SECONDS of now)
— stale annotations (AI meaningfully behind the live edge) are dropped
in favor of the plain raw frame rather than freezing the view on an
old, no-longer-relevant overlay.

Both threads read/write only entry["raw_frame"]/entry["last_annotated_
frame"] (guarded by entry["lock"]) — there is no queue anywhere in this
module, by design.
"""

import os
import platform
import threading
import time

# Security fix — see api/cameras.py's identical line for why: suppresses
# FFmpeg's own native logging so a failing RTSP handshake can never
# print a credential-bearing connection string straight to this
# process's stderr. setdefault() is idempotent — harmless if api/app.py
# (or api/cameras.py) already set this earlier in the same process.
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")

import cv2
from sqlalchemy import select

from db import get_session
from auth.models import Camera
from camera.frame_processor import process_frame, compute_tracking_key, drop_tracking_state
from camera import ai_prewarm
from detection.detector import warmup as warmup_yolo, drop_model as drop_yolo_model
from detection.fire_detector import warmup as warmup_fire
from face.face_detector import warmup as warmup_face
from face.track_verifier import drop_tracks
from error_logging import log_exception

CAMERA_OPEN_TIMEOUT_SECONDS = 8
# Deliberately much shorter than CAMERA_OPEN_TIMEOUT_SECONDS. This was
# previously the SAME 8s value as the open timeout, which meant a single
# transient network stall on an already-connected camera could block
# cap.grab()/cap.retrieve() — and therefore the live view, since the
# reader thread has nothing else to report during that call — for up to
# 8 full seconds. That is exactly the user-visible "freezes and gets
# stuck" symptom. Reads should be fast and frequent once connected; a
# stall this long already means real trouble, so failing the read
# quickly (and letting the grab()-retry loop or the NO_FRAME_TIMEOUT_
# SECONDS reconnect below take over) turns an 8s freeze into a brief,
# barely-perceptible skipped frame instead.
CAMERA_READ_TIMEOUT_SECONDS = 3
RECONNECT_DELAY_SECONDS = 10  # base delay for the bounded exponential backoff below (first repeated-failure wait)
NO_FRAME_TIMEOUT_SECONDS = 15  # reconnect only once this long has passed with NOT ONE successful frame decoded — a real-time budget, not a failure count, so a CPU spike or a burst of slow/delayed cap.read() calls (which can rack up many "failures" in well under a second) never trips a reconnect on its own; only an actual dead connection does

# --- Camera Runtime Fix: bounded/exponential reconnect backoff ---
# Root cause of "camera goes LIVE, then OFFLINE, then LIVE again,
# repeatedly, forever": a source that OPENS successfully (TCP/RTSP
# handshake fine) but can't SUSTAIN a stream — flaky network, an
# overloaded DVR, a marginal WiFi link — used to be retried with either
# ZERO delay (a NO_FRAME_TIMEOUT-triggered reconnect that succeeds in
# reopening) or a flat RECONNECT_DELAY_SECONDS (an outright open
# failure), forever, with no growing backoff either way. Each cycle
# still took the full NO_FRAME_TIMEOUT_SECONDS to detect, so it was
# never a tight/busy loop — but a persistently unstable source would
# cycle online/offline/online every ~15s indefinitely, which is exactly
# the reported symptom. STABLE_CONNECTION_SECONDS is the dividing line:
# a connection that stayed up at least this long before dropping is
# judged a genuine one-off blip — the very next reconnect attempt stays
# instant (the existing, already-verified "Continuous On/Off
# Investigation" behavior, preserved exactly for that case). Anything
# that drops faster than that is judged a repeated/unstable failure and
# gets an increasing delay, capped at MAX_RECONNECT_DELAY_SECONDS so a
# genuinely dead camera is never hammered but also never left retrying
# so slowly it looks abandoned.
MAX_RECONNECT_DELAY_SECONDS = 60
STABLE_CONNECTION_SECONDS = 30


def _boost_reader_thread_priority():
    """Root-cause fix for the '720p (and 1080p) detection stalls / camera
    flaps offline' regression: face/face_detector.py's own comment already
    documented that InsightFace's per-cycle CPU cost can starve this
    reader thread badly enough to fail cap.grab()/cap.retrieve() outright
    (not just run slow) — that's why onnxruntime's intra_op_num_threads is
    already capped at 2. Confirmed LIVE against real camera 18 that the
    cap alone is not enough once the source frame is 1280x720+ (720p and
    1080p — 1080p downscales to the same ~1280px cap before AI, so both
    tiers hit this): InsightFace's per-FACE alignment/embedding cost scales
    with each detected face's actual pixel size in the source frame, which
    is ~4x larger at 1280x720 than at 480p's 640x360 for the same
    real-world people — measured live: a single `app.get()` call took
    11.8s (peak 32.5s per the existing comment) with only 2 worker threads
    computing that whole time, leaving 2 of this 4-core box's cores
    theoretically free — yet cap.grab() still failed at up to an 89% rate
    during that exact window (verified: an isolated grab()-only loop
    against the same live RTSP source, with zero AI running, had a 0%
    failure rate over the same duration) — i.e. this is a real OS
    thread-scheduling starvation problem, not a raw CPU-cycles-available
    problem: this thread's own frequent, short cap.grab()/cap.retrieve()
    calls were losing the scheduling race against the AI thread's few,
    long, back-to-back native (GIL-released) computations.
    THE FIX: raise this thread's own OS scheduling priority one notch
    above normal so the OS scheduler favors it whenever both threads want
    a core at the same instant — this changes nothing about detection
    itself (same models, same thresholds, same accuracy, same frame
    content); it only makes the OS more consistently hand this
    short/frequent I/O-bound thread a CPU slice instead of letting a
    long-running CPU-bound thread monopolize scheduling turns. Windows
    only (via ctypes; no pywin32 dependency needed) — this deployment's
    observed platform. Best-effort and never fatal: any failure here
    (unsupported platform, restricted permissions) is silently ignored,
    the reader thread runs exactly as before, just without the priority
    boost."""

    if platform.system() != "Windows":
        return

    try:
        import ctypes
        from ctypes import wintypes

        # Explicit argtypes/restype are NOT optional here — without them,
        # ctypes marshals GetCurrentThread()'s 64-bit pseudo-handle
        # (0xFFFFFFFFFFFFFFFE) through its default 32-bit-int guess,
        # silently truncating it. The call then still "succeeds" with no
        # exception raised, but SetThreadPriority actually fails (verified
        # live: returns 0 / GetLastError without this fix, returns 1 with
        # it) — a silent no-op that looks identical to success from a bare
        # try/except, which is exactly the kind of failure this whole
        # investigation was about avoiding.
        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentThread.restype = wintypes.HANDLE
        kernel32.SetThreadPriority.argtypes = [wintypes.HANDLE, ctypes.c_int]
        kernel32.SetThreadPriority.restype = wintypes.BOOL

        THREAD_PRIORITY_ABOVE_NORMAL = 1
        handle = kernel32.GetCurrentThread()
        ok = kernel32.SetThreadPriority(handle, THREAD_PRIORITY_ABOVE_NORMAL)
        print(f"[STREAM] reader thread priority boost {'applied' if ok else 'FAILED (non-fatal)'}")
    except Exception:
        pass


def _camlog(camera_id, msg):
    """Uniform `[CAMERA <id>] <MESSAGE>` line — the exact per-camera log
    shape requested for the pipeline audit (RTSP CONNECTED / FRAME
    RECEIVED / AI PROCESSING / PERSONS / FACES / OBJECTS / FIRE-SMOKE /
    DETECTION EVENT CREATED / RTSP DISCONNECTED / RECONNECTING /
    RECONNECTED), printed ALONGSIDE the existing [CAMERA_CONNECTED] /
    [RTSP-HEALTH] / [AI DEBUG] / [PIPELINE] lines rather than replacing
    them — those already carry detail (attempt counts, timings, reasons)
    this shorter line intentionally leaves out. Skipped for the
    local-webcam pseudo-camera (camera_id is None there), which was never
    part of this per-added-camera logging requirement."""

    if camera_id is not None:
        print(f"[CAMERA {camera_id}] {msg}")


def _reconnect_backoff_seconds(consecutive_failures):
    """10s, 20s, 40s, 60s, 60s, ... — consecutive_failures is how many
    reconnect cycles IN A ROW failed to reach a stable connection (reset
    to 0 the moment one does — see STABLE_CONNECTION_SECONDS above)."""

    return min(RECONNECT_DELAY_SECONDS * (2 ** max(consecutive_failures - 1, 0)), MAX_RECONNECT_DELAY_SECONDS)

# How often process_frame() (face detection + recognition) actually runs,
# per camera. RTSP delivers frames much faster than this (typically
# 15-30fps) — the reader thread drains every one of them regardless (see
# module docstring) — but running the shared, CPU-bound InsightFace model
# on EVERY frame leaves no CPU headroom for anything else that touches
# the same model (another camera's thread, a registration upload),
# causing those to slow down badly under real load. 5fps is far more
# than track_verifier's multi-frame consensus needs while leaving real
# CPU headroom.
PROCESSING_FPS_CAP = 5

# How long a just-started camera processor thread will wait for the
# shared boot pre-warm (camera/ai_prewarm.py) to reach AI_READY before
# giving up and doing the model load itself as a last resort. Sized to
# comfortably cover a cold first-ever InsightFace load (buffalo_l
# download + onnxruntime session build — minutes on a slow machine/
# connection); if it is exceeded, the fallback path below still works,
# it just re-pays what the pre-warm was supposed to have absorbed. Only
# ever blocks THIS processor thread — the reader thread (live view) and
# the web server are never affected.
AI_PREWARM_WAIT_SECONDS = 300

# The live MJPEG feed's own frame rate is NOT tied to PROCESSING_FPS_CAP
# — that would recreate the exact slideshow problem this fix addresses.
# Every frame the reader thread pulls gets re-encoded and shown, capped
# only by DISPLAY_FPS_CAP to bound CPU spent on JPEG encoding.
DISPLAY_FPS_CAP = 20

# An AI-annotated frame is only shown once it's computed — by the time it
# is, real time has already moved on. On hardware where AI keeps up
# (roughly PROCESSING_FPS_CAP), that gap is small enough to be invisible.
# On hardware where it can't, showing that same annotation for every raw
# frame in between is indistinguishable from a frozen live view — but the
# cutoff for "still relevant" has to be measured in real SECONDS, not raw
# frame count: a frame-count cutoff (e.g. "20 raw frames old") converts
# to a FIXED time budget only when raw capture rate is fixed at
# DISPLAY_FPS_CAP, and on real hardware where one AI pass alone can take
# longer than that whole budget, every annotation is judged stale the
# instant it's produced — ALL overlays silently disappear forever, not
# just the slow ones. Kept generous (comfortably above the slowest
# measured real pass) so a genuinely slow-but-still-working AI thread
# keeps showing its results; still bounded so a truly stuck/dead one (an
# actual bug, or a customer lock held far longer than any single
# inference should ever take) can't paint an arbitrarily ancient frame as
# if it were live forever.
#
# Continuous Bounding Box Investigation: was 5.0 — measured live against
# a real RTSP camera with several people in frame (each face pays its own
# sequential InsightFace pass), full AI-CYCLE total_ms ranged 4.4s to
# 46.3s. At the old 5.0s ceiling, the reader fell back to the plain raw
# frame (box gone) for nearly the ENTIRE duration of almost every cycle,
# only for the box to reappear the instant the next one finally
# completed — the exact "disappears and reappears" symptom reported, and
# not a YOLO/ByteTrack detection failure at all (the same live session
# showed zero cycles where a person went undetected once a cycle actually
# finished). First raised to 60.0, but live re-verification of that very
# fix (same busy scene, 34 more cycles, still zero missed-detection
# cycles) recorded a gap BETWEEN cycles of 56.4s — within 4s of that
# ceiling. 120.0 gives real margin over that observed worst case instead
# of sitting right at its edge; the camera reader itself is completely
# unaffected either way, it never waits on this, only which frame it
# currently prefers to show.
ANNOTATION_STALE_SECONDS = 120.0

# OpenCV's FFmpeg backend reads this once, at import time, for every
# capture it opens — must be set before the first cv2.VideoCapture(...).
# rtsp_transport=tcp: real IP cameras dropping UDP packets under normal
# network jitter is exactly what shows up as "H264 decode errors" in the
# logs — TCP re-transmits instead of corrupting the frame. nobuffer +
# low_delay minimize FFmpeg's own internal buffering/latency, and
# reorder_queue_size=0 stops it from holding frames back waiting to
# reorder packets that TCP has already ordered.
#
# RTSP Stability Investigation: max_delay was 500000 (500ms) — this is
# how long FFmpeg's demuxer waits, DURING the reader thread's own
# synchronous cap.grab()/cap.retrieve() call, for the rest of a frame's
# data before giving up on it. cap.grab()/retrieve() only run when this
# thread actually gets scheduled — on this machine, under real AI-thread
# CPU load, that data can already be sitting correctly in the OS socket
# buffer while our own thread simply hasn't been scheduled promptly
# enough to finish parsing it inside a 500ms window. FFmpeg then treats
# an otherwise-complete frame as "too late" and hands the decoder a
# truncated NAL unit — matching the exact "nal size exceeds length" /
# "non-existing PPS referenced" errors seen live on camera 18, which then
# cascade into grab()/retrieve() failures and, after 15s of that,
# NO_FRAME_TIMEOUT_SECONDS reconnects. Raised to 2000000 (2s) — real
# margin over reader-thread scheduling jitter, while staying well under
# both CAMERA_READ_TIMEOUT_SECONDS (3s per read) and
# NO_FRAME_TIMEOUT_SECONDS (15s, the actual reconnect trigger), so it can
# never itself cause a longer stall than either already tolerates.
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|max_delay;2000000|reorder_queue_size;0",
)

# RTSP Stability Investigation: OpenCV's own internal thread pool (used by
# cv2.imencode() — called every published frame, right in the reader
# loop below, at up to DISPLAY_FPS_CAP times/sec on this camera's full
# 2560x1440 resolution) defaults to one thread PER LOGICAL CORE — 4 on
# this machine, confirmed live (cv2.getNumThreads() == 4 before this
# change). InsightFace's onnxruntime sessions were already capped
# (face/face_detector.py, intra_op_num_threads=2) after a prior
# investigation found them starving this same reader thread badly enough
# to cause "no frame for 15s" reconnects — but OpenCV's own thread pool,
# used directly inside the reader thread's own per-frame encode call,
# was never included in that cap. On this 4-core machine, an imencode()
# call alone can therefore briefly claim every core at once, delaying the
# very next cap.grab()/cap.retrieve() call on the SAME thread — exactly
# the kind of scheduling gap that turns a momentary stall into a real,
# sustained frame-loss episode. Capping it to 2 (matching the InsightFace
# cap already in place) leaves real headroom for the reader thread's own
# grab()/retrieve() calls and every other thread on this process, at the
# cost of a slightly slower (still well under one frame interval)
# JPEG encode — it changes nothing about detection, recognition, or how
# many frames are captured/processed per second.
cv2.setNumThreads(2)

_camera_streams = {}  # camera_id -> worker state dict (see _new_camera_entry)
_camera_streams_lock = threading.Lock()  # guards the _camera_streams dict itself

# --- Camera Quality Hot-Swap: per-camera restart serialization ---
# restart_camera_worker() (see below) now runs the NEW-resolution worker
# side-by-side with the OLD one for a brief overlap instead of stopping
# the old one first — guards against the two-quality-changes-in-a-row
# race (Admin clicks 480p->720p, then 720p->1080p again a moment later,
# before the first swap has finished): without a lock here, both calls
# would independently read _camera_streams[camera_id] as the same "old"
# entry, each start their own replacement, and race to overwrite the
# dict entry/stop the "old" worker — possibly leaving an orphaned
# worker thread running forever with no reference left to stop it. One
# lock per camera_id (created lazily, never removed — cheap, and camera_
# ids are never reused) makes a second restart simply WAIT for the first
# swap to finish, then run its own swap against whatever is current at
# that point — always ends in the correct final state, never a race.
_restart_locks = {}  # camera_id -> threading.Lock()
_restart_locks_lock = threading.Lock()  # guards the _restart_locks dict itself


def _get_restart_lock(camera_id):
    with _restart_locks_lock:
        lock = _restart_locks.get(camera_id)
        if lock is None:
            lock = threading.Lock()
            _restart_locks[camera_id] = lock
        return lock

# --- CPU Concurrency Fix: per-customer lock narrowed to its actual
# critical section ---
# This used to be one big lock held around the ENTIRE process_frame()
# call below (YOLO detection + InsightFace recognition + attendance/
# unknown-person DB writes), so two cameras belonging to the same
# customer could never run AI inference at the same time even though
# inference itself has no shared-state race — only attendance.py's
# mark_attendance() and face/unknown_manager.py's save_unknown() (both
# do a check-then-write against MySQL with no locking of their own) ever
# needed serializing. The lock now lives in camera/processing_locks.py
# and is acquired only inside those two functions, around just their
# check-then-write section — this loop calls process_frame() directly,
# with no lock at all, so a customer's cameras can run YOLO/InsightFace
# fully concurrently. Detection/tracking/recognition output is
# unchanged; only how many cameras can run inference at once changed.


def _new_camera_entry(customer_id, source):
    return {
        "lock": threading.Lock(),
        "reader_thread": None,
        "processor_thread": None,
        "running": False,
        "online": False,           # source currently connected and delivering frames
        "fps": 0.0,                 # raw capture rate — what the live feed actually plays at
        "processing_fps": 0.0,      # AI processing rate — independent of the above
        "raw_frame": None,          # latest decoded frame — ALWAYS overwritten, never queued
        "raw_frame_seq": 0,         # bumped on every new raw frame, so the processor can tell "is there anything new" cheaply
        "raw_frame_time": None,     # wall-clock time the above frame was captured — lets the processor report real "Frame Capture" latency
        "last_annotated_frame": None,  # most recent process_frame() output — set by the processor thread, read by the reader thread; never blocks either one on the other
        "last_annotated_at": None,     # time.time() when that annotation was produced, so the reader thread can tell when it's gone stale (see _camera_reader_loop, ANNOTATION_STALE_SECONDS)
        "latest_jpeg": None,        # what the MJPEG endpoint serves
        "stop_event": threading.Event(),
        # Camera Runtime Fix: explicit per-camera connection state, kept
        # in sync by _camera_reader_loop alongside the existing "online"
        # boolean — "online" answers "is the live view usable right now"
        # (already true), these answer "what stage of the connect/
        # reconnect cycle is this camera in and how healthy has it been
        # recently", for logging/diagnostics.
        "connection_state": "disconnected",  # "connecting" | "connected" | "disconnected"
        "last_frame_success_time": None,     # time.time() of the last successfully decoded frame
        "consecutive_frame_failures": 0,     # grab()/retrieve() failures since the last successful frame
        "reconnect_attempt_count": 0,        # consecutive reconnect cycles that failed to reach a stable connection (see STABLE_CONNECTION_SECONDS)
        "customer_id": customer_id,
        # `source` is either an RTSP URL (str) or a local device index
        # (int, e.g. 0 for the laptop webcam) — `_open_capture` below
        # branches on the type. Everything downstream of this (both
        # threads, process_frame() itself) is identical either way; a
        # local webcam is just another `source` value, not a second
        # pipeline. is_local/pipeline_camera_id/source_label are set by
        # start_camera_worker() right after this entry is created.
        "source": source,
        "is_local": False,
        "pipeline_camera_id": None,
        "source_label": "RTSP",
        # Per-User Data Isolation — this camera's Camera.owner_user_id,
        # set by start_camera_worker() right after this entry is
        # created. Used only by _set_online()'s camera-offline
        # notification trigger below.
        "owner_user_id": None,
        "notified_offline": False,
    }


def _open_capture(source):
    # Security fix (SSRF): re-validated here, immediately before every
    # single connection attempt this worker ever makes — not just once
    # when the camera was saved. A camera row saved before this fix, or
    # one whose hostname's DNS answer changes after being saved, would
    # otherwise have this worker keep reconnecting to it forever with no
    # further check. Deferred import: api.cameras already imports this
    # module (camera.detection_service), so importing api.cameras at
    # module load time here would be circular — importing inside the
    # function instead resolves fine once both modules have finished
    # loading, which is always true by the time a worker thread actually
    # runs.
    if isinstance(source, str):
        from api.cameras import _hostname_from_rtsp_url, _connection_target_allowed
        host = _hostname_from_rtsp_url(source)
        if not host or not _connection_target_allowed(host):
            return None, False

    cap = cv2.VideoCapture()
    cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, CAMERA_OPEN_TIMEOUT_SECONDS * 1000)
    cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, CAMERA_READ_TIMEOUT_SECONDS * 1000)
    # Ask OpenCV itself to keep at most 1 frame internally too, on
    # backends that honor this (in addition to the FFmpeg-level options
    # above) — belt and suspenders against any queued/stale frame.
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if isinstance(source, int):
        # Local device index (the laptop webcam) — CAP_FFMPEG is for
        # network streams and does not open USB/integrated cameras on
        # Windows; DSHOW is the correct backend there, same as the old
        # standalone local-webcam loop this replaces.
        backend = cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_ANY
        opened = cap.open(source, backend)
    else:
        opened = cap.open(source, cv2.CAP_FFMPEG)
    return cap, opened


def _sync_camera_status_to_db(camera_id, entry, online):
    """Keeps the `cameras.status` column — what Camera Management's list
    view and every other DB-backed status read shows — truthful against
    this worker's REAL, live connection state.

    Root-cause fix (Camera Live pipeline audit): before this, `status`
    was written ONLY at add_camera/update_camera/manual "Test Camera"
    time (see api/cameras.py) and then never touched again for the rest
    of that camera's life. A camera that hit a brief RTSP blip and
    reconnected fine 10 seconds later (exactly the case this whole
    reconnect/backoff machinery is designed to ride out invisibly) was
    left showing whatever it showed at the last edit — "Online" forever
    even while genuinely down, or "Offline" forever even after a clean
    reconnect — completely decoupled from the actual pipeline. That is
    the "Live camera becomes OFFLINE automatically [and the UI never
    reflects reality]" symptom at the Camera Management layer (the
    separate /live-camera/status/<id> endpoint used by the Live Camera
    viewer itself already reads this worker's live state directly and
    was never affected).

    Called only on a genuine online<->offline TRANSITION (see the one
    call site in _set_online below) — never per-frame — so this is at
    most a couple of extra UPDATE statements per reconnect cycle, not a
    per-frame cost. Skipped entirely for the local-webcam pseudo-camera
    (no `cameras` table row exists for it). Never raises: a DB hiccup
    here must not take down the reader thread that called it."""

    if entry.get("is_local"):
        return

    try:
        with get_session() as session:
            camera = session.get(Camera, camera_id)
            if camera is not None:
                camera.status = "Online" if online else "Offline"
    except Exception as e:
        log_exception(e, f"camera status DB sync (camera={camera_id})")


def _set_online(camera_id, entry, value):
    """Every write to entry["online"] goes through here now instead of
    a direct assignment, so a genuine online->offline transition (not
    the initial "never yet connected" retries, not a deliberate stop)
    can fire exactly one camera-offline Notification — Per-User Data
    Isolation's Notifications feature — and keep the DB `status` column
    in sync (see _sync_camera_status_to_db above). Detection/streaming
    behavior is completely unchanged; this only observes the same flag
    it always set."""

    with entry["lock"]:
        was_online = entry["online"]
        entry["online"] = value

    if value:
        entry["notified_offline"] = False
        if not was_online:
            _sync_camera_status_to_db(camera_id, entry, True)
        return

    if not was_online:
        return

    _sync_camera_status_to_db(camera_id, entry, False)

    if not entry["stop_event"].is_set() and not entry["notified_offline"]:
        entry["notified_offline"] = True
        try:
            from api.settings import get_settings
            from api.notifications import create_notification

            # Settings are per-account now (see api/settings.py), but this
            # background thread always reads the Company Admin's own copy
            # (entry["customer_id"] is always the tenant/Admin's id, never
            # a regular User's) — unaffected by any individual User's own
            # personal settings.
            if get_settings(entry["customer_id"]).get("notify_camera_offline", True):
                create_notification(
                    entry["customer_id"],
                    entry.get("owner_user_id"),
                    type="camera_offline",
                    message="Camera went offline.",
                    camera_id=camera_id if not entry.get("is_local") else None,
                )
        except Exception as e:
            log_exception(e, f"camera-offline notification (camera={camera_id})")


def _camera_reader_loop(camera_id, entry):
    """The dedicated capture thread. Its only job is to keep
    entry["raw_frame"] as fresh as physically possible — never blocked
    by, or waiting on, AI processing."""

    print(f"[STREAM] Camera {camera_id}: reader thread started")
    _boost_reader_thread_priority()

    # --- RTSP Frame Health tracking (diagnostic only) ---
    # Plain counters, read by nothing else in this codebase — added to
    # answer "is RTSP link health the cause of intermittent detection"
    # with real numbers instead of guessing. Never affects reconnect
    # timing/thresholds themselves (NO_FRAME_TIMEOUT_SECONDS,
    # RECONNECT_DELAY_SECONDS, the grab/retrieve loop) — purely
    # observational counters and print statements layered on top of the
    # existing, unchanged connect/read/reconnect logic below.
    total_successful_reads = 0
    total_failed_reads = 0
    reconnect_count = 0

    # Camera Runtime Fix: drives the bounded exponential backoff (see
    # _reconnect_backoff_seconds) — persists across reconnects for as
    # long as THIS thread runs, reset to 0 whenever a connection proves
    # stable (STABLE_CONNECTION_SECONDS) or whenever a brand-new worker
    # is started (a fresh thread always starts this at 0, so a manual
    # disable/enable or an edited RTSP URL never inherits a stale
    # penalty from before).
    consecutive_reconnect_failures = 0

    while not entry["stop_event"].is_set():

        source = entry["source"]  # re-read every reconnect cycle in case restart_camera_worker() swapped it

        with entry["lock"]:
            entry["connection_state"] = "connecting"
        print(f"[CAMERA_CONNECTING] camera={camera_id}")

        cap, opened = _open_capture(source)

        if not opened:
            consecutive_reconnect_failures += 1
            reconnect_count += 1
            delay = _reconnect_backoff_seconds(consecutive_reconnect_failures)
            print(f"[STREAM] Camera {camera_id}: could not open video source, retrying in {delay}s")
            print(f"[CAMERA_RECONNECTING] camera={camera_id} attempt={consecutive_reconnect_failures} delay={delay}s reason=open_failed")
            print(f"[RTSP-HEALTH] camera={camera_id} reconnect started (reason=open_failed, reconnect_count={reconnect_count})")
            _camlog(camera_id, "RECONNECTING")
            with entry["lock"]:
                entry["connection_state"] = "disconnected"
                entry["reconnect_attempt_count"] = consecutive_reconnect_failures
            _set_online(camera_id, entry, False)
            entry["stop_event"].wait(delay)
            continue

        print(f"[STREAM] Camera {camera_id}: video source connected")
        print(f"[CAMERA_CONNECTED] camera={camera_id}")
        if reconnect_count > 0:
            print(f"[RTSP-HEALTH] camera={camera_id} reconnect successful (reconnect_count={reconnect_count})")
            print(f"[CAMERA_RECONNECTED] camera={camera_id} after {consecutive_reconnect_failures} failed attempt(s)")
            _camlog(camera_id, "RECONNECTED")
        else:
            _camlog(camera_id, "RTSP CONNECTED")
        with entry["lock"]:
            entry["connection_state"] = "connected"
        _set_online(camera_id, entry, True)

        connect_started_at = time.time()
        prev_time = time.time()
        last_health_summary_time = time.time()
        consecutive_failures = 0
        # Real elapsed time with zero successful frames — this, not a
        # failure count, is what decides "reconnect". Reset on every
        # (re)connect so a fresh capture gets the full timeout to
        # deliver its first frame before being judged dead.
        last_frame_success_time = time.time()
        # Diagnostic only: whether we're currently inside a run of failed
        # reads — used to print exactly one "[RTSP-HEALTH] frame lost" at
        # the START of a loss episode (and one "recovered" at the end),
        # instead of one line per failed grab/retrieve — the existing
        # comment below already documents over a MILLION failed grabs in
        # a single 15s outage; logging each one would flood this log
        # without adding information a per-episode line doesn't already
        # give.
        frame_loss_episode_active = False
        frame_loss_episode_started_at = None

        # --- AI Performance / Production Fix: grab() vs read() ---
        # cap.read() is grab()+retrieve() combined — retrieve() is the
        # actual H.264 decode, the expensive part, especially at this
        # camera's native 2560x1440. Measured live: with every frame
        # fully decoded, the reader thread alone pegged this 4-core
        # machine at 100% CPU, starving the AI thread badly enough that
        # a processing cycle grew past TRACK_TIMEOUT_SECONDS again,
        # silently breaking consensus (and therefore attendance/unknown-
        # save) as a direct side effect. grab() only demuxes the
        # compressed packet (cheap) — still called every loop so the
        # RTSP source never sees a slow client (no buffer backlog, no
        # "slideshow" regression), but the actual decode (retrieve()) now
        # only runs at DISPLAY_FPS_CAP, which is already this app's own
        # target live frame rate — decoding faster than that was pure
        # wasted CPU no one could ever see.
        retrieve_interval = 1.0 / DISPLAY_FPS_CAP
        last_retrieve_time = 0.0

        while not entry["stop_event"].is_set():

            grabbed = cap.grab()

            if not grabbed:
                consecutive_failures += 1
                total_failed_reads += 1
                with entry["lock"]:
                    entry["consecutive_frame_failures"] = consecutive_failures
                if not frame_loss_episode_active:
                    frame_loss_episode_active = True
                    frame_loss_episode_started_at = time.time()
                    print(
                        f"[RTSP-HEALTH] camera={camera_id} frame lost (grab failed, "
                        f"time_since_last_success_ms={round((time.time() - last_frame_success_time) * 1000, 1)})"
                    )
                    print(f"[CAMERA_FRAME_FAILED] camera={camera_id} reason=grab_failed")
                # A dropped frame — or a whole burst of them under a
                # brief CPU spike — is normal on a real RTSP link and on
                # a loaded machine; reconnecting on a failure COUNT is
                # what produced the "reconnecting" spam and made
                # playback worse, not better. Only a genuine, sustained
                # absence of frames (see NO_FRAME_TIMEOUT_SECONDS) means
                # the connection itself is actually gone.
                if time.time() - last_frame_success_time >= NO_FRAME_TIMEOUT_SECONDS:
                    print(f"[STREAM] Camera {camera_id}: no frame for {NO_FRAME_TIMEOUT_SECONDS}s ({consecutive_failures} failed reads), reconnecting")
                    reconnect_count += 1
                    print(
                        f"[RTSP-HEALTH] camera={camera_id} reconnect started (reason=no_frame_timeout, "
                        f"consecutive_failures={consecutive_failures}, total_failed_reads={total_failed_reads}, "
                        f"total_successful_reads={total_successful_reads}, reconnect_count={reconnect_count})"
                    )
                    break
                # Root-cause fix: when the underlying FFmpeg/OpenCV capture
                # fails a grab() instantly (no blocking I/O wait at all —
                # e.g. the TCP connection just dropped), this loop was
                # spinning with literally zero yield between attempts.
                # Confirmed live against the real camera: over 1.1 MILLION
                # failed grabs logged in a single 15s window — a full CPU
                # core pinned at 100% doing nothing but re-failing, which
                # starves the AI processor thread (and everything else on
                # this machine) for the whole outage, not just the
                # RTSP link itself. A 10ms yield is far below anything a
                # human would perceive as added latency once the camera
                # recovers, but stops a network blip from becoming a CPU
                # -starvation cascade — a real contributor to "occasional
                # H.264 decode errors" showing up as broader AI slowness.
                entry["stop_event"].wait(0.01)
                continue

            now_perf = time.perf_counter()

            if now_perf - last_retrieve_time < retrieve_interval:
                continue  # buffer stays drained via grab(); decode is throttled, not skipped-and-queued

            success, frame = cap.retrieve()

            if not success:
                consecutive_failures += 1
                total_failed_reads += 1
                with entry["lock"]:
                    entry["consecutive_frame_failures"] = consecutive_failures
                if not frame_loss_episode_active:
                    frame_loss_episode_active = True
                    frame_loss_episode_started_at = time.time()
                    print(
                        f"[RTSP-HEALTH] camera={camera_id} frame lost (decode failed, "
                        f"time_since_last_success_ms={round((time.time() - last_frame_success_time) * 1000, 1)})"
                    )
                    print(f"[CAMERA_FRAME_FAILED] camera={camera_id} reason=decode_failed")
                if time.time() - last_frame_success_time >= NO_FRAME_TIMEOUT_SECONDS:
                    print(f"[STREAM] Camera {camera_id}: no frame for {NO_FRAME_TIMEOUT_SECONDS}s ({consecutive_failures} failed decodes), reconnecting")
                    reconnect_count += 1
                    print(
                        f"[RTSP-HEALTH] camera={camera_id} reconnect started (reason=no_frame_timeout, "
                        f"consecutive_failures={consecutive_failures}, total_failed_reads={total_failed_reads}, "
                        f"total_successful_reads={total_successful_reads}, reconnect_count={reconnect_count})"
                    )
                    break
                # Same reasoning as the grab() failure branch above — never
                # busy-spin on a failing decode.
                entry["stop_event"].wait(0.01)
                continue

            consecutive_failures = 0
            total_successful_reads += 1
            with entry["lock"]:
                entry["consecutive_frame_failures"] = 0
                entry["last_frame_success_time"] = time.time()
            if frame_loss_episode_active:
                frame_loss_episode_active = False
                print(
                    f"[RTSP-HEALTH] camera={camera_id} frame recovered after loss "
                    f"(episode_duration_ms={round((time.time() - frame_loss_episode_started_at) * 1000, 1)})"
                )
                print(f"[CAMERA_FRAME_OK] camera={camera_id} recovered")
            last_retrieve_time = now_perf
            last_frame_success_time = time.time()

            now = time.time()
            fps = 1 / max(now - prev_time, 1e-6)
            prev_time = now

            with entry["lock"]:
                entry["raw_frame"] = frame
                entry["raw_frame_seq"] += 1
                # perf_counter, NOT time.time() — this gets diffed against
                # another perf_counter() reading in frame_processor.py.
                # Mixing the two clocks (wall-clock epoch vs an arbitrary
                # monotonic reference) previously produced a nonsense
                # "Frame Capture" latency of roughly negative-the-current-
                # epoch — same unit (ms), completely wrong clock.
                entry["raw_frame_time"] = now_perf
                entry["fps"] = fps
                annotated_frame = entry["last_annotated_frame"]
                annotated_at = entry["last_annotated_at"]

            # Publish the live JPEG right here, on this never-blocked
            # thread — see the module docstring for why this moved off
            # the (possibly very slow) AI thread. A fresh-enough
            # annotation wins; a stale or absent one falls back to the
            # plain raw frame, so the view is never held hostage by AI
            # falling behind.
            is_annotation_fresh = (
                annotated_frame is not None and now - annotated_at <= ANNOTATION_STALE_SECONDS
            )
            display_frame = annotated_frame if is_annotation_fresh else frame

            ok, buffer = cv2.imencode(".jpg", display_frame)
            if ok:
                with entry["lock"]:
                    entry["latest_jpeg"] = buffer.tobytes()

            _set_online(camera_id, entry, True)

            # Periodic RTSP health summary — every 5s while connected, so
            # "is the link healthy" is visible on a steady cadence rather
            # than only at the two edges (loss/reconnect) above.
            if now - last_health_summary_time >= 5.0:
                last_health_summary_time = now
                print(
                    f"[RTSP-HEALTH] camera={camera_id} summary successful_reads={total_successful_reads} "
                    f"failed_reads={total_failed_reads} reconnects={reconnect_count} "
                    f"consecutive_failures={consecutive_failures} "
                    f"time_since_last_success_ms={round((time.time() - last_frame_success_time) * 1000, 1)}"
                )

        cap.release()

        with entry["lock"]:
            entry["connection_state"] = "disconnected"
        _set_online(camera_id, entry, False)
        print(f"[CAMERA_OFFLINE] camera={camera_id}")
        _camlog(camera_id, "RTSP DISCONNECTED")

        # Camera Runtime Fix (supersedes the old unconditional-instant-
        # retry behavior from the "Continuous On/Off Investigation" —
        # its core finding is preserved below, just made conditional):
        # a connection that stayed up at least STABLE_CONNECTION_SECONDS
        # before dropping is a genuine one-off blip — the source was
        # already reachable a moment ago, so the very next attempt stays
        # INSTANT, exactly as before. A connection that drops faster than
        # that is judged unstable/repeatedly failing — each further
        # attempt in that streak waits a growing, bounded delay
        # (_reconnect_backoff_seconds) instead of retrying immediately
        # forever, which is what let a persistently flaky source cycle
        # LIVE/OFFLINE/LIVE indefinitely with no growing backoff. The
        # open-failed branch above already applies this same backoff for
        # a source that won't even accept a connection; this is the other
        # half — a source that connects fine but can't sustain a stream.
        connection_duration = time.time() - connect_started_at

        if connection_duration >= STABLE_CONNECTION_SECONDS:
            consecutive_reconnect_failures = 0
            delay = 0.0
        else:
            consecutive_reconnect_failures += 1
            delay = _reconnect_backoff_seconds(consecutive_reconnect_failures)

        with entry["lock"]:
            entry["reconnect_attempt_count"] = consecutive_reconnect_failures

        if delay > 0:
            print(
                f"[CAMERA_RECONNECTING] camera={camera_id} attempt={consecutive_reconnect_failures} "
                f"delay={delay}s reason=connection_unstable (was up {round(connection_duration, 1)}s)"
            )
            _camlog(camera_id, "RECONNECTING")
            entry["stop_event"].wait(delay)
        else:
            print(
                f"[CAMERA_RECONNECTING] camera={camera_id} attempt=0 delay=0s reason=brief_blip "
                f"(was up {round(connection_duration, 1)}s, retrying immediately)"
            )
            _camlog(camera_id, "RECONNECTING")

    print(f"[STREAM] Camera {camera_id}: reader thread stopped")


def _camera_processor_loop(camera_id, entry):
    """The AI thread. Always processes whichever raw frame is CURRENTLY
    newest — never a queue, so a slow AI pass simply skips whatever
    arrived while it was busy instead of working through a backlog. Pure
    background work: it only ever updates entry["last_annotated_frame"]
    (and entry["processing_fps"]) — it has no involvement in the live
    JPEG the reader thread publishes (see _camera_reader_loop and the
    module docstring for why display moved off this thread), so however
    long process_frame() takes on any given frame, the live view is
    never the one waiting on it."""

    customer_id = entry["customer_id"]

    # --- AI Performance Fix: warm up YOLO/ByteTrack + InsightFace here,
    # once, BEFORE this loop ever looks at a real frame ---
    # Both detection/detector.py and face/face_detector.py lazy-load
    # their model on first use — a one-time cost historically measured
    # at 5-30+ seconds each (see their own module docstrings). Left
    # lazy, that whole cost previously landed on whichever REAL frame
    # happened to be first through process_frame(), which is exactly
    # the ~25 second live "blocking gap" reported against the webcam.
    # Paying it here instead:
    #   - runs on THIS thread only — the reader thread (live view) is
    #     completely unaffected and keeps streaming the whole time.
    #   - uses the identical compute_tracking_key()/_get_model()/
    #     get_app() code path a real frame would, so nothing about
    #     caching or model identity changes — this warmup call simply
    #     BECOMES the first real call, made before anything is waiting
    #     on its result instead of during live detection.
    #   - is cheap/near-instant on every call after the first for a
    #     given tracking_key (already-loaded model), so restarting a
    #     camera worker never re-pays the full cost.
    # Isolated in its own try/except: a warmup failure must never leave
    # this thread dead — process_frame() below still lazy-loads on
    # first real use exactly as before this fix if warmup didn't
    # complete for any reason.
    try:
        warmup_t0 = time.perf_counter()
        tracking_key = compute_tracking_key(customer_id, entry["pipeline_camera_id"])

        # Until the shared boot pre-warm has finished, a camera turned on
        # must NOT kick off its own concurrent cold model load — two
        # threads both doing InsightFace's first get_app() just serialize
        # on its internal lock and take far longer than one would. Wait
        # for AI_READY first; the warmup_*() calls below then hit
        # already-loaded models and return fast. If the pre-warm failed
        # or is somehow still not ready after AI_PREWARM_WAIT_SECONDS,
        # fall through anyway — the same warmup_*() calls then do the
        # load themselves, exactly as before this coordination existed,
        # so a camera still always works.
        print(f"[AI DEBUG] camera {camera_id}: warmup start — waiting for boot pre-warm (state={ai_prewarm.get_state()})")
        if not ai_prewarm.wait_until_ready(timeout=AI_PREWARM_WAIT_SECONDS):
            print(
                f"[AI ENGINE] Camera {camera_id}: boot pre-warm not ready "
                f"(state={ai_prewarm.get_state()}) — loading AI models on this thread instead"
            )

        _w = time.perf_counter()
        warmup_yolo(tracking_key)
        print(f"[AI DEBUG] camera {camera_id}: warmup YOLO ready ({round((time.perf_counter() - _w) * 1000, 1)}ms)")
        _w = time.perf_counter()
        warmup_face()
        print(f"[AI DEBUG] camera {camera_id}: warmup InsightFace ready ({round((time.perf_counter() - _w) * 1000, 1)}ms)")
        # Multi-Object & Fire Detection: pays the fire model's one-time
        # load cost here too. No-op (and no error) when no fire model is
        # installed — see detection/fire_detector.py.
        _w = time.perf_counter()
        warmup_fire()
        print(f"[AI DEBUG] camera {camera_id}: warmup Fire/Smoke model ready ({round((time.perf_counter() - _w) * 1000, 1)}ms)")
        print(f"[AI ENGINE] Camera {camera_id}: AI models warmed up in {round((time.perf_counter() - warmup_t0) * 1000, 1)}ms")
        print(f"[AI DEBUG] camera {camera_id}: warmup complete — entering frame-processing loop")
    except Exception as e:
        log_exception(e, f"AI model warmup (camera={camera_id})")

    processing_interval = 1.0 / PROCESSING_FPS_CAP

    last_processed_seq = -1
    last_processed_time = 0.0
    prev_proc_time = time.time()

    # How often YOLO/InsightFace actually run versus how often the reader
    # thread is publishing a displayed frame — printed every few AI cycles
    # rather than every single one, so it's a light, occasional line, not
    # log spam. entry["fps"] (raw/display rate) is written by the reader
    # thread; entry["processing_fps"] (this thread's own real cadence) is
    # written right below. Both are read together so the ratio reflects
    # one consistent moment instead of two readings that could be seconds
    # apart.
    cycles_since_metric_log = 0

    # Camera Runtime Fix: tracks whether AI processing is currently
    # "paused" for lack of fresh frames (camera offline, or simply no new
    # raw_frame yet) — set True below whenever this loop finds nothing new
    # to do while the camera isn't online; cleared, with a
    # DETECTION_RESUMED log line, the moment a genuinely new frame is
    # about to be processed again. This loop itself NEVER stops or
    # restarts across a reconnect — only whether it currently has fresh
    # work does — so "resumed" here means exactly that: the same running
    # thread picking back up, not a new one starting.
    detection_paused = False

    print(f"[STREAM] Camera {camera_id}: processor thread started")

    while not entry["stop_event"].is_set():

        with entry["lock"]:
            frame = entry["raw_frame"]
            seq = entry["raw_frame_seq"]
            frame_capture_time = entry["raw_frame_time"]
            is_online = entry["online"]

        if not is_online:
            detection_paused = True

        if frame is None:
            entry["stop_event"].wait(0.05)
            continue

        now = time.time()
        is_new_frame = seq != last_processed_seq
        should_run_ai = is_new_frame and (now - last_processed_time >= processing_interval)

        if not should_run_ai:
            entry["stop_event"].wait(0.01)
            continue

        if detection_paused:
            print(f"[DETECTION_RESUMED] camera={camera_id} — new frames arriving again, AI processing resumed")
            detection_paused = False

        _camlog(camera_id, "FRAME RECEIVED")
        _camlog(camera_id, "AI PROCESSING")

        # No customer-wide lock here anymore — YOLO/InsightFace inference
        # has no shared-state race, so a customer's cameras now run
        # process_frame() fully concurrently. The only part that ever
        # needed serializing (attendance.py's mark_attendance() and face/
        # unknown_manager.py's save_unknown() check-then-write against
        # MySQL) now locks itself, narrowly, via camera/processing_locks.py
        # — see that module's docstring.
        print(f"[PIPELINE] Frame decoded successfully (camera={camera_id})")
        print(f"[AI DEBUG] frame received (camera={camera_id} seq={seq})")

        # process_frame() is NOT allowed to take this thread down — an
        # unhandled exception here previously killed the AI processing
        # thread PERMANENTLY for this camera: the reader thread keeps
        # running (video stays smooth), but recognition/attendance/
        # unknown-detection silently stop forever with no visible error
        # until the next backend restart. Exactly the "skipped silently"
        # failure mode this task explicitly forbids. Now: log full file/
        # function/line/reason, keep the previous annotation in place, and
        # try again on the NEXT frame.
        try:
            annotated_frame = process_frame(
                frame,
                customer_id,
                camera_id=entry["pipeline_camera_id"],
                capture_time=frame_capture_time,
                source_label=entry["source_label"],
                owner_user_id=entry.get("owner_user_id"),
            )
            # Freshly read, not the `now` captured before process_frame()
            # ran — that call is exactly the slow part being timed
            # against, so using a pre-call timestamp here would silently
            # under-count staleness by however long AI just took.
            with entry["lock"]:
                entry["last_annotated_frame"] = annotated_frame
                entry["last_annotated_at"] = time.time()
        except Exception as e:
            print(f"[AI DEBUG] process_frame RAISED for camera={camera_id} — full traceback follows:")
            log_exception(e, f"process_frame (camera={camera_id}, customer={customer_id})")

        last_processed_seq = seq
        last_processed_time = now

        proc_fps = 1 / max(now - prev_proc_time, 1e-6)
        prev_proc_time = now
        with entry["lock"]:
            entry["processing_fps"] = round(proc_fps, 1)
            display_fps = entry["fps"]

        cycles_since_metric_log += 1
        if cycles_since_metric_log >= 5:
            cycles_since_metric_log = 0
            ratio = round(display_fps / proc_fps, 1) if proc_fps > 1e-6 else float("inf")
            print(f"[METRICS] Camera {camera_id}: display={display_fps:.1f}fps | AI processing={proc_fps:.2f}fps (~1 AI cycle per {ratio:.0f} displayed frames)")

        entry["stop_event"].wait(0.01)

    print(f"[STREAM] Camera {camera_id}: processor thread stopped")


def start_camera_worker(camera_id, customer_id, source, is_local=False, owner_user_id=None):
    """Idempotent — a camera that already has a running worker is left
    alone. Called at boot for every enabled camera, when a camera is
    added, and when a camera is re-enabled.

    `is_local=True` is the ONLY thing that distinguishes the laptop
    webcam debug source from a real RTSP camera: `source` is an int
    device index instead of an RTSP URL string, and
    `pipeline_camera_id` (what gets passed to process_frame(), and from
    there into the attendance/unknown_persons camera_id FK columns) is
    forced to None instead of the real `camera_id`, since the debug
    webcam has no row in the `cameras` table to reference. Everything
    else — both threads, process_frame() itself, recognition/quality/
    consensus/attendance/unknown logic — is exactly the same code path
    for both.

    `owner_user_id` (Per-User Data Isolation) is the Camera row's own
    assignment (None if unassigned) — stored on the entry so the
    reader/processor threads never need a DB round-trip to know it, used
    only for the camera-offline notification trigger (see
    _set_online/_new_camera_entry below); it never affects detection
    itself."""

    with _camera_streams_lock:

        entry = _camera_streams.get(camera_id)

        if entry is not None and entry["running"]:
            return entry

        entry = _new_camera_entry(customer_id, source)
        entry["running"] = True
        entry["is_local"] = is_local
        entry["pipeline_camera_id"] = None if is_local else camera_id
        entry["source_label"] = "WEBCAM" if is_local else "RTSP"
        entry["owner_user_id"] = owner_user_id
        _camera_streams[camera_id] = entry

    reader = threading.Thread(target=_camera_reader_loop, args=(camera_id, entry), daemon=True)
    processor = threading.Thread(target=_camera_processor_loop, args=(camera_id, entry), daemon=True)
    entry["reader_thread"] = reader
    entry["processor_thread"] = processor
    reader.start()
    processor.start()

    print(f"[AI ENGINE] Camera {camera_id}: worker started (customer={customer_id})")

    return entry


def stop_camera_worker(camera_id):
    """Signals both of the camera's threads to stop, WAITS for them to
    actually exit, then drops it from the registry. Safe to call on a
    camera_id with no running worker (no-op).

    --- Connection Fix: intermittent DirectShow "could not open video
    source" / "raised unknown C++ exception" on the local webcam ---
    This used to pop the entry and return immediately, without waiting
    for the reader thread to actually release the device (cap.release()).
    A caller that starts a NEW worker for the SAME camera_id right after
    calling this — e.g. start_local()'s cross-customer takeover
    (stop_camera_worker() immediately followed by start_camera_worker()),
    or a fast OFF-then-ON toggle — could then open a SECOND
    cv2.VideoCapture on the SAME physical device while the first one was
    still inside cap.open()/cap.grab(), which is exactly what DirectShow
    reports as an "unknown C++ exception". Joining here (with a timeout
    so this can never hang forever) guarantees the hardware is actually
    free, and no orphaned duplicate worker is left running, before this
    function returns."""

    with _camera_streams_lock:
        entry = _camera_streams.pop(camera_id, None)

    if entry is None:
        return

    _stop_worker_entry(camera_id, entry)


def _stop_worker_entry(camera_id, entry):
    """The actual signal-and-join logic stop_camera_worker() above uses —
    factored out so the Camera Quality Hot-Swap below can stop a SPECIFIC
    entry object (the old-resolution worker, or an abandoned new one that
    never got its first frame) without going through _camera_streams at
    all, since by the time either of those needs stopping the dict may
    already point at a different (or no) entry for this camera_id. Safe
    to call on an entry whose threads never started (both .get() calls
    below return None) — used by the hot-swap's timeout-abort path."""

    entry["stop_event"].set()
    print(f"[AI ENGINE] Camera {camera_id}: worker stopping")

    # Generous enough to cover the slowest realistic blocking call each
    # thread can be stuck in (a DSHOW/FFMPEG cap.open() attempt, bounded
    # by CAMERA_OPEN_TIMEOUT_SECONDS) without ever blocking the caller
    # indefinitely — if a thread somehow doesn't exit in time, that's
    # logged rather than silently hung on.
    join_timeout = CAMERA_OPEN_TIMEOUT_SECONDS + 5

    reader_thread = entry.get("reader_thread")
    if reader_thread is not None:
        reader_thread.join(timeout=join_timeout)
        if reader_thread.is_alive():
            print(f"[AI ENGINE] Camera {camera_id}: reader thread still alive after {join_timeout}s stop timeout")

    processor_thread = entry.get("processor_thread")
    if processor_thread is not None:
        processor_thread.join(timeout=join_timeout)
        if processor_thread.is_alive():
            print(f"[AI ENGINE] Camera {camera_id}: processor thread still alive after {join_timeout}s stop timeout")

    print(f"[AI ENGINE] Camera {camera_id}: worker stopped")


def drop_camera_ai_state(camera_id):
    """Releases every per-tracking_key AI cache a real (non-local-webcam)
    camera can accumulate — its cached YOLO model instance (detection/
    detector.py), detection-persistence/face-gate state (camera/
    frame_processor.py), and active consensus tracks (face/track_verifier.
    py) — call this ONLY when a camera is genuinely DELETED (api/cameras.
    py's delete_camera), never on disable/restart, both of which reuse
    the same tracking_key and must keep this state warm exactly as
    before. A real camera's own tracking_key IS its camera_id (see
    camera/frame_processor.py's compute_tracking_key — camera_id here is
    never None, this is never the local-webcam pseudo-camera), so no
    lookup is needed to know what to drop. Does NOT touch
    _camera_streams/stop_camera_worker's own state — call that
    separately (delete_camera already does, first)."""

    drop_yolo_model(camera_id)
    drop_tracking_state(camera_id)
    drop_tracks(camera_id)


# How long restart_camera_worker()'s hot-swap below will wait for the
# NEW-resolution worker's reader thread to deliver a genuine first
# decoded frame before giving up and leaving the OLD worker running
# untouched. A few seconds more than CAMERA_OPEN_TIMEOUT_SECONDS — covers
# cap.open() itself plus the first grab()/retrieve() pair, without ever
# blocking much longer than a plain connect attempt already can.
HOT_SWAP_FIRST_FRAME_TIMEOUT_SECONDS = CAMERA_OPEN_TIMEOUT_SECONDS + 3
HOT_SWAP_POLL_INTERVAL_SECONDS = 0.1


def restart_camera_worker(camera_id, customer_id, rtsp_url, owner_user_id=None):
    """Camera Quality Hot-Swap — used when a camera's connection details
    (most commonly its Stream Quality: 480p/720p/1080p) are edited, so
    the change takes effect immediately instead of waiting for the next
    backend restart.

    Root-cause fix for "detection stalls immediately after changing
    camera quality": this used to be a plain stop_camera_worker() +
    start_camera_worker() — the OLD-resolution worker was torn down
    COMPLETELY (RTSP disconnected, both threads joined, entry dropped)
    before the NEW-resolution worker even started opening its own
    connection. Live view AND detection both went dark for the full
    old-worker-join time (up to CAMERA_OPEN_TIMEOUT_SECONDS + 5 = 13s)
    PLUS however long the new, higher-resolution RTSP stream then took
    to connect and deliver its first frame (up to another
    CAMERA_OPEN_TIMEOUT_SECONDS = 8s) — a ~21s worst-case gap with
    nothing flowing at all.

    Now: the NEW-resolution worker's READER thread is started FIRST,
    running side-by-side with the OLD worker's reader+processor threads
    — as its own, separate entry, deliberately NOT yet registered under
    _camera_streams[camera_id], so every other reader of that dict
    (get_latest_jpeg, get_worker_state, camera/stream.py's MJPEG
    generator) keeps serving the OLD worker's live frames the entire
    time this waits — no gap, no half-connected black frame. Once the
    new reader has decoded a genuine first frame at the new resolution
    (raw_frame is no longer None — the same signal the old single-worker
    design would otherwise only observe a full reconnect cycle later),
    _camera_streams[camera_id] flips over to the new entry — an atomic
    dict assignment, so nothing ever sees two workers registered for one
    camera_id at once — and the OLD worker (both its threads) is stopped.

    The NEW entry's PROCESSOR thread is deliberately started only AFTER
    the OLD worker has fully stopped, never during the overlap — both
    entries share the exact same tracking_key (camera/frame_processor.
    py's compute_tracking_key is keyed by camera_id, unaffected by which
    "generation" of worker is running it), and that per-tracking_key
    state (detection-persistence overlay, face-gate timestamps, face/
    track_verifier.py's active consensus tracks) was never designed for
    two concurrent process_frame() calls against the same key. Video is
    therefore gap-free (the new reader publishes entry["latest_jpeg"]
    itself, independent of any processor), while AI/detection resumes
    right behind it, bounded only by however long the old processor
    thread's join takes — the same, pre-existing cost stop_camera_worker
    always had, not a new one.

    Same single-slot raw_frame/raw_frame_seq architecture as always for
    both the old and new entry — the new worker is a completely ordinary
    _new_camera_entry(), no queue, nothing about how frames are buffered
    or how stale ones are (never) processed changes; see
    _camera_reader_loop/_camera_processor_loop's own docstrings.

    If the new-resolution connection never delivers a first frame within
    HOT_SWAP_FIRST_FRAME_TIMEOUT_SECONDS (bad URL for this quality tier,
    camera rejecting the new profile, etc.), the attempt is abandoned,
    its reader thread is stopped, and the OLD worker is left running
    completely untouched — a failed quality change degrades to "nothing
    changed" rather than "camera now offline". The old worker's own
    RTSP-HEALTH reconnect/backoff machinery is entirely unaffected by any
    of this; it never even enters the picture during a hot-swap attempt.

    _get_restart_lock(camera_id) serializes overlapping calls for the
    SAME camera_id (see its own comment) — two quality changes fired in
    quick succession apply one after another, each against whatever is
    current at the moment it actually runs, never racing to stop/replace
    the same entry twice."""

    with _get_restart_lock(camera_id):

        with _camera_streams_lock:
            old_entry = _camera_streams.get(camera_id)

        if old_entry is None:
            # No worker currently running for this camera (disabled, or
            # this is the first start after connection details already
            # differ from what's saved) — nothing to hot-swap against; a
            # plain start is both correct and already instant, since
            # there's no old stream to keep alive in the meantime.
            return start_camera_worker(camera_id, customer_id, rtsp_url, owner_user_id=owner_user_id)

        print(f"[AI ENGINE] Camera {camera_id}: hot-swap starting new-resolution worker (old worker stays live)")

        new_entry = _new_camera_entry(customer_id, rtsp_url)
        new_entry["running"] = True
        new_entry["is_local"] = old_entry.get("is_local", False)
        new_entry["pipeline_camera_id"] = old_entry.get("pipeline_camera_id", camera_id)
        new_entry["source_label"] = old_entry.get("source_label", "RTSP")
        new_entry["owner_user_id"] = owner_user_id

        # Reader only, for now — see the docstring above for why the
        # processor thread waits until after the old worker is stopped.
        new_reader = threading.Thread(target=_camera_reader_loop, args=(camera_id, new_entry), daemon=True)
        new_entry["reader_thread"] = new_reader
        new_entry["processor_thread"] = None
        new_reader.start()

        deadline = time.time() + HOT_SWAP_FIRST_FRAME_TIMEOUT_SECONDS
        got_first_frame = False

        while time.time() < deadline:
            with new_entry["lock"]:
                if new_entry["raw_frame"] is not None:
                    got_first_frame = True
                    break
            if new_entry["stop_event"].is_set():
                break
            time.sleep(HOT_SWAP_POLL_INTERVAL_SECONDS)

        if not got_first_frame:
            print(
                f"[AI ENGINE] Camera {camera_id}: hot-swap new-resolution worker did not deliver a "
                f"first frame within {HOT_SWAP_FIRST_FRAME_TIMEOUT_SECONDS}s — aborting swap, old worker stays live"
            )
            _stop_worker_entry(camera_id, new_entry)
            return old_entry

        print(f"[AI ENGINE] Camera {camera_id}: hot-swap new-resolution worker live — switching live view over")

        with _camera_streams_lock:
            _camera_streams[camera_id] = new_entry

        # OLD worker stopped only now, AFTER the new one is already what
        # every reader is looking at — old_entry is the local reference
        # captured above, not a fresh dict lookup (the dict no longer
        # points at it). This joins BOTH of the old worker's threads,
        # guaranteeing the old processor thread has fully exited before
        # the new one starts below — the two never run concurrently
        # against the same tracking_key.
        _stop_worker_entry(camera_id, old_entry)

        new_processor = threading.Thread(target=_camera_processor_loop, args=(camera_id, new_entry), daemon=True)
        new_entry["processor_thread"] = new_processor
        new_processor.start()

        print(f"[AI ENGINE] Camera {camera_id}: hot-swap complete")

        return new_entry


def get_worker_state(camera_id):
    """Read-only — never starts a worker. Returns the offline default
    if this camera has no running worker (disabled, or not yet started)."""

    with _camera_streams_lock:
        entry = _camera_streams.get(camera_id)

    if entry is None:
        return {"online": False, "fps": 0.0}

    with entry["lock"]:
        return {"online": entry["online"], "fps": round(entry["fps"], 1)}


def get_worker_customer_id(camera_id):
    """Read-only. None if this key has no running worker. Used by
    camera/stream.py's local-webcam wrapper to detect a different
    customer taking over the one shared local device — the debug webcam
    is a single piece of hardware, not a per-customer resource like a
    real RTSP camera, so a customer switch there has to explicitly stop
    the previous owner's worker instead of silently reusing it."""

    with _camera_streams_lock:
        entry = _camera_streams.get(camera_id)

    return entry["customer_id"] if entry is not None else None


def get_latest_jpeg(camera_id):
    """Read-only single-frame accessor for the MJPEG generator in
    camera/stream.py. None if this camera has no running worker or no
    frame has been captured yet."""

    with _camera_streams_lock:
        entry = _camera_streams.get(camera_id)

    if entry is None:
        return None

    with entry["lock"]:
        return entry["latest_jpeg"]


def start_all_enabled_cameras():
    """The AI Detection Engine's boot entrypoint — called once from
    api/app.py when the backend starts, independent of any frontend
    request or logged-in user. Every camera across every customer with
    detection_enabled=True gets its own worker thread immediately.

    Security fix: Camera.rtsp_url is now a sanitized display value, not
    a working connection string (see auth/models.py) — the real one is
    rebuilt in memory here via api.cameras._resolve_connection_url(),
    same deferred-import reasoning as _open_capture() above (api.cameras
    already imports this module, so importing it back at module load
    time would be circular)."""

    from api.cameras import _resolve_connection_url

    with get_session() as session:
        cameras = session.scalars(select(Camera).where(Camera.detection_enabled == 1)).all()
        camera_list = [(c.camera_id, c.customer_id, _resolve_connection_url(c), c.owner_user_id) for c in cameras]

    print(f"[AI ENGINE] Starting {len(camera_list)} enabled camera worker(s) at boot")

    for camera_id, customer_id, rtsp_url, owner_user_id in camera_list:
        start_camera_worker(camera_id, customer_id, rtsp_url, owner_user_id=owner_user_id)
