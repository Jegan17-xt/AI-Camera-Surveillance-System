"""Detection Events — the unified read/write API for every non-attendance
detection the AI pipeline produces.

Source of truth:
  - CAR_DETECTED / ANIMAL_DETECTED / FIRE_DETECTED / SMOKE_DETECTED live
    in the `detection_events` table (written by events/manager.py).
  - PERSON_DETECTED and UNKNOWN_FACE are MERGED IN at read time from the
    existing `attendance` and `unknown_persons` tables — they already own
    that data, so this module never writes a duplicate row for them (same
    "merge several real sources" pattern api/dashboard.py's
    get_recent_activity already uses).

Every query is scoped by customer_id + owner_user_id (api/scope.py's
apply_owner_scope) exactly like api/unknown.py / api/attendance.py.
"""

import os
from datetime import datetime

from sqlalchemy import select, func, text

from db import get_session, engine
from auth.models import DetectionEvent, UnknownPerson, Attendance, RegisteredPerson, Camera
from api.scope import apply_owner_scope
from events.manager import ALL_EVENT_TYPES, WRITABLE_EVENT_TYPES

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CUSTOMERS_ROOT = os.path.join(BASE_DIR, "dataset", "customers")

_TS_FMT = "%d-%m-%Y %H:%M:%S"

EVENT_PERSON = "PERSON_DETECTED"
EVENT_UNKNOWN = "UNKNOWN_FACE"


def init_detection_events_table():
    """The `detection_events` table itself is created by
    Base.metadata.create_all() in auth.database.init_db() (brand-new
    table, same as `notifications`). This function only exists so the
    api/app.py startup sequence reads uniformly (every other feature has
    an init_*_table()), and as the home for any future additive column
    migration — mirrors api/retention_settings.py's init_retention_tables().
    Idempotent, safe on every boot."""

    with engine.connect() as conn:
        existing = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'detection_events'"
                )
            )
        }
        for name, cols in (
            ("ix_detection_events_customer_created", "(customer_id, created_at)"),
            ("ix_detection_events_customer_type", "(customer_id, event_type)"),
        ):
            if name not in existing:
                conn.execute(text(f"ALTER TABLE detection_events ADD INDEX {name} {cols}"))
        conn.commit()


def detection_events_folder(customer_id):
    return os.path.join(CUSTOMERS_ROOT, str(customer_id), "events")


def _customer_root(customer_id):
    return os.path.join(CUSTOMERS_ROOT, str(customer_id))


def _unknown_folder(customer_id):
    return os.path.join(_customer_root(customer_id), "unknown")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _parse_ts(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.strptime(str(value), _TS_FMT)
    except (TypeError, ValueError):
        return None


def _normalize_types(event_types):
    """A caller-supplied CSV / list of event types -> a clean tuple of
    recognized ones, or None (meaning 'all')."""

    if not event_types:
        return None

    if isinstance(event_types, str):
        event_types = [t.strip() for t in event_types.split(",")]

    wanted = tuple(t for t in event_types if t in ALL_EVENT_TYPES)
    return wanted or None


def _camera_names(session, customer_id):
    rows = session.execute(
        select(Camera.camera_id, Camera.camera_name).where(Camera.customer_id == customer_id)
    ).all()
    return {cid: name for cid, name in rows}


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
def get_detection_events(
    customer_id,
    owner_user_id=None,
    *,
    event_types=None,
    camera_id=None,
    limit=None,
    offset=None,
):
    """Returns (events, total). `events` is the merged, newest-first list
    of unified event dicts. `total` is the full merged count before
    paging."""

    wanted_types = _normalize_types(event_types)
    want = lambda t: wanted_types is None or t in wanted_types  # noqa: E731

    merged = []

    with get_session() as session:
        cam_names = _camera_names(session, customer_id)

        # --- detection_events table (vehicles / animals / fire / smoke) ---
        if wanted_types is None or any(t in WRITABLE_EVENT_TYPES for t in wanted_types):
            q = select(DetectionEvent).where(DetectionEvent.customer_id == customer_id)
            q = apply_owner_scope(q, DetectionEvent.owner_user_id, owner_user_id)
            if wanted_types is not None:
                q = q.where(DetectionEvent.event_type.in_(wanted_types))
            if camera_id is not None:
                q = q.where(DetectionEvent.camera_id == camera_id)

            for row in session.scalars(q).all():
                merged.append({
                    "event_id": f"evt-{row.id}",
                    "raw_id": row.id,
                    "source": "detection_event",
                    "event_type": row.event_type,
                    "object_type": row.object_type,
                    "person_name": row.person_name,
                    "confidence": row.confidence,
                    "image_url": (
                        f"http://localhost:5000/detection-events/image/{customer_id}/{row.image_path}"
                        if row.image_path else None
                    ),
                    "camera_id": row.camera_id,
                    "camera_name": cam_names.get(row.camera_id),
                    "location": row.location,
                    "detection_count": row.detection_count,
                    "status": row.status,
                    "_ts": _parse_ts(row.detected_time),
                    "first_seen": row.detected_time,
                    "last_seen": row.last_seen,
                })

        # --- PERSON_DETECTED merged from attendance ---
        if want(EVENT_PERSON):
            pq = (
                select(Attendance, RegisteredPerson.person_name)
                .join(RegisteredPerson, RegisteredPerson.id == Attendance.person_id)
                .where(Attendance.customer_id == customer_id, Attendance.check_in.is_not(None))
            )
            pq = apply_owner_scope(pq, Attendance.owner_user_id, owner_user_id)
            if camera_id is not None:
                pq = pq.where(Attendance.camera_id == camera_id)

            for att, person_name in session.execute(pq).all():
                merged.append({
                    "event_id": f"att-{att.id}",
                    "raw_id": att.id,
                    "source": "attendance",
                    "event_type": EVENT_PERSON,
                    "object_type": "person",
                    "person_name": person_name,
                    "confidence": None,
                    "image_url": None,
                    "camera_id": att.camera_id,
                    "camera_name": cam_names.get(att.camera_id),
                    "location": None,
                    "detection_count": 1,
                    "status": att.attendance_status,
                    "_ts": _parse_ts(att.check_in),
                    "first_seen": att.check_in.strftime(_TS_FMT) if att.check_in else None,
                    "last_seen": att.check_out.strftime(_TS_FMT) if att.check_out else None,
                })

        # --- UNKNOWN_FACE merged from unknown_persons ---
        if want(EVENT_UNKNOWN):
            uq = select(UnknownPerson).where(UnknownPerson.customer_id == customer_id)
            uq = apply_owner_scope(uq, UnknownPerson.owner_user_id, owner_user_id)
            if camera_id is not None:
                uq = uq.where(UnknownPerson.camera_id == camera_id)

            for row in session.scalars(uq).all():
                merged.append({
                    "event_id": f"unk-{row.id}",
                    "raw_id": row.id,
                    "source": "unknown_person",
                    "event_type": EVENT_UNKNOWN,
                    "object_type": "face",
                    "person_name": None,
                    "confidence": row.confidence,
                    "image_url": (
                        f"http://localhost:5000/unknown/{row.image_path}" if row.image_path else None
                    ),
                    "camera_id": row.camera_id,
                    "camera_name": cam_names.get(row.camera_id),
                    "location": row.location,
                    "detection_count": row.detection_count,
                    "status": "Unknown",
                    "_ts": _parse_ts(row.detected_time),
                    "first_seen": row.detected_time,
                    "last_seen": row.last_seen,
                })

    merged.sort(key=lambda e: e["_ts"] or datetime.min, reverse=True)
    total = len(merged)

    if offset is not None:
        merged = merged[offset:]
    if limit is not None:
        merged = merged[:limit]

    for e in merged:
        ts = e.pop("_ts")
        e["date"] = ts.strftime("%d-%m-%Y") if ts else None
        e["time"] = ts.strftime("%I:%M %p") if ts else None
        e["timestamp"] = ts.strftime(_TS_FMT) if ts else None

    return merged, total


def get_detection_event_stats(customer_id, owner_user_id=None):
    """Today's count per event type — powers the Dashboard cards. Cheap
    aggregate queries, no row hydration."""

    today = datetime.now().strftime("%d-%m-%Y")
    today_date = datetime.now().date()
    stats = {t: 0 for t in ALL_EVENT_TYPES}

    with get_session() as session:
        q = (
            select(DetectionEvent.event_type, func.count())
            .where(
                DetectionEvent.customer_id == customer_id,
                DetectionEvent.detected_time.like(f"{today}%"),
            )
            .group_by(DetectionEvent.event_type)
        )
        q = apply_owner_scope(q, DetectionEvent.owner_user_id, owner_user_id)
        for event_type, count in session.execute(q).all():
            stats[event_type] = count or 0

        uq = select(func.count()).select_from(UnknownPerson).where(
            UnknownPerson.customer_id == customer_id,
            UnknownPerson.detected_time.like(f"{today}%"),
        )
        uq = apply_owner_scope(uq, UnknownPerson.owner_user_id, owner_user_id)
        stats[EVENT_UNKNOWN] = session.scalar(uq) or 0

        pq = select(func.count()).select_from(Attendance).where(
            Attendance.customer_id == customer_id,
            Attendance.attendance_date == today_date,
            Attendance.check_in.is_not(None),
        )
        pq = apply_owner_scope(pq, Attendance.owner_user_id, owner_user_id)
        stats[EVENT_PERSON] = session.scalar(pq) or 0

    stats["vehicles"] = stats.get("CAR_DETECTED", 0)
    stats["animals"] = stats.get("ANIMAL_DETECTED", 0)
    stats["birds"] = stats.get("BIRD_DETECTED", 0)
    stats["fire"] = stats.get("FIRE_DETECTED", 0) + stats.get("SMOKE_DETECTED", 0)
    return stats


# ---------------------------------------------------------------------------
# Image serving
# ---------------------------------------------------------------------------
def event_image_owner_ok(customer_id, relpath, owner_user_id=None):
    """Existence + ownership gate for a fire/smoke snapshot, mirrors
    api/unknown.py's unknown_image_owner_ok."""

    with get_session() as session:
        q = select(DetectionEvent.id).where(
            DetectionEvent.customer_id == customer_id,
            DetectionEvent.image_path == relpath,
        )
        q = apply_owner_scope(q, DetectionEvent.owner_user_id, owner_user_id)
        return session.scalar(q) is not None


# ---------------------------------------------------------------------------
# Delete (mirrors api/unknown.py)
# ---------------------------------------------------------------------------
def _remove_event_file(customer_id, image_path):
    if not image_path:
        return
    path = os.path.join(detection_events_folder(customer_id), image_path)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


def _parse_event_id(event_id):
    """Accepts a bare int id or the "evt-<id>" form the list endpoint
    returns for detection_events rows. Attendance/unknown-sourced events
    are not deletable here (they belong to their own pages)."""

    text_id = str(event_id).strip()
    if text_id.lower().startswith("evt-"):
        text_id = text_id[4:]
    try:
        return int(text_id)
    except (TypeError, ValueError):
        return None


def delete_detection_event(customer_id, event_id, owner_user_id=None):
    target_id = _parse_event_id(event_id)
    if target_id is None:
        return False

    with get_session() as session:
        q = select(DetectionEvent).where(
            DetectionEvent.id == target_id, DetectionEvent.customer_id == customer_id
        )
        q = apply_owner_scope(q, DetectionEvent.owner_user_id, owner_user_id)
        row = session.scalar(q)
        if row is None:
            return False
        _remove_event_file(customer_id, row.image_path)
        session.delete(row)
    return True


def delete_multiple_detection_events(customer_id, event_ids, owner_user_id=None):
    target_ids = {_parse_event_id(i) for i in (event_ids or [])}
    target_ids.discard(None)
    if not target_ids:
        return 0

    with get_session() as session:
        q = select(DetectionEvent).where(
            DetectionEvent.id.in_(target_ids), DetectionEvent.customer_id == customer_id
        )
        q = apply_owner_scope(q, DetectionEvent.owner_user_id, owner_user_id)
        rows = session.scalars(q).all()
        for row in rows:
            _remove_event_file(customer_id, row.image_path)
            session.delete(row)
        return len(rows)


def delete_all_detection_events(customer_id, owner_user_id=None):
    with get_session() as session:
        q = select(DetectionEvent).where(DetectionEvent.customer_id == customer_id)
        q = apply_owner_scope(q, DetectionEvent.owner_user_id, owner_user_id)
        rows = session.scalars(q).all()
        for row in rows:
            _remove_event_file(customer_id, row.image_path)
            session.delete(row)
        return len(rows)


def delete_detection_events_older_than(customer_id, cutoff_dt):
    """Data Retention sweep (retention/scheduler.py) — deletes every
    DetectionEvent row (+ its snapshot file) for this customer whose
    detected_time is strictly older than cutoff_dt. Same string-parse-in-
    Python approach as api/unknown.delete_unknown_persons_older_than
    (detected_time is a "%d-%m-%Y %H:%M:%S" string, not lexically
    sortable)."""

    deleted = 0
    with get_session() as session:
        rows = session.scalars(
            select(DetectionEvent).where(DetectionEvent.customer_id == customer_id)
        ).all()
        for row in rows:
            ts = _parse_ts(row.detected_time)
            if ts is None:
                continue
            if ts < cutoff_dt:
                _remove_event_file(customer_id, row.image_path)
                session.delete(row)
                deleted += 1
    return deleted


def get_recent_detection_events_for_activity(customer_id, owner_user_id=None, limit=40):
    """Just the detection_events rows (vehicle/animal/bird/fire/smoke),
    newest-first, for api/dashboard.py's Recent Activity merge — person/
    unknown already have their own entries in that feed."""

    with get_session() as session:
        q = select(DetectionEvent).where(DetectionEvent.customer_id == customer_id)
        q = apply_owner_scope(q, DetectionEvent.owner_user_id, owner_user_id)
        q = q.order_by(DetectionEvent.id.desc()).limit(limit)
        return [
            {
                "id": r.id,
                "event_type": r.event_type,
                "object_type": r.object_type,
                "location": r.location,
                "detected_time": r.detected_time,
            }
            for r in session.scalars(q).all()
        ]
