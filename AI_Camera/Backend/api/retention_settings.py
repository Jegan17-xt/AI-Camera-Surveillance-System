"""Admin & User Overview > Data Retention — Super-Admin-only, per-Company-
Admin policy controlling how long CAPTURED/GENERATED data (Unknown
Person detections, generated Daily Report PDFs, generated Attendance
CSV exports) is kept before retention/scheduler.py's daily sweep
deletes it. Never covers Registered Person enrollment faces, the
Attendance check-in/check-out table, Users/permissions/modules/billing,
or the Company Admin account itself — see auth/models.py's
RetentionSettings docstring and the three delete_*_older_than()
functions this module's scheduler calls (api/unknown.py,
api/attendance.py, reports/daily_report.py).

Same lazy-provisioning + short TTL-cache shape as
api/notification_settings.py — customer_id is the table's primary key
(one row per company), and a company with no row yet is exactly
equivalent to an explicit "permanent" row (never fabricated except on
first write), so it's never mistaken for missing/broken data.
"""

import time
from datetime import datetime

from sqlalchemy import select

from db import get_session
from auth.models import RetentionSettings

VALID_POLICIES = ("permanent", "7_days", "1_month")

# None = automatic deletion fully disabled ("Permanent / Manual Delete").
RETENTION_DAYS = {"permanent": None, "7_days": 7, "1_month": 30}

DEFAULT_POLICY = "permanent"

_cache = {}
_CACHE_TTL = 3


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def init_retention_tables():
    """No migration needed — retention_settings is a brand-new table,
    created directly by auth.database.init_db()'s Base.metadata.
    create_all(). Kept as a function purely so api/app.py's startup
    sequence reads the same as every other init_*_table() call site."""


def _row_to_dict(row):
    return {
        "customer_id": row.customer_id,
        "policy": row.policy,
        "retention_days": RETENTION_DAYS[row.policy],
        "updated_at": row.updated_at,
    }


def _fetch_or_create(session, customer_id):
    row = session.get(RetentionSettings, customer_id)

    if row is None:
        now = _now()
        row = RetentionSettings(customer_id=customer_id, policy=DEFAULT_POLICY, created_at=now, updated_at=now)
        session.add(row)
        session.flush()

    return row


def get_retention_settings(customer_id):

    cached = _cache.get(customer_id)
    now = time.time()

    if cached is not None and now - cached["checked_at"] < _CACHE_TTL:
        return cached["data"]

    with get_session() as session:
        row = _fetch_or_create(session, customer_id)
        data = _row_to_dict(row)

    _cache[customer_id] = {"data": data, "checked_at": now}

    return data


def update_retention_settings(customer_id, policy):

    if policy not in VALID_POLICIES:
        return None, f"Policy must be one of: {', '.join(VALID_POLICIES)}."

    with get_session() as session:
        row = _fetch_or_create(session, customer_id)
        row.policy = policy
        row.updated_at = _now()
        data = _row_to_dict(row)

    _cache.pop(customer_id, None)

    return data, None


def get_all_retention_policies():
    """{customer_id: policy} for every company with an EXPLICIT row —
    retention/scheduler.py's own per-tick lookup, which treats any
    customer_id missing from this dict as DEFAULT_POLICY ("permanent",
    i.e. skip). Deliberately bypasses the per-request TTL cache above
    (a background sweep reading a few seconds stale is fine; the cache
    itself is irrelevant here since this is one query for every
    company, not a per-customer_id lookup)."""

    with get_session() as session:
        rows = session.scalars(select(RetentionSettings)).all()
        return {row.customer_id: row.policy for row in rows}
