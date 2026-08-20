"""Read-only aggregation for the Company Admin's "Unknown Person
Analytics" page — daily and monthly NEW-unknown-person counts.

Deliberately does not touch face/unknown_manager.py's detection/matching
logic at all; it only reads the unknown_persons table that logic already
writes, relying entirely on the dedup guarantee already enforced there
(see save_unknown/_find_best_match): one row per physically-unique face,
ever, for a given customer.

Counts are keyed on `detected_time` ONLY — the moment a row was first
created — never `last_seen`. A duplicate re-sighting of an
already-known face only advances that row's `last_seen`/
`detection_count` (face/unknown_manager.py); it must NOT increase these
charts, since it isn't a new unknown person. This is deliberate: the
charts answer "how many distinct new unknown people showed up on this
day/month", not "how many detections happened."
"""

from collections import defaultdict
from calendar import month_abbr
from datetime import date, datetime, timedelta

from sqlalchemy import select, func

from db import get_session
from auth.models import UnknownPerson
from error_logging import log_exception
from api.scope import apply_owner_scope

_DATETIME_FMT = "%d-%m-%Y %H:%M:%S"

DAILY_WINDOW_DAYS = 7


def _parse(value):

    if not value:
        return None

    try:
        return datetime.strptime(value, _DATETIME_FMT)
    except ValueError as e:
        # A row whose detected_time/last_seen doesn't match this format
        # would otherwise silently drop out of every chart with no trace
        # — exactly the "yesterday's data doesn't appear" symptom this
        # investigation was asked to explain, just for a row that's
        # malformed rather than one that's genuinely missing. Logged so
        # that class of bug is visible instead of indistinguishable from
        # "there was really no data that day".
        log_exception(e, f"unknown_analytics date parse (value={value!r})")
        return None


def _unique_days_seen(customer_id, owner_user_id=None, since=None):
    """{date: {unknown_person_id, ...}} — the calendar day each unknown
    person was FIRST created (detected_time only, never last_seen). A
    single MySQL query, only the id/detected_time columns (no embedding
    BLOB, no image path ever touched, no filesystem access).

    `since` (a `date`), when given, bounds the query to
    detected_time >= midnight that day — both callers below only ever
    need a recent window (last 7 days) or the current year, so without
    this the query pulled EVERY UnknownPerson row this customer has EVER
    had just to compute a small, bounded chart; that only gets slower as
    detection history grows, unboundedly, since this pipeline runs
    continuously. detected_time is stored as a "%d-%m-%Y %H:%M:%S"
    string, not a native DATE/DATETIME column, so a plain string
    comparison would sort wrong (day-first, not year-first) — MySQL's
    own STR_TO_DATE() parses it for a real chronological comparison in
    one WHERE clause, same approach _parse() already uses in Python for
    the exact same string format."""

    with get_session() as session:
        query = select(UnknownPerson.id, UnknownPerson.detected_time).where(
            UnknownPerson.customer_id == customer_id
        )
        query = apply_owner_scope(query, UnknownPerson.owner_user_id, owner_user_id)

        if since is not None:
            since_dt = datetime(since.year, since.month, since.day)
            query = query.where(
                func.str_to_date(UnknownPerson.detected_time, "%d-%m-%Y %H:%i:%s") >= since_dt
            )

        rows = session.execute(query).all()

    day_to_ids = defaultdict(set)

    for unknown_id, detected_time in rows:

        first = _parse(detected_time)

        if first is not None:
            day_to_ids[first.date()].add(unknown_id)

    return day_to_ids


def get_daily_unknown_counts(customer_id, days=DAILY_WINDOW_DAYS, owner_user_id=None):
    """Last `days` calendar days (including today), oldest first — one
    unique-face count per day."""

    today = date.today()
    day_to_ids = _unique_days_seen(customer_id, owner_user_id, since=today - timedelta(days=days - 1))

    return [
        {
            "date": (today - timedelta(days=offset)).strftime("%d-%m-%Y"),
            "label": (today - timedelta(days=offset)).strftime("%b %d"),
            "count": len(day_to_ids.get(today - timedelta(days=offset), ())),
        }
        for offset in range(days - 1, -1, -1)
    ]


def get_monthly_unknown_counts(customer_id, owner_user_id=None):
    """Year-to-date, January through the current month — one count per
    month, for however many brand-new unknown people were first created
    that month."""

    today = date.today()
    day_to_ids = _unique_days_seen(customer_id, owner_user_id, since=date(today.year, 1, 1))

    month_to_ids = defaultdict(set)

    for day, ids in day_to_ids.items():
        month_to_ids[(day.year, day.month)] |= ids

    return [
        {
            "month": f"{today.year}-{month:02d}",
            "label": month_abbr[month],
            "count": len(month_to_ids.get((today.year, month), ())),
        }
        for month in range(1, today.month + 1)
    ]


def get_unknown_person_analytics(customer_id, owner_user_id=None):

    return {
        "daily": get_daily_unknown_counts(customer_id, owner_user_id=owner_user_id),
        "monthly": get_monthly_unknown_counts(customer_id, owner_user_id=owner_user_id),
    }
