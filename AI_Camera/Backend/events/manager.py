"""Centralized Event Manager for the AI detection pipeline's non-face
detections (vehicles, animals, birds, fire, smoke).

camera/frame_processor.py calls record_detection() and moves on — it
never touches the detection_events table, the filesystem, or the
notification layer directly. This is the one seam:

    AI Detection -> record_detection() -> DetectionEvent row + snapshot
        -> in-app Notification (fire/smoke only)
        -> WhatsApp AI Detection Alert (every writable type, 2026-09-01
           — see notifications/service.py's deliver_ai_detection_alert)

Every writable event type saves ONE snapshot on the first sighting; a
continuously-visible object within the cooldown window only bumps
detection_count and never writes another image.

record_detection() NEVER raises: any failure in here is logged and
swallowed so the camera processor thread's next frame is unaffected —
the same guarantee face/unknown_manager.py's save_unknown() notification
block already gives.

PERSON_DETECTED / UNKNOWN_FACE are deliberately NOT written here:
Attendance and UnknownPerson already own those, and
api/detection_events.py merges them into the unified events view at read
time (same "merge several real sources" pattern api/dashboard.py's
get_recent_activity already uses) — writing a parallel row would
duplicate existing functionality.
"""

import os
import threading
import time
from datetime import datetime

import cv2

from db import get_session
from auth.models import Camera, DetectionEvent
from error_logging import log_exception

_DATETIME_FMT = "%d-%m-%Y %H:%M:%S"

# The stored event_type strings (unchanged for CAR/ANIMAL to preserve the
# existing API/filter contract). The user-facing label is derived from
# these in the frontend: CAR_DETECTED -> "VEHICLE", ANIMAL_DETECTED ->
# "ANIMAL", BIRD_DETECTED -> "BIRD" — the specific COCO class stays in the
# object_type column for internal use only, never shown.
EVENT_CAR = "CAR_DETECTED"       # any vehicle: car / bus / truck / motorcycle / bicycle
EVENT_ANIMAL = "ANIMAL_DETECTED"  # any non-bird animal: dog / cat / cow / horse / sheep / ...
EVENT_BIRD = "BIRD_DETECTED"     # bird, kept as its own category per spec
EVENT_FIRE = "FIRE_DETECTED"
EVENT_SMOKE = "SMOKE_DETECTED"

# Event types this manager writes rows for.
WRITABLE_EVENT_TYPES = (EVENT_CAR, EVENT_ANIMAL, EVENT_BIRD, EVENT_FIRE, EVENT_SMOKE)

# Every event type the unified events view knows about (writable ones
# plus the two merged from existing tables) — used by
# api/detection_events.py for ?type= validation.
ALL_EVENT_TYPES = ("PERSON_DETECTED", "UNKNOWN_FACE") + WRITABLE_EVENT_TYPES

# Filename prefix for each type's saved snapshot — the generic category,
# not the COCO class, so the on-disk name matches what the UI shows.
_SNAPSHOT_PREFIX = {
    EVENT_CAR: "vehicle",
    EVENT_ANIMAL: "animal",
    EVENT_BIRD: "bird",
    EVENT_FIRE: "fire",
    EVENT_SMOKE: "smoke",
}

# WhatsApp AI Detection Alert's {{1}} Detection Type — a human-readable
# label, not the internal event_type/object_type strings (see
# notifications/service.py's deliver_ai_detection_alert).
_DETECTION_TYPE_LABEL = {
    EVENT_CAR: "Vehicle",
    EVENT_ANIMAL: "Animal",
    EVENT_BIRD: "Bird",
    EVENT_FIRE: "Fire",
    EVENT_SMOKE: "Smoke",
}

# How long the SAME continuously-visible object/fire on the SAME camera
# is treated as one ongoing event (its detection_count/last_seen just get
# bumped) instead of spawning a new row — "do not save every frame /
# avoid duplicate event creation". Fire/smoke shorter so a genuinely
# re-flaring fire still produces a fresh, separately-alertable record
# reasonably quickly.
_COOLDOWN_SECONDS = {
    EVENT_CAR: 60.0,
    EVENT_ANIMAL: 60.0,
    EVENT_BIRD: 60.0,
    EVENT_FIRE: 30.0,
    EVENT_SMOKE: 30.0,
}
_DEFAULT_COOLDOWN_SECONDS = 60.0

# Face/frame/snapshot images stay filesystem-based per the storage spec —
# only structured metadata lives in MySQL. Same per-customer isolation
# boundary as face/unknown_manager.py.
CUSTOMERS_ROOT = os.path.join("dataset", "customers")

# (customer_id, camera_id, event_type, dedup_bucket) -> {"id": int, "ts": float}
# In-memory only, same "safe to lose on restart" property as
# notifications/service.py's _last_alert_sent_at — worst case a restart
# lets the next sighting open one new row instead of bumping the old one.
_recent = {}
_recent_lock = threading.Lock()


def _events_folder(customer_id, day_str):
    return os.path.join(CUSTOMERS_ROOT, str(customer_id), "events", day_str)


def _resolve_camera_fields(camera_id):
    """(location, owner_user_id) for a camera_id, or (None, None). One
    query — mirrors the several single-purpose _resolve_camera_* helpers
    in face/unknown_manager.py."""

    if camera_id is None:
        return None, None

    try:
        with get_session() as session:
            camera = session.get(Camera, camera_id)
            if camera is None:
                return None, None
            return camera.camera_location, camera.owner_user_id
    except Exception as e:
        log_exception(e, f"events.manager._resolve_camera_fields (camera={camera_id})")
        return None, None


def _save_snapshot(customer_id, event_type, snapshot, now):
    """Writes the detection's evidence frame to
    dataset/customers/<id>/events/<DD-MM-YYYY>/<category>_<HH-MM-SS>.jpg
    and returns the path relative to dataset/customers/<id>/events/ (what
    the image_path column stores). None on any failure — a missing
    snapshot must never block the row insert. Called ONCE per new event
    (never on a cooldown re-sighting), so a continuously-visible object
    produces exactly one image, not one per frame."""

    if snapshot is None or getattr(snapshot, "size", 0) == 0:
        return None

    try:
        day_str = now.strftime("%d-%m-%Y")
        folder = _events_folder(customer_id, day_str)
        os.makedirs(folder, exist_ok=True)
        prefix = _SNAPSHOT_PREFIX.get(event_type, event_type.split("_")[0].lower())
        name = f"{prefix}_{now.strftime('%H-%M-%S')}.jpg"
        abs_path = os.path.join(folder, name)

        if cv2.imwrite(abs_path, snapshot):
            return f"{day_str}/{name}"
    except Exception as e:
        log_exception(e, f"events.manager._save_snapshot (customer={customer_id}, {event_type})")

    return None


def _notify_fire(customer_id, owner_user_id, event_type, camera_id, location):
    """In-app notification bell only (the existing per-user Notification
    table, via api/notifications.create_notification). WhatsApp fire
    alerts would need a provider-approved template like
    unknown_person_alert — out of scope here. Fully exception-isolated,
    runs on its own daemon thread."""

    try:
        from api.notifications import create_notification

        label = "Smoke" if event_type == EVENT_SMOKE else "Fire"
        create_notification(
            customer_id,
            owner_user_id,
            type="fire_detected",
            message=f"{label} detected{f' at {location}' if location else ''}.",
            camera_id=camera_id,
        )
    except Exception as e:
        log_exception(e, f"events.manager._notify_fire (customer={customer_id}, {event_type})")


def _send_ai_detection_alert(customer_id, event_type, camera_id, location, image_path):
    """WhatsApp AI Detection Alert (notifications/service.py's
    deliver_ai_detection_alert) — every writable event type, not just
    fire/smoke like the in-app _notify_fire above. Fully
    exception-isolated, runs on its own daemon thread, same guarantee as
    _notify_fire."""

    try:
        from notifications.service import deliver_ai_detection_alert

        deliver_ai_detection_alert(
            customer_id,
            detection_type=_DETECTION_TYPE_LABEL.get(event_type, event_type),
            camera_id=camera_id,
            location=location,
            image_path=image_path,
        )
    except Exception as e:
        log_exception(e, f"events.manager._send_ai_detection_alert (customer={customer_id}, {event_type})")


def record_detection(
    customer_id,
    event_type,
    *,
    camera_id=None,
    owner_user_id=None,
    object_type=None,
    confidence=None,
    location=None,
    dedup_bucket=None,
    snapshot=None,
):
    """Record one non-face detection. Returns the DetectionEvent row id
    (a new row, or the bumped existing one), or None if nothing was
    written.

    NEVER raises — every failure path logs and returns None so the camera
    processor thread is never taken down by event bookkeeping.

    `dedup_bucket` groups sightings that should share one row. The
    pipeline passes the generic CATEGORY ("vehicle" / "animal" / "bird" /
    "fire" / "smoke"), so continuous mixed traffic (a car, then a bus)
    bumps a single VEHICLE event instead of spawning one per class — and
    only that first sighting saves an image. Defaults to `object_type`.
    """

    try:
        if event_type not in WRITABLE_EVENT_TYPES:
            return None

        now = datetime.now()
        now_str = now.strftime(_DATETIME_FMT)
        now_ts = time.time()
        cooldown = _COOLDOWN_SECONDS.get(event_type, _DEFAULT_COOLDOWN_SECONDS)
        key = (customer_id, camera_id, event_type, dedup_bucket or object_type or "")

        if camera_id is not None and (location is None or owner_user_id is None):
            cam_location, cam_owner = _resolve_camera_fields(camera_id)
            if location is None:
                location = cam_location
            if owner_user_id is None:
                owner_user_id = cam_owner

        with _recent_lock:
            prior = _recent.get(key)
            within_cooldown = prior is not None and (now_ts - prior["ts"]) < cooldown

        if within_cooldown:
            try:
                bumped_id = None
                with get_session() as session:
                    row = session.get(DetectionEvent, prior["id"])
                    if row is not None and row.customer_id == customer_id:
                        row.last_seen = now_str
                        row.detection_count = (row.detection_count or 0) + 1
                        bumped_id = row.id

                if bumped_id is not None:
                    with _recent_lock:
                        _recent[key] = {"id": bumped_id, "ts": now_ts}
                    return bumped_id
                # bump target vanished (deleted / retention swept) — fall
                # through and open a fresh row instead
            except Exception as e:
                log_exception(e, f"events.manager bump (customer={customer_id}, {event_type})")

        # Snapshot for EVERY writable type now (vehicle / animal / bird /
        # fire / smoke) — only on this first (non-cooldown) sighting.
        image_path = _save_snapshot(customer_id, event_type, snapshot, now)

        with get_session() as session:
            row = DetectionEvent(
                customer_id=customer_id,
                camera_id=camera_id,
                owner_user_id=owner_user_id,
                event_type=event_type,
                object_type=object_type,
                confidence=float(confidence) if confidence is not None else None,
                image_path=image_path,
                detected_time=now_str,
                last_seen=now_str,
                detection_count=1,
                location=location,
                status="Active",
                created_at=now_str,
            )
            session.add(row)
            session.flush()
            new_id = row.id

        with _recent_lock:
            _recent[key] = {"id": new_id, "ts": now_ts}

        print(
            f"[EVENT] {event_type} recorded (id={new_id}, customer={customer_id}, "
            f"camera={camera_id}, object={object_type}, conf={confidence})"
        )
        if camera_id is not None:
            print(f"[CAMERA {camera_id}] DETECTION EVENT CREATED (type={event_type})")

        if event_type in (EVENT_FIRE, EVENT_SMOKE):
            threading.Thread(
                target=_notify_fire,
                args=(customer_id, owner_user_id, event_type, camera_id, location),
                daemon=True,
                name=f"fire-notify-{new_id}",
            ).start()

        # WhatsApp AI Detection Alert — every writable event type (unlike
        # _notify_fire above, which is fire/smoke only), independent of
        # the in-app bell. See notifications/service.py's
        # deliver_ai_detection_alert for the recipient/gating decision.
        threading.Thread(
            target=_send_ai_detection_alert,
            args=(customer_id, event_type, camera_id, location, image_path),
            daemon=True,
            name=f"ai-alert-{new_id}",
        ).start()

        return new_id

    except Exception as e:
        log_exception(e, f"events.manager.record_detection (customer={customer_id}, event_type={event_type})")
        return None


def drop_recent_state(camera_id):
    """Called when a camera is genuinely DELETED — clears its in-memory
    dedup entries (same "only on delete, never on disable/restart" rule
    as detection/detector.py's drop_model). No-op if nothing matches
    (camera_id is None for the local-webcam pseudo-camera, which has no
    per-camera dedup rows worth pruning)."""

    if camera_id is None:
        return

    with _recent_lock:
        for key in [k for k in _recent if k[1] == camera_id]:
            _recent.pop(key, None)
