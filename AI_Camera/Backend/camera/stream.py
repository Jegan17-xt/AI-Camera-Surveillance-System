import time

from camera import detection_service

STREAM_FPS_CAP = 20  # how often an MJPEG generator emits a frame

# ==========================================================================
# Local test webcam — Debug Mode. Runs through the EXACT SAME
# detection_service worker (reader thread + AI processor thread calling
# camera/frame_processor.py's process_frame()) as a real RTSP camera; the
# only difference is `source=0` (a local device index) instead of an RTSP
# URL string, and `is_local=True`, which detection_service.py uses solely
# to (a) pick the right OpenCV backend for a local device and (b) pass
# camera_id=None into process_frame() (the debug webcam has no row in the
# `cameras` table, so it can never satisfy the attendance/unknown_persons
# camera_id foreign key — None is the correct, schema-safe value). There
# is no second AI pipeline here — this module is now just a thin
# read-only wrapper around detection_service, identical in shape to the
# RTSP wrapper functions below.
# ==========================================================================
LOCAL_CAMERA_KEY = "local"
LOCAL_DEVICE_INDEX = 0


def start_local(customer_id, owner_user_id=None):
    """Explicitly starts (or takes over) the shared local-webcam worker
    for this customer — called ONLY from the ON/OFF toggle (and the
    initial "Use Local Camera" click, which turns it on immediately).
    The physical webcam is one piece of hardware shared by whoever is
    logged in — if a different customer already owns the running worker,
    it's stopped first so the new session doesn't silently inherit
    someone else's AI pipeline results (or write attendance/unknown
    records into the wrong tenant). Starts the SAME detection_service
    worker a real RTSP camera would get; nothing here is AI-pipeline
    logic, just which video source that shared worker reads from.

    `owner_user_id` (optional, Per-User Data Isolation): the logged-in
    User this debug session belongs to, if any — a real camera's
    unknown-person saves get their owner from Camera.owner_user_id, but
    the webcam has no camera row to read that from, so the caller
    (api/routes.py's live_camera_local_start, via the same
    get_data_scope() every other scoped endpoint already uses) passes it
    straight through instead. None (a Company Admin's own general test)
    keeps today's exact pooled/unassigned behavior."""

    current_owner = detection_service.get_worker_customer_id(LOCAL_CAMERA_KEY)

    if current_owner is not None and current_owner != customer_id:
        detection_service.stop_camera_worker(LOCAL_CAMERA_KEY)

    detection_service.start_camera_worker(
        LOCAL_CAMERA_KEY, customer_id, LOCAL_DEVICE_INDEX, is_local=True, owner_user_id=owner_user_id
    )

    return detection_service.get_worker_state(LOCAL_CAMERA_KEY)


def stop_local():
    """Explicitly stops the shared local-webcam worker — signals both its
    threads to exit; the reader thread's cap.release() (camera/
    detection_service.py) is what actually frees the hardware device.
    Called ONLY from the ON/OFF toggle (and the "Hide Local Camera"
    button, as a safety net if it was left on)."""

    detection_service.stop_camera_worker(LOCAL_CAMERA_KEY)


# get_local_status/generate_local_mjpeg are pure READERS, exactly like
# get_camera_stream_status/generate_camera_mjpeg below — neither one ever
# starts or stops the worker itself anymore (that used to happen
# implicitly on every status poll, which is exactly the "toggle OFF but
# the next poll silently restarts it" race this Debug Mode's ON/OFF
# toggle needs to not have). A local camera with no running worker
# (never started, or explicitly stopped) simply reads back as
# offline/no frame, same as an RTSP camera would.
def get_local_status(customer_id):
    return detection_service.get_worker_state(LOCAL_CAMERA_KEY)


def generate_local_mjpeg(customer_id):

    boundary = b"--frame"
    delay = 1.0 / STREAM_FPS_CAP

    while True:

        frame = detection_service.get_latest_jpeg(LOCAL_CAMERA_KEY)

        if frame is not None:
            yield (
                boundary + b"\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            )

        time.sleep(delay)


# ==========================================================================
# Configured (RTSP/DVR) cameras — these two functions are pure READERS.
# They never start, stop, or restart a camera's AI detection worker; that
# is exclusively camera/detection_service.py's job, driven by the backend
# boot sequence and by Camera Management add/enable/disable/delete
# actions, never by a viewer opening (or closing) the Live Camera page.
# A camera with no running worker (disabled, or not yet started) simply
# reads back as offline/no frame here — it is never auto-started as a
# side effect of a GET request.
# ==========================================================================
def get_camera_stream_status(camera_id, customer_id, rtsp_url):
    return detection_service.get_worker_state(camera_id)


def generate_camera_mjpeg(camera_id, customer_id, rtsp_url):

    boundary = b"--frame"
    delay = 1.0 / STREAM_FPS_CAP

    while True:

        frame = detection_service.get_latest_jpeg(camera_id)

        if frame is not None:
            yield (
                boundary + b"\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            )

        time.sleep(delay)
