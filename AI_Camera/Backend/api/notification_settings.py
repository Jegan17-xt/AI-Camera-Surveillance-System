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

        # Per-Detection-Type Alert Toggles — vehicle_alert_enabled/
        # fire_smoke_alert_enabled/animal_alert_enabled/bird_alert_enabled
        # added to notification_settings AFTER that table already existed
        # live, same "create_all() never adds columns to an existing
        # table" situation as every migration above. Backfilled from each
        # row's OWN existing unknown_alert_enabled value (never a fixed
        # literal) so a company's actual current behavior — these four
        # types were, until this feature existed, gated by that same
        # toggle as a stand-in master switch — is exactly preserved at
        # the moment of migration; each company can then independently
        # adjust every one going forward. New rows created after this
        # point get the ORM's own default=0 (auth/models.py), same
        # explicit-opt-in-required default every other alert toggle here
        # already uses.
        existing = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_settings'"
                )
            )
        }

        if existing and "vehicle_alert_enabled" not in existing:
            conn.execute(text("ALTER TABLE notification_settings ADD COLUMN vehicle_alert_enabled INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("ALTER TABLE notification_settings ADD COLUMN fire_smoke_alert_enabled INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("ALTER TABLE notification_settings ADD COLUMN animal_alert_enabled INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("ALTER TABLE notification_settings ADD COLUMN bird_alert_enabled INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text(
                "UPDATE notification_settings SET "
                "vehicle_alert_enabled = unknown_alert_enabled, "
                "fire_smoke_alert_enabled = unknown_alert_enabled, "
                "animal_alert_enabled = unknown_alert_enabled, "
                "bird_alert_enabled = unknown_alert_enabled"
            ))
            conn.commit()

        # unknown_alert_min_confidence default correction (2026-09-07):
        # the column already exists (no ADD COLUMN needed) so this isn't
        # a schema migration, just a data fix — no UI field for this
        # column has ever existed (see validate_unknown_alert_settings),
        # so ANY row still sitting at the OLD literal default (0.0) is
        # provably the untouched original, never a deliberate Admin
        # choice; this WHERE clause naturally stops matching a row the
        # instant it's corrected (or ever set to something else by an
        # API caller), so it's safe to run unconditionally on every
        # startup without a separate "already migrated" flag.
        if existing:
            conn.execute(text(
                "UPDATE notification_settings SET unknown_alert_min_confidence = -1.0 "
                "WHERE unknown_alert_min_confidence = 0.0"
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
    "vehicle_alert_enabled",
    "fire_smoke_alert_enabled",
    "animal_alert_enabled",
    "bird_alert_enabled",
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

# Per-Detection-Type Alert Toggles — fully independent of
# UNKNOWN_ALERT_KEYS above (which is specific to Unknown Person Alert's
# own recipient/template/confidence/cooldown/dedup, none of which apply
# here). Each of these four is a standalone ON/OFF for its own
# detection type's WhatsApp notification only — see notifications/
# service.py's deliver_ai_detection_alert.
DETECTION_ALERT_KEYS = (
    "vehicle_alert_enabled",
    "fire_smoke_alert_enabled",
    "animal_alert_enabled",
    "bird_alert_enabled",
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

_ALL_KEYS = UNKNOWN_ALERT_KEYS + DETECTION_ALERT_KEYS + DAILY_REPORT_KEYS

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
        "vehicle_alert_enabled": bool(row.vehicle_alert_enabled),
        "fire_smoke_alert_enabled": bool(row.fire_smoke_alert_enabled),
        "animal_alert_enabled": bool(row.animal_alert_enabled),
        "bird_alert_enabled": bool(row.bird_alert_enabled),
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
        # Compared directly against the `confidence` score
        # face/unknown_manager.py's save_unknown() already receives from
        # camera/frame_processor.py — a cosine SIMILARITY score against
        # the closest REGISTERED face (the same score that classifies
        # someone as "Unknown" to begin with: below recognition_threshold).
        # That score's real range is -1..1, not 0..1 — unlike
        # recognition_threshold/unknown_duplicate_threshold (api/ai_config.py),
        # which compare embeddings against EACH OTHER and so stay
        # practically non-negative, this one compares a genuine stranger
        # against someone they don't resemble at all, which is routinely
        # a small negative number. Root-cause fix (2026-09-07): the old
        # 0..1 range made it impossible to ever configure a value that
        # doesn't silently discard those completely legitimate negative-
        # score alerts.
        error = validate_number_range(
            values["unknown_alert_min_confidence"], "Minimum Confidence Threshold",
            min_value=-1, max_value=1, integer=False,
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


def update_detection_alert_settings(customer_id, new_values):
    """Vehicle/Fire-Smoke/Animal/Bird alert toggles — no dedicated
    validation needed (every DETECTION_ALERT_KEYS field is a plain
    boolean, coerced in _persist via _BOOLEAN_KEYS)."""

    return _persist(customer_id, DETECTION_ALERT_KEYS, new_values), None


def update_daily_report_settings(customer_id, new_values):

    error = validate_daily_report_settings(new_values)

    if error:
        return None, error

    return _persist(customer_id, DAILY_REPORT_KEYS, new_values), None


# notification_type (as passed by every caller in notifications/service.py
# and reports/daily_report.py) -> the NotificationSettings boolean column
# that governs it. The one place this mapping lives — add a new
# notification_type here, never inline elsewhere.
_GATE_KEY_BY_NOTIFICATION_TYPE = {
    "unknown_person_alert": "unknown_alert_enabled",
    "fire_smoke_alert": "fire_smoke_alert_enabled",
    "vehicle_alert": "vehicle_alert_enabled",
    "animal_alert": "animal_alert_enabled",
    "bird_alert": "bird_alert_enabled",
    "daily_report": "daily_report_enabled",
}


def log_and_check_notifications_enabled(customer_id, notification_type):
    """The ONE gate every outbound notification send in this app must
    pass through, for every flow — Unknown Person, Fire/Smoke, Vehicle,
    Animal/Bird, and Daily Reports. Call this immediately before actually
    sending (never before recipient resolution/PDF generation/etc — only
    before the real dispatch), and do not send/queue/trigger anything if
    it returns False.

    Root-cause fix (Company Admin Notification Settings audit,
    2026-09-02): notifications/service.py's deliver_ai_detection_alert()
    (Fire/Smoke/Vehicle/Animal/Bird) previously had NO enabled check at
    all. First fixed by routing all four through the "WhatsApp Alerts"
    toggle (unknown_alert_enabled) as a stand-in master switch; per-type
    toggles (2026-09-02, same day) then replaced that stand-in with four
    dedicated columns so each type is independently controllable — this
    is the single place that maps every notification_type this app ever
    sends to its own EXISTING DB column, no new settings field beyond
    those four, no new table, no hardcoded True/False:

      - "unknown_person_alert" -> NotificationSettings.unknown_alert_enabled
        (the UI's "WhatsApp Alerts" toggle) — Unknown Person Alert only.
      - "fire_smoke_alert" -> NotificationSettings.fire_smoke_alert_enabled
      - "vehicle_alert" -> NotificationSettings.vehicle_alert_enabled
      - "animal_alert" -> NotificationSettings.animal_alert_enabled
      - "bird_alert" -> NotificationSettings.bird_alert_enabled
      - "daily_report" -> NotificationSettings.daily_report_enabled (the
        UI's "Daily Reports" toggle).

    Company-specific by construction: get_notification_settings(customer_id)
    reads/caches strictly per customer_id, so one company's OFF setting
    can never read or affect another company's row or cache entry."""

    settings = get_notification_settings(customer_id)
    gate_key = _GATE_KEY_BY_NOTIFICATION_TYPE.get(notification_type, "unknown_alert_enabled")
    enabled = bool(settings[gate_key])

    print(f"[NOTIFICATION-SETTINGS] Company: {customer_id}")
    print(f"[NOTIFICATION-SETTINGS] Enabled: {enabled}")
    print(f"[NOTIFICATION-SETTINGS] Notification type: {notification_type}")

    if not enabled:
        print("[NOTIFICATION-SETTINGS] Skipped - notifications disabled")
        return False

    print(f"[NOTIFICATION-SETTINGS] Sending: {notification_type}")
    return True


def reset_notification_settings(customer_id):
    """Deletes this company's row entirely, reverting it back to every
    factory default — the next get_notification_settings() call lazily
    reprovisions a fresh row."""

    with get_session() as session:
        session.query(NotificationSettings).filter(NotificationSettings.customer_id == customer_id).delete()

    _cache.pop(customer_id, None)

    return get_notification_settings(customer_id)
