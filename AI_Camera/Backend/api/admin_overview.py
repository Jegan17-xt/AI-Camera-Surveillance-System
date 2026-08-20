"""Admin & User Overview — Super Admin's per-Company-Admin and per-User
storage/usage rollup. Every figure here is computed from real DB rows
and real files on disk at request time (the same measurement approach
as api/billing.py's get_storage_usage_gb), never hardcoded.

Registered Persons, Unknown Persons, and Reports each have a real,
discrete on-disk file (or folder) per record, attributable to exactly
one owner_user_id (or None = unassigned/company-pooled) — those three
categories are genuine per-user file measurements. Attendance's own
artifact (report_<date>.csv) is one file per date shared by every User
in the company, so a User's attendance figure is necessarily an
ESTIMATED proportional share of that one real, measured total (by
record-count share) — never presented as a discrete per-file number.
Cameras have no on-disk footprint of their own (live RTSP only, no
recording archive anywhere in this codebase) — they contribute a count,
never a fabricated byte figure.
"""

import os
import re
import time

from sqlalchemy import select, func

from db import get_session
from auth.models import User, RegisteredPerson, Attendance, UnknownPerson
from auth.database import (
    ROLE_COMPANY_ADMIN,
    MODULES,
    ALWAYS_ACTIVE_MODULE_KEYS,
    get_users_by_parent,
    get_user_module_keys,
    get_user_by_id,
)
from api.billing import get_storage_usage_gb
from api.cameras import get_camera_counts
from api.registered import faces_folder
from api.unknown import unknown_folder
from api.attendance import report_folder as attendance_report_folder
from api.subscriptions import get_subscription, set_storage_limit_gb as _set_storage_limit_gb
from api.camera_quota import get_admin_camera_summary, get_user_camera_summary
from auth.database import set_user_camera_limit as _set_user_camera_limit

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Sibling copy of reports/daily_report.py's own STORAGE_ROOT constant —
# same "each module defines its own private copy of this path" pattern
# api/billing.py's module docstring already documents for these exact
# roots. Kept independent so this module never has to import
# reports.daily_report (and, transitively, the WhatsApp delivery stack)
# just to know where PDFs live.
GENERATED_REPORTS_ROOT = os.path.join(BASE_DIR, "generated_reports", "customers")

# Matches reports/daily_report.py's own per-user filename convention
# exactly: f"daily_report_user{target_user_id}_{date_str}.pdf".
_REPORT_USER_FILE_RE = re.compile(r"^daily_report_user(\d+)_")

# --- Request-path CPU/IO fix: brief cache on the 4 breakdown walks below ---
# Each of _registered_person_breakdown/_unknown_person_breakdown/
# _attendance_breakdown/_report_breakdown does a real os.walk()/
# os.path.getsize() pass over this company's own on-disk files —
# previously recomputed from scratch on every single call to
# get_admin_overview_detail()/get_user_storage_detail(), even though
# both are called back-to-back for the SAME customer_id on one Admin &
# User Overview detail-page load, and opening that page again a moment
# later repeats all four walks again from nothing. Same short-TTL cache
# shape already established in this codebase for exactly this situation
# (api/billing.py's get_storage_usage_gb, itself already reused inside
# this module — see get_company_admin_summary below) — a 60s staleness
# window is already accepted there for the same class of "real disk
# usage, display-only" figure, so applying it here is consistent, not a
# new tolerance. Keyed per customer_id; every returned value is
# unchanged, only how often it's recomputed from disk.
_breakdown_cache = {}  # (func_name, customer_id) -> {"value": ..., "checked_at": float}
_BREAKDOWN_CACHE_TTL = 60


def _cached_breakdown(cache_key, compute_fn):

    now = time.time()
    cached = _breakdown_cache.get(cache_key)

    if cached is not None and now - cached["checked_at"] < _BREAKDOWN_CACHE_TTL:
        return cached["value"]

    value = compute_fn()
    _breakdown_cache[cache_key] = {"value": value, "checked_at": now}

    return value


def _generated_reports_folder(customer_id):
    return os.path.join(GENERATED_REPORTS_ROOT, str(customer_id))


def _dir_size_bytes(folder):

    if not os.path.isdir(folder):
        return 0

    total = 0
    for dirpath, _dirnames, filenames in os.walk(folder):
        for filename in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, filename))
            except OSError:
                pass  # deleted mid-walk / permissions blip — never fatal for a display number

    return total


def _file_size_bytes(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _gb(bytes_value):
    return round(bytes_value / (1024 ** 3), 4)


def _registered_person_breakdown(customer_id):
    return _cached_breakdown(
        ("registered_person_breakdown", customer_id), lambda: _registered_person_breakdown_uncached(customer_id)
    )


def _registered_person_breakdown_uncached(customer_id):
    """{owner_user_id_or_None: {"count", "bytes"}} — real file sizes
    summed per person's own face folder (api/registered.py's
    faces_folder), grouped by RegisteredPerson.owner_user_id."""

    with get_session() as session:
        rows = session.execute(
            select(RegisteredPerson.person_name, RegisteredPerson.owner_user_id)
            .where(RegisteredPerson.customer_id == customer_id)
        ).all()

    folder_root = faces_folder(customer_id)
    breakdown = {}

    for person_name, owner_user_id in rows:
        entry = breakdown.setdefault(owner_user_id, {"count": 0, "bytes": 0})
        entry["count"] += 1
        entry["bytes"] += _dir_size_bytes(os.path.join(folder_root, person_name))

    return breakdown


def _unknown_person_breakdown(customer_id):
    return _cached_breakdown(
        ("unknown_person_breakdown", customer_id), lambda: _unknown_person_breakdown_uncached(customer_id)
    )


def _unknown_person_breakdown_uncached(customer_id):
    """Same shape as above, from UnknownPerson.image_path/
    frame_image_path real file sizes under api/unknown.py's
    unknown_folder."""

    with get_session() as session:
        rows = session.execute(
            select(UnknownPerson.image_path, UnknownPerson.frame_image_path, UnknownPerson.owner_user_id)
            .where(UnknownPerson.customer_id == customer_id)
        ).all()

    folder = unknown_folder(customer_id)
    breakdown = {}

    for image_path, frame_image_path, owner_user_id in rows:
        row_bytes = 0
        if image_path:
            row_bytes += _file_size_bytes(os.path.join(folder, image_path))
        if frame_image_path:
            row_bytes += _file_size_bytes(os.path.join(folder, frame_image_path))

        entry = breakdown.setdefault(owner_user_id, {"count": 0, "bytes": 0})
        entry["count"] += 1
        entry["bytes"] += row_bytes

    return breakdown


def _attendance_breakdown(customer_id):
    return _cached_breakdown(
        ("attendance_breakdown", customer_id), lambda: _attendance_breakdown_uncached(customer_id)
    )


def _attendance_breakdown_uncached(customer_id):
    """Returns (counts_by_owner, total_count, total_bytes). Attendance
    records themselves are cheap to count exactly per owner (grouped
    SQL); the CSV artifact they're exported into is pooled per-date
    across the whole company, so only the COMPANY's total byte count is
    real/measured — per-user attendance storage is derived from this by
    the caller as a proportional share of total_count, never claimed as
    an exact per-file figure."""

    with get_session() as session:
        rows = session.execute(
            select(Attendance.owner_user_id, func.count())
            .where(Attendance.customer_id == customer_id)
            .group_by(Attendance.owner_user_id)
        ).all()

    counts = {owner_user_id: count for owner_user_id, count in rows}
    total_count = sum(counts.values())
    total_bytes = _dir_size_bytes(attendance_report_folder(customer_id))

    return counts, total_count, total_bytes


def _report_breakdown(customer_id):
    return _cached_breakdown(
        ("report_breakdown", customer_id), lambda: _report_breakdown_uncached(customer_id)
    )


def _report_breakdown_uncached(customer_id):
    """{owner_user_id_or_None: {"count", "bytes"}} from real PDF file
    sizes under generated_reports/customers/<cid>/. A personalized
    report's own filename (daily_report_user<uid>_<date>.pdf) attributes
    it directly to that User; every other file (the company-wide
    daily_report_<date>.pdf) buckets under None — company-pooled, same
    convention as an unassigned Camera/RegisteredPerson."""

    folder = _generated_reports_folder(customer_id)
    breakdown = {}

    if not os.path.isdir(folder):
        return breakdown

    for filename in os.listdir(folder):
        full_path = os.path.join(folder, filename)

        if not os.path.isfile(full_path):
            continue

        match = _REPORT_USER_FILE_RE.match(filename)
        owner_user_id = int(match.group(1)) if match else None

        entry = breakdown.setdefault(owner_user_id, {"count": 0, "bytes": 0})
        entry["count"] += 1
        entry["bytes"] += _file_size_bytes(full_path)

    return breakdown


def _modules_enabled(customer_id):
    granted = set(get_user_module_keys(customer_id))

    return [
        {"module_key": key, "module_label": label, "always_active": key in ALWAYS_ACTIVE_MODULE_KEYS}
        for key, label in MODULES
        if key in granted or key in ALWAYS_ACTIVE_MODULE_KEYS
    ]


def get_company_admin_summary(customer_id):
    """One Company Admin's rollup — cameras/users/registered persons,
    real storage used vs. Super-Admin-set limit, modules enabled. None
    if customer_id isn't a real Company Admin."""

    admin = get_user_by_id(customer_id)

    if admin is None or admin["role"] != ROLE_COMPANY_ADMIN:
        return None

    users = get_users_by_parent(customer_id)
    camera_count = get_camera_counts(customer_id)["total"]

    with get_session() as session:
        registered_persons_count = session.scalar(
            select(func.count()).select_from(RegisteredPerson).where(RegisteredPerson.customer_id == customer_id)
        ) or 0

    storage_used_gb = round(get_storage_usage_gb(customer_id), 4)
    storage_limit_gb = get_subscription(customer_id).get("storage_limit_gb")
    storage_remaining_gb = (
        round(storage_limit_gb - storage_used_gb, 4) if storage_limit_gb is not None else None
    )

    return {
        "customer_id": admin["id"],
        "name": admin["name"],
        "email": admin["email"],
        "username": admin["username"],
        "phone_number": admin.get("phone_number"),
        "status": admin["status"],
        "created_at": admin["created_at"],
        "camera_count": camera_count,
        "user_count": len(users),
        "registered_persons_count": registered_persons_count,
        "modules_enabled": _modules_enabled(customer_id),
        "storage_used_gb": storage_used_gb,
        "storage_limit_gb": storage_limit_gb,
        "storage_remaining_gb": storage_remaining_gb,
        # Camera Limit / Camera Quota Management — this Admin's own
        # Super-Admin-set cap vs. real camera counts (never cached), plus
        # how much of it they've allocated across their own Users. See
        # api/camera_quota.py — the same function backs this Admin's own
        # self-service view (pages/UserManagement.jsx) and the Super
        # Admin's view here, so the two can never disagree.
        "camera_quota": get_admin_camera_summary(customer_id),
    }


def list_admin_overview():
    """One row per Company Admin — the Admin & User Overview list page."""

    with get_session() as session:
        company_ids = session.scalars(
            select(User.id).where(User.role == ROLE_COMPANY_ADMIN).order_by(User.name)
        ).all()

    return [get_company_admin_summary(cid) for cid in company_ids]


def _user_storage_summary(customer_id, user_id, registered_map, unknown_map,
                           attendance_counts, attendance_total_count, attendance_total_bytes, report_map):

    registered = registered_map.get(user_id, {"count": 0, "bytes": 0})
    unknown = unknown_map.get(user_id, {"count": 0, "bytes": 0})
    report = report_map.get(user_id, {"count": 0, "bytes": 0})
    attendance_count = attendance_counts.get(user_id, 0)
    attendance_bytes = (
        attendance_total_bytes * (attendance_count / attendance_total_count)
        if attendance_total_count else 0
    )
    camera_count = get_camera_counts(customer_id, owner_user_id=user_id)["total"]

    total_bytes = registered["bytes"] + unknown["bytes"] + report["bytes"] + attendance_bytes

    return {
        "registered_persons": {"count": registered["count"], "gb": _gb(registered["bytes"])},
        "attendance": {
            "count": attendance_count,
            "gb_estimated": _gb(attendance_bytes),
            "note": (
                "Estimated — attendance reports are stored one CSV per date for the whole company, "
                "not one file per user. This is this user's proportional share (by record count) of "
                "that company's real, measured attendance storage."
            ),
        },
        "unknown_persons": {"count": unknown["count"], "gb": _gb(unknown["bytes"])},
        "cameras": {
            "count": camera_count,
            "note": "Cameras stream live only — nothing is recorded to disk, so this is a count, not storage.",
        },
        "reports": {"count": report["count"], "gb": _gb(report["bytes"])},
        "total_gb": _gb(total_bytes),
        # Camera Limit / Camera Quota Management — this User's own
        # Company-Admin-set cap vs. their real camera count. Separate
        # from "cameras" above (a storage-rollup field kept as-is for
        # backward compatibility) since this carries limit/remaining/
        # status, not just a count.
        "camera_quota": get_user_camera_summary(user_id),
    }


def get_admin_overview_detail(customer_id):
    """Admin summary plus every User under them, each with a storage
    breakdown, plus a company-wide per-category storage rollup. None if
    customer_id isn't a real Company Admin."""

    summary = get_company_admin_summary(customer_id)

    if summary is None:
        return None

    users = get_users_by_parent(customer_id)

    registered_map = _registered_person_breakdown(customer_id)
    unknown_map = _unknown_person_breakdown(customer_id)
    attendance_counts, attendance_total_count, attendance_total_bytes = _attendance_breakdown(customer_id)
    report_map = _report_breakdown(customer_id)

    user_rows = [
        {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "username": user["username"],
            "status": user["status"],
            **_user_storage_summary(
                customer_id, user["id"], registered_map, unknown_map,
                attendance_counts, attendance_total_count, attendance_total_bytes, report_map,
            ),
        }
        for user in users
    ]

    # Company-wide totals per storage category — summed across EVERY
    # owner_user_id in each breakdown map, including the None bucket
    # (unassigned/company-pooled items, e.g. a face registered directly
    # by the Company Admin, or the shared daily_report_<date>.pdf) that
    # user_rows above deliberately excludes since it isn't any one
    # User's own storage. Attendance here is the real measured company
    # total, not a per-user estimated share.
    storage_breakdown = {
        "registered_persons": {
            "count": sum(v["count"] for v in registered_map.values()),
            "gb": _gb(sum(v["bytes"] for v in registered_map.values())),
        },
        "attendance": {"count": attendance_total_count, "gb": _gb(attendance_total_bytes)},
        "unknown_persons": {
            "count": sum(v["count"] for v in unknown_map.values()),
            "gb": _gb(sum(v["bytes"] for v in unknown_map.values())),
        },
        "reports": {
            "count": sum(v["count"] for v in report_map.values()),
            "gb": _gb(sum(v["bytes"] for v in report_map.values())),
        },
    }

    return {**summary, "users": user_rows, "storage_breakdown": storage_breakdown}


def get_user_storage_detail(customer_id, user_id):
    """Full category breakdown for one User — ownership-checked against
    get_users_by_parent(customer_id), same guard shape as
    api/company_users.py's _owned_user. None if the User doesn't exist
    or doesn't belong to this Company Admin."""

    users = get_users_by_parent(customer_id)
    user = next((u for u in users if u["id"] == user_id), None)

    if user is None:
        return None

    registered_map = _registered_person_breakdown(customer_id)
    unknown_map = _unknown_person_breakdown(customer_id)
    attendance_counts, attendance_total_count, attendance_total_bytes = _attendance_breakdown(customer_id)
    report_map = _report_breakdown(customer_id)

    stats = _user_storage_summary(
        customer_id, user_id, registered_map, unknown_map,
        attendance_counts, attendance_total_count, attendance_total_bytes, report_map,
    )

    with get_session() as session:
        person_rows = session.execute(
            select(RegisteredPerson.person_name, RegisteredPerson.employee_id, RegisteredPerson.status)
            .where(RegisteredPerson.customer_id == customer_id, RegisteredPerson.owner_user_id == user_id)
            .order_by(RegisteredPerson.person_name)
        ).all()

    folder_root = faces_folder(customer_id)
    registered_persons_list = [
        {
            "person_name": name,
            "employee_id": employee_id,
            "status": status,
            "gb": _gb(_dir_size_bytes(os.path.join(folder_root, name))),
        }
        for name, employee_id, status in person_rows
    ]

    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "username": user["username"],
        "status": user["status"],
        "created_at": user["created_at"],
        **stats,
        "registered_persons_list": registered_persons_list,
    }


def set_company_storage_limit(customer_id, storage_limit_gb):
    """Super Admin sets (or clears, with None) this company's real
    storage cap."""

    admin = get_user_by_id(customer_id)

    if admin is None or admin["role"] != ROLE_COMPANY_ADMIN:
        return None, "Company not found."

    _subscription, error = _set_storage_limit_gb(customer_id, storage_limit_gb)

    if error:
        return None, error

    return get_company_admin_summary(customer_id), None


def set_admin_camera_limit(customer_id, camera_limit):
    """Super Admin sets (or clears, with None) this Company Admin's
    camera cap. Unlike a User's own camera_limit (see
    api/company_users.py's set_user_camera_limit), there is no
    "grandparent" budget above a Company Admin to validate against —
    Super Admin has unconstrained authority here, same as
    set_company_storage_limit above. Reducing this below the Admin's
    current actual usage (or below the sum of what they've already
    allocated to their own Users) is always allowed and never deletes
    anything — see camera_quota.py's module docstring for the "Over
    Limit" rule this then surfaces everywhere that Admin's/their Users'
    quota is displayed."""

    admin = get_user_by_id(customer_id)

    if admin is None or admin["role"] != ROLE_COMPANY_ADMIN:
        return None, "Company not found."

    if camera_limit is not None:
        if not isinstance(camera_limit, int) or isinstance(camera_limit, bool) or camera_limit < 0:
            return None, "Camera limit must be a whole number of 0 or more."

    if not _set_user_camera_limit(customer_id, camera_limit):
        return None, "Company not found."

    return get_company_admin_summary(customer_id), None
