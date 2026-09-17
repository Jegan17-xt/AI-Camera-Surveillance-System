import os
import json
import hashlib
from datetime import datetime

from sqlalchemy import select, func

from db import get_session
from auth.models import Attendance, UnknownPerson, RegisteredPerson
from auth.database import get_users_by_parent
from api.registered import get_registered_persons
from api.cameras import get_camera_counts, get_camera_counts_by_owner
from api.scope import apply_owner_scope

# Base Path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Dismissed-activity bookkeeping is per customer too — Customer B
# dismissing an event from their own Recent Activity feed must never
# affect what Customer A sees (or vice versa).
CUSTOMERS_ROOT = os.path.join(BASE_DIR, "dataset", "customers")

RECENT_ACTIVITY_LIMIT = 20
TIMESTAMP_FORMAT = "%d-%m-%Y %H:%M:%S"


def dismissed_activity_file(customer_id, owner_user_id=None):
    """Per-User Data Isolation: the Admin's own aggregate "All Users"
    view (owner_user_id=None) keeps using the exact same filename as
    before this feature — zero behavior change there. A specific
    User/Unassigned scope gets its own suffixed file, so dismissing an
    event in one scope never hides it from another scope's feed."""

    if owner_user_id is None:
        return os.path.join(CUSTOMERS_ROOT, str(customer_id), "dismissed_activity.json")

    suffix = "unassigned" if owner_user_id == "unassigned" else str(owner_user_id)
    return os.path.join(CUSTOMERS_ROOT, str(customer_id), f"dismissed_activity_user_{suffix}.json")


def _parse_timestamp(date_str, time_str):

    try:
        return datetime.strptime(f"{date_str} {time_str}", TIMESTAMP_FORMAT)
    except (ValueError, TypeError):
        return None


def _unique_unknown_ids_today(customer_id, owner_user_id=None):
    """The ids of every unknown person FIRST seen TODAY, for this
    customer only — the Dashboard's "Unknown Persons" card is a live,
    resets-at-midnight counter (explicitly: today's detections are 5 ->
    card shows 5; tomorrow it starts back at 0), not the all-time total
    the Unknown Persons PAGE shows — those are two intentionally
    different numbers now. Scoped by owner_user_id exactly like every
    other per-user-isolated query here. A row is only ever created on a
    brand-new unknown person's first sighting (face/unknown_manager.py's
    save_unknown) — a re-detection of an already-known unknown person
    just updates that same row's last_seen/detection_count, never
    creates a new one — so each UnknownPerson row already represents one
    unique person; no dedup needed here the way the old id-reused-after-
    delete CSV bug required. Nothing is ever deleted by this query or
    its caller — it only narrows which existing rows are counted."""

    today = datetime.now().strftime("%d-%m-%Y")

    with get_session() as session:
        query = select(UnknownPerson.id).where(
            UnknownPerson.customer_id == customer_id,
            UnknownPerson.detected_time.like(f"{today}%"),
        )
        query = apply_owner_scope(query, UnknownPerson.owner_user_id, owner_user_id)
        ids = session.scalars(query).all()

    return set(ids)


def _event_id(event_type, detail, timestamp):
    """A stable id for a derived activity event, computed from its own
    content rather than assigned/stored anywhere — Recent Activity has
    no table of its own (it's computed fresh from this customer's
    attendance.csv / unknown_log.csv on every request), so "deleting" an
    event can't mean deleting a database row. It means remembering this
    id as dismissed."""

    raw = f"{event_type}|{detail}|{timestamp.strftime(TIMESTAMP_FORMAT)}"
    return hashlib.md5(raw.encode()).hexdigest()[:12]


def _load_dismissed_activity(customer_id, owner_user_id=None):

    path = dismissed_activity_file(customer_id, owner_user_id)

    if not os.path.exists(path):
        return {"dismissed_ids": [], "cleared_before": None}

    try:
        with open(path, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"dismissed_ids": [], "cleared_before": None}

    data.setdefault("dismissed_ids", [])
    data.setdefault("cleared_before", None)
    return data


def _save_dismissed_activity(customer_id, data, owner_user_id=None):

    path = dismissed_activity_file(customer_id, owner_user_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    with open(path, "w") as f:
        json.dump(data, f)


def dismiss_activity_event(customer_id, event_id, owner_user_id=None):
    """Removes a single event from this customer's Recent Activity only.
    Never touches attendance.csv or the unknown-person records/files it
    was derived from — this is purely a "hide this from the feed"
    marker."""

    data = _load_dismissed_activity(customer_id, owner_user_id)

    if event_id not in data["dismissed_ids"]:
        data["dismissed_ids"].append(event_id)

    _save_dismissed_activity(customer_id, data, owner_user_id)


def clear_all_activity_events(customer_id, owner_user_id=None):
    """Hides every event currently visible in this customer's Recent
    Activity. New events (a future attendance entry or unknown
    detection) still show up afterward — this only moves the cutoff
    forward in time, it does not touch the underlying attendance/
    unknown-person data."""

    data = _load_dismissed_activity(customer_id, owner_user_id)
    data["cleared_before"] = datetime.now().strftime(TIMESTAMP_FORMAT)
    _save_dismissed_activity(customer_id, data, owner_user_id)


def get_recent_activity(customer_id, limit=RECENT_ACTIVITY_LIMIT, owner_user_id=None):
    """Real events only for this customer, merged from their own actual
    Attendance and UnknownPerson rows — no fabricated event types.
    "Person Exited" and "Camera Online/Offline" are intentionally absent:
    check_out is a last-seen timestamp (rewritten on every re-detection),
    not a true exit signal, and no camera process reports online/offline
    status anywhere in this system yet.

    Each unknown person produces at most ONE event — a UnknownPerson row
    already represents exactly one unique person's first sighting (see
    _unique_unknown_ids_today), so no further per-id dedup is needed the
    way the old CSV log (which could accumulate repeat rows for the same
    person under the pre-fix id-reuse bug) required."""

    events = []

    with get_session() as session:

        attendance_query = (
            select(Attendance.check_in, RegisteredPerson.person_name)
            .join(RegisteredPerson, RegisteredPerson.id == Attendance.person_id)
            .where(Attendance.customer_id == customer_id, Attendance.check_in.is_not(None))
        )
        attendance_query = apply_owner_scope(attendance_query, Attendance.owner_user_id, owner_user_id)
        attendance_rows = session.execute(attendance_query).all()

        unknown_query = select(UnknownPerson).where(UnknownPerson.customer_id == customer_id)
        unknown_query = apply_owner_scope(unknown_query, UnknownPerson.owner_user_id, owner_user_id)
        unknown_rows = session.scalars(unknown_query).all()

        for check_in, person_name in attendance_rows:
            events.append({
                "type": "person-entered",
                "name": "Person Entered",
                "detail": person_name,
                "timestamp": check_in,
            })

        for row in unknown_rows:

            try:
                timestamp = datetime.strptime(row.detected_time, TIMESTAMP_FORMAT)
            except (ValueError, TypeError):
                continue

            events.append({
                "type": "unknown-detected",
                "name": "Unknown Person Detected",
                "detail": f"Unknown ID {row.id}",
                "timestamp": timestamp,
            })

    # Multi-Object & Fire Detection — vehicle/animal/bird/fire/smoke
    # events merged into the same feed (person/unknown already have their
    # entries above). Lazy import: keeps api/dashboard.py free of a
    # module-load-time dependency on api/detection_events.py. Only the
    # GENERIC category name is shown — never the specific COCO class
    # (no "Dog Detected" / "Car Detected").
    try:
        from api.detection_events import get_recent_detection_events_for_activity

        _EVENT_META = {
            "CAR_DETECTED": ("vehicle-detected", "Vehicle Detected"),
            "ANIMAL_DETECTED": ("animal-detected", "Animal Detected"),
            "BIRD_DETECTED": ("bird-detected", "Bird Detected"),
            "FIRE_DETECTED": ("fire-detected", "Fire Detected"),
            "SMOKE_DETECTED": ("smoke-detected", "Smoke Detected"),
        }

        for row in get_recent_detection_events_for_activity(customer_id, owner_user_id=owner_user_id):
            try:
                timestamp = datetime.strptime(row["detected_time"], TIMESTAMP_FORMAT)
            except (ValueError, TypeError):
                continue

            feed_type, feed_name = _EVENT_META.get(row["event_type"], ("detection-event", "Detection Event"))
            events.append({
                "type": feed_type,
                "name": feed_name,
                # No object_type here on purpose — the category (feed_name)
                # is the only user-facing label. camera location if known,
                # else blank.
                "detail": row.get("location") or "",
                "timestamp": timestamp,
            })
    except Exception:
        pass  # a feed-merge hiccup must never blank the whole dashboard

    events.sort(key=lambda e: e["timestamp"], reverse=True)

    dismissed = _load_dismissed_activity(customer_id, owner_user_id)
    dismissed_ids = set(dismissed["dismissed_ids"])

    cleared_before = None
    if dismissed["cleared_before"]:
        cleared_before = datetime.strptime(dismissed["cleared_before"], TIMESTAMP_FORMAT)

    visible = []

    for e in events:

        if cleared_before and e["timestamp"] <= cleared_before:
            continue

        event_id = _event_id(e["type"], e["detail"], e["timestamp"])

        if event_id in dismissed_ids:
            continue

        visible.append({
            "id": event_id,
            "type": e["type"],
            "name": e["name"],
            "detail": e["detail"],
            "date": e["timestamp"].strftime("%d-%m-%Y"),
            "time": e["timestamp"].strftime("%I:%M %p"),
        })

        if len(visible) >= limit:
            break

    return visible


def _present_today_count(customer_id, owner_user_id=None):
    """How many of this customer's attendance rows are marked Present for
    today's date. Shared by the per-customer dashboard below and the
    Super Admin Dashboard's platform-wide total (api/admin_dashboard.py),
    so both are always counting the exact same way."""

    today = datetime.now().date()

    with get_session() as session:
        query = (
            select(func.count())
            .select_from(Attendance)
            .where(
                Attendance.customer_id == customer_id,
                Attendance.attendance_date == today,
                Attendance.attendance_status == "Present",
            )
        )
        query = apply_owner_scope(query, Attendance.owner_user_id, owner_user_id)
        present = session.scalar(query)

    return present or 0


def get_dashboard_data(customer_id, owner_user_id=None):

    # Registered Persons — reuses the exact same function the Registered
    # Persons page calls, so this card can never disagree with what that
    # page actually shows.
    _, registered = get_registered_persons(customer_id, owner_user_id=owner_user_id)

    present = _present_today_count(customer_id, owner_user_id)
    absent = max(registered - present, 0)

    # Unknown Persons — today's unique people only (resets at midnight),
    # not the Unknown Persons page's all-time total, and not raw log rows.
    unknown = len(_unique_unknown_ids_today(customer_id, owner_user_id))

    # Cameras Online — real counts from this customer's own rows in the
    # `cameras` table (see api/cameras.py get_camera_counts), never a
    # fabricated/static number.
    camera_counts = get_camera_counts(customer_id, owner_user_id)

    # Attendance Rate = (Present / Registered) * 100. Registered = 0 has
    # no meaningful rate (nobody to be present or absent against) — 0%
    # rather than a division-by-zero error or a misleading 100%.
    attendance_rate = round((present / registered) * 100) if registered > 0 else 0

    # Multi-Object & Fire Detection — today's per-type counts for the new
    # dashboard cards. Isolated so a stats failure never blanks the rest
    # of the dashboard.
    detection_stats = {}
    try:
        from api.detection_events import get_detection_event_stats
        detection_stats = get_detection_event_stats(customer_id, owner_user_id=owner_user_id)
    except Exception:
        detection_stats = {}

    return {
        "registered": registered,
        "present": present,
        "absent": absent,
        "unknown": unknown,
        "cameras_online": camera_counts["online"],
        "cameras_total": camera_counts["total"],
        "attendance_rate": attendance_rate,
        "vehicles_today": detection_stats.get("vehicles", 0),
        "animals_today": detection_stats.get("animals", 0),
        "birds_today": detection_stats.get("birds", 0),
        "fire_events_today": detection_stats.get("fire", 0),
        "recent_activity": get_recent_activity(customer_id, owner_user_id=owner_user_id),
    }


def get_admin_user_camera_overview(customer_id):
    """Admin Dashboard's "User & Camera Overview" section — Total/Active
    Users, Total/Online/Offline Cameras, and a per-User camera
    breakdown, computed fresh from the same `users`/`cameras` tables and
    the same owner_user_id assignment every other per-user-isolated
    feature here already uses (see api/scope.py). Nothing here is
    hardcoded or duplicated: get_users_by_parent is the exact same query
    User Management's own list uses, and get_camera_counts_by_owner
    reads Camera.owner_user_id directly — so a camera add/remove/
    reassignment or a User add/remove/status change is reflected the
    very next time this is called, with no cache to go stale.

    Company-Admin-only by construction of its one caller (api/routes.py's
    /dashboard/user-camera-overview, gated by company_admin_required) —
    a User account has no sub-users to show an overview of, and
    `customer_id` here is always that Admin's own tenant id, never a
    specific User's owner_user_id scope."""

    users = get_users_by_parent(customer_id)
    camera_counts_by_owner = get_camera_counts_by_owner(customer_id)

    # This Admin's own camera totals — every camera under this tenant,
    # assigned or not, the exact same {"online", "total"} the Dashboard's
    # own "Cameras Online" stat card already uses (get_camera_counts with
    # owner_user_id=None, today's "All Users" aggregate).
    camera_totals = get_camera_counts(customer_id)
    total_cameras = camera_totals["total"]
    online_cameras = camera_totals["online"]
    offline_cameras = total_cameras - online_cameras

    user_summaries = []
    for u in users:
        counts = camera_counts_by_owner.get(u["id"], {"online": 0, "offline": 0, "total": 0})
        user_summaries.append({
            "id": u["id"],
            "name": u["name"],
            "email": u["email"],
            "status": u["status"],
            "assigned_cameras": counts["total"],
            "online_cameras": counts["online"],
            "offline_cameras": counts["offline"],
        })

    return {
        "total_users": len(users),
        "active_users": sum(1 for u in users if u["status"] == "Active"),
        "total_cameras": total_cameras,
        "online_cameras": online_cameras,
        "offline_cameras": offline_cameras,
        "users": user_summaries,
    }
