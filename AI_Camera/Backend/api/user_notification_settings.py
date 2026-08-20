"""Per-User WhatsApp & Reports — User Management > Add/Edit User. Each
User (role=User, under a Company Admin) gets their own independent
WhatsApp number, Unknown Alert toggle, Send Image toggle, Daily Report
toggle, and Daily Report time — entirely separate from the company-wide
NotificationSettings (api/notification_settings.py), which stays the
company-level fallback recipient and the master enable/disable switch
(see notifications/service.py and reports/scheduler.py for how the two
combine).

Never reachable directly — every caller goes through
api/company_users.py's ownership-checked wrappers, so a user_id
belonging to a different company can never be read or written here.
"""

import time
from datetime import datetime

from sqlalchemy import select

from db import get_session
from auth.models import UserNotificationSettings
from api.validators import validate_whatsapp_number

_BOOLEAN_KEYS = {"unknown_alert_enabled", "send_unknown_image", "daily_unknown_count_enabled", "daily_report_enabled"}

_ALL_KEYS = (
    "whatsapp_number",
    "unknown_alert_enabled",
    "send_unknown_image",
    "daily_unknown_count_enabled",
    "daily_report_enabled",
    "daily_report_time",
)

# Same short-TTL cache shape as api/notification_settings.py /
# api/ai_config.py — read once per event/scheduler tick, not once per
# frame, so a cache still meaningfully cuts DB round-trips.
_cache = {}  # user_id -> {"settings": {...}, "checked_at": float}
_CACHE_TTL = 3


def _row_to_dict(row):

    return {
        "whatsapp_number": row.whatsapp_number,
        "unknown_alert_enabled": bool(row.unknown_alert_enabled),
        "send_unknown_image": bool(row.send_unknown_image),
        "daily_unknown_count_enabled": bool(row.daily_unknown_count_enabled),
        "daily_report_enabled": bool(row.daily_report_enabled),
        "daily_report_time": row.daily_report_time,
    }


def _fetch_or_create(user_id):

    with get_session() as session:
        row = session.scalar(select(UserNotificationSettings).where(UserNotificationSettings.user_id == user_id))

        if row is None:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            row = UserNotificationSettings(user_id=user_id, created_at=now, updated_at=now)
            session.add(row)
            session.flush()

        return _row_to_dict(row)


def get_user_notification_settings(user_id):
    """This User's own WhatsApp & Reports configuration. Consulted by
    notifications/service.py (Unknown Person Alert recipient routing)
    and reports/scheduler.py + reports/daily_report.py (per-user Daily
    Report) — never by the AI detection pipeline directly."""

    now = time.time()
    cached = _cache.get(user_id)

    if cached is not None and now - cached["checked_at"] < _CACHE_TTL:
        return cached["settings"]

    settings = _fetch_or_create(user_id)
    _cache[user_id] = {"settings": settings, "checked_at": now}

    return settings


def validate_user_notification_settings(values):

    if "whatsapp_number" in values and values["whatsapp_number"]:
        error = validate_whatsapp_number(values["whatsapp_number"], "WhatsApp Number", required=False)
        if error:
            return error

    if "daily_report_time" in values:
        try:
            datetime.strptime(values["daily_report_time"], "%H:%M")
        except (TypeError, ValueError):
            return "Report Time must be in HH:MM 24-hour format."

    return None


def update_user_notification_settings(user_id, new_values):
    """Persists only recognized keys, scoped to this user_id only —
    saving one User's WhatsApp & Reports settings can never affect a
    sibling User's or the Company Admin's, since every write here is
    scoped by this one id."""

    if not isinstance(new_values, dict):
        new_values = {}

    error = validate_user_notification_settings(new_values)

    if error:
        return None, error

    to_save = {key: new_values[key] for key in _ALL_KEYS if key in new_values}

    with get_session() as session:
        row = session.scalar(select(UserNotificationSettings).where(UserNotificationSettings.user_id == user_id))

        if row is None:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            row = UserNotificationSettings(user_id=user_id, created_at=now, updated_at=now)
            session.add(row)
            session.flush()

        for key, value in to_save.items():
            setattr(row, key, (1 if value else 0) if key in _BOOLEAN_KEYS else value)

        row.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    _cache.pop(user_id, None)

    return get_user_notification_settings(user_id), None


def reset_user_notification_settings(user_id):
    """Deletes this User's row entirely, reverting it back to every
    factory default — same idempotent-reprovision-on-next-read pattern
    as api/notification_settings.py's reset_notification_settings."""

    with get_session() as session:
        session.query(UserNotificationSettings).filter(UserNotificationSettings.user_id == user_id).delete()

    _cache.pop(user_id, None)

    return get_user_notification_settings(user_id)
