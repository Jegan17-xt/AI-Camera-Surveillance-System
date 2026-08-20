"""Admin Settings > Notifications & Reports — storage/validation for the
per-company configuration that drives notifications/service.py (Unknown
Person Alerts) and reports/daily_report.py (Daily Report). Deliberately
has zero imports from the AI detection pipeline (camera/, face/,
attendance/) — this module only ever reads/writes NotificationSettings.
"""

import time
from datetime import datetime

from sqlalchemy import select, text

from db import get_session, engine
from auth.models import NotificationSettings
from api.validators import validate_whatsapp_number, validate_number_range, validate_choice


def init_notification_report_tables():
    """User-Specific WhatsApp Report Settings added `related_user_id`
    to notification_logs and `user_id` to report_logs AFTER both tables
    already existed in this project's live database (they were brand
    new, create_all()-only tables at the time) — create_all() only
    creates missing TABLES, it never adds a column to one that's already
    there, so a live database needs it backfilled explicitly here, same
    idempotent checked-against-information_schema pattern every other
    init_*_table() in this project already uses. UserNotificationSettings
    itself needs no migration — it's a brand new table, created directly
    by auth.database.init_db()'s Base.metadata.create_all()."""

    with engine.connect() as conn:

        existing = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_logs'"
                )
            )
        }

        if "related_user_id" not in existing:
            conn.execute(text("ALTER TABLE notification_logs ADD COLUMN related_user_id INTEGER NULL"))
            conn.execute(text("ALTER TABLE notification_logs ADD INDEX idx_notification_logs_related_user_id (related_user_id)"))
            conn.execute(text(
                "ALTER TABLE notification_logs ADD CONSTRAINT fk_notification_logs_related_user_id "
                "FOREIGN KEY (related_user_id) REFERENCES users(id) ON DELETE SET NULL"
            ))
            conn.commit()

        existing = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report_logs'"
                )
            )
        }

        if "user_id" not in existing:
            conn.execute(text("ALTER TABLE report_logs ADD COLUMN user_id INTEGER NULL"))
            conn.execute(text("ALTER TABLE report_logs ADD INDEX idx_report_logs_user_id (user_id)"))
            conn.execute(text(
                "ALTER TABLE report_logs ADD CONSTRAINT fk_report_logs_user_id "
                "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL"
            ))
            conn.commit()

        # Daily Unknown Person Count added daily_unknown_count_enabled to
        # user_notification_settings AFTER that table already existed
        # live — same "create_all() never adds columns to an existing
        # table" situation as the two migrations above.
        existing = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_settings'"
                )
            )
        }

        if existing and "daily_unknown_count_enabled" not in existing:
            conn.execute(text(
                "ALTER TABLE user_notification_settings ADD COLUMN daily_unknown_count_enabled INTEGER NOT NULL DEFAULT 0"
            ))
            conn.commit()

DEFAULT_UNKNOWN_ALERT_TEMPLATE = (
    "🚨 Unknown Person Detected\n\n"
    "An unknown person has been detected by the AI Camera Surveillance System.\n\n"
    "📷 Camera: {camera}\n"
    "📅 Date: {date}\n"
    "🕐 Time: {time}\n\n"
    "Please check the attached image for verification.\n\n"
    "AI Camera Surveillance System"
)

_BOOLEAN_KEYS = {
    "unknown_alert_enabled",
    "unknown_alert_send_image",
    "unknown_alert_dedup_enabled",
    "daily_report_enabled",
    "daily_report_include_pdf",
    "daily_report_include_attendance_summary",
    "daily_report_include_person_wise",
    "daily_report_include_entry_exit",
    "daily_report_include_unknown_events",
    "daily_report_include_camera_status",
    "daily_report_include_detection_stats",
}

UNKNOWN_ALERT_KEYS = (
    "unknown_alert_enabled",
    "unknown_alert_recipient",
    "unknown_alert_template",
    "unknown_alert_send_image",
    "unknown_alert_min_confidence",
    "unknown_alert_cooldown_minutes",
    "unknown_alert_dedup_enabled",
)

DAILY_REPORT_KEYS = (
    "daily_report_enabled",
    "daily_report_time",
    "daily_report_recipient",
    "daily_report_format",
    "daily_report_include_pdf",
    "daily_report_include_attendance_summary",
    "daily_report_include_person_wise",
    "daily_report_include_entry_exit",
    "daily_report_include_unknown_events",
    "daily_report_include_camera_status",
    "daily_report_include_detection_stats",
)

_ALL_KEYS = UNKNOWN_ALERT_KEYS + DAILY_REPORT_KEYS

ALLOWED_REPORT_FORMATS = ("pdf",)

# Same short-TTL-cache shape as api/ai_config.py — this is read on every
# UNKNOWN_PERSON_CONFIRMED event (once per newly-saved unknown person,
# not per frame), so a cache still meaningfully cuts DB round-trips
# without ever masking a just-saved Admin change for more than a moment.
_cache = {}  # customer_id -> {"settings": {...}, "checked_at": float}
_CACHE_TTL = 3


def _row_to_dict(row):

    return {
        "unknown_alert_enabled": bool(row.unknown_alert_enabled),
        "unknown_alert_recipient": row.unknown_alert_recipient,
        "unknown_alert_template": row.unknown_alert_template or DEFAULT_UNKNOWN_ALERT_TEMPLATE,
        "unknown_alert_send_image": bool(row.unknown_alert_send_image),
        "unknown_alert_min_confidence": row.unknown_alert_min_confidence,
        "unknown_alert_cooldown_minutes": row.unknown_alert_cooldown_minutes,
        "unknown_alert_dedup_enabled": bool(row.unknown_alert_dedup_enabled),
        "daily_report_enabled": bool(row.daily_report_enabled),
        "daily_report_time": row.daily_report_time,
        "daily_report_recipient": row.daily_report_recipient,
        "daily_report_format": row.daily_report_format,
        "daily_report_include_pdf": bool(row.daily_report_include_pdf),
        "daily_report_include_attendance_summary": bool(row.daily_report_include_attendance_summary),
        "daily_report_include_person_wise": bool(row.daily_report_include_person_wise),
        "daily_report_include_entry_exit": bool(row.daily_report_include_entry_exit),
        "daily_report_include_unknown_events": bool(row.daily_report_include_unknown_events),
        "daily_report_include_camera_status": bool(row.daily_report_include_camera_status),
        "daily_report_include_detection_stats": bool(row.daily_report_include_detection_stats),
    }


def _fetch_or_create(customer_id):

    with get_session() as session:
        row = session.scalar(select(NotificationSettings).where(NotificationSettings.customer_id == customer_id))

        if row is None:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            row = NotificationSettings(customer_id=customer_id, created_at=now, updated_at=now)
            session.add(row)
            session.flush()

        return _row_to_dict(row)


def get_notification_settings(customer_id):
    """Current Notifications & Reports configuration for one company.
    Consulted by notifications/service.py and reports/daily_report.py —
    never by the AI detection pipeline directly."""

    now = time.time()
    cached = _cache.get(customer_id)

    if cached is not None and now - cached["checked_at"] < _CACHE_TTL:
        return cached["settings"]

    settings = _fetch_or_create(customer_id)
    _cache[customer_id] = {"settings": settings, "checked_at": now}

    return settings


def validate_unknown_alert_settings(values):

    if "unknown_alert_recipient" in values and values["unknown_alert_recipient"]:
        error = validate_whatsapp_number(values["unknown_alert_recipient"], "Recipient WhatsApp Number", required=False)
        if error:
            return error

    if "unknown_alert_min_confidence" in values:
        # Same 0-1 cosine-similarity scale as recognition_threshold/
        # unknown_duplicate_threshold (api/ai_config.py) — this is
        # compared directly against the `confidence` score
        # face/unknown_manager.py's save_unknown() already receives from
        # camera/frame_processor.py, never a 0-100 percentage.
        error = validate_number_range(
            values["unknown_alert_min_confidence"], "Minimum Confidence Threshold",
            min_value=0, max_value=1, integer=False,
        )
        if error:
            return error

    if "unknown_alert_cooldown_minutes" in values:
        error = validate_number_range(
            values["unknown_alert_cooldown_minutes"], "Cooldown Between Repeated Alerts",
            min_value=0, max_value=1440,
        )
        if error:
            return error

    return None


def validate_daily_report_settings(values):

    if "daily_report_recipient" in values and values["daily_report_recipient"]:
        error = validate_whatsapp_number(values["daily_report_recipient"], "Recipient WhatsApp Number", required=False)
        if error:
            return error

    if "daily_report_time" in values:
        try:
            datetime.strptime(values["daily_report_time"], "%H:%M")
        except (TypeError, ValueError):
            return "Report Generation Time must be in HH:MM 24-hour format."

    if "daily_report_format" in values:
        error = validate_choice(values["daily_report_format"], "Report Format", ALLOWED_REPORT_FORMATS)
        if error:
            return error

    return None


def _persist(customer_id, keys, new_values):

    to_save = {key: new_values[key] for key in keys if key in new_values}

    with get_session() as session:
        row = session.scalar(select(NotificationSettings).where(NotificationSettings.customer_id == customer_id))

        if row is None:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            row = NotificationSettings(customer_id=customer_id, created_at=now, updated_at=now)
            session.add(row)
            session.flush()

        for key, value in to_save.items():
            setattr(row, key, (1 if value else 0) if key in _BOOLEAN_KEYS else value)

        row.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    _cache.pop(customer_id, None)

    return get_notification_settings(customer_id)


def update_unknown_alert_settings(customer_id, new_values):

    error = validate_unknown_alert_settings(new_values)

    if error:
        return None, error

    return _persist(customer_id, UNKNOWN_ALERT_KEYS, new_values), None


def update_daily_report_settings(customer_id, new_values):

    error = validate_daily_report_settings(new_values)

    if error:
        return None, error

    return _persist(customer_id, DAILY_REPORT_KEYS, new_values), None


def reset_notification_settings(customer_id):
    """Deletes this company's row entirely, reverting it back to every
    factory default — the next get_notification_settings() call lazily
    reprovisions a fresh row."""

    with get_session() as session:
        session.query(NotificationSettings).filter(NotificationSettings.customer_id == customer_id).delete()

    _cache.pop(customer_id, None)

    return get_notification_settings(customer_id)
