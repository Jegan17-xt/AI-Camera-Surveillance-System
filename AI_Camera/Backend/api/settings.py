import json

from sqlalchemy import select

from db import get_session
from auth.models import AppSetting
from api.validators import validate_number_range, validate_choice, validate_boolean

# Allowed values for the two dropdown-backed settings — mirrors the
# <select> options in Settings.jsx exactly, so a request that didn't come
# from that dropdown (or a stale/tampered one) can't sneak in an
# arbitrary string.
ALLOWED_RESOLUTIONS = ("1080p (Full HD)", "720p (HD)", "4K (Ultra HD)")
ALLOWED_FRAME_RATES = ("15 fps", "24 fps", "30 fps", "60 fps")

# label + validator for every key in DEFAULT_SETTINGS. A key with no
# entry here (there shouldn't be any) is left completely unvalidated,
# so every setting the UI can save must have one.
_SETTINGS_VALIDATORS = {
    "camera_resolution": lambda v: validate_choice(v, "Default Resolution", ALLOWED_RESOLUTIONS),
    "camera_frame_rate": lambda v: validate_choice(v, "Frame Rate", ALLOWED_FRAME_RATES),
    "camera_continuous_recording": lambda v: validate_boolean(v, "Continuous Recording"),
    "camera_night_vision": lambda v: validate_boolean(v, "Night Vision Mode"),
    "camera_auto_reconnect": lambda v: validate_boolean(v, "Auto Camera Reconnect"),
    "ai_confidence_threshold": lambda v: validate_number_range(
        v, "Face Match Confidence Threshold", min_value=50, max_value=99
    ),
    "ai_retry_interval_minutes": lambda v: validate_number_range(
        v, "Unknown Person Cooldown", min_value=0, max_value=1440
    ),
    "ai_min_face_size": lambda v: validate_number_range(
        v, "Minimum Face Size Detection", min_value=10, max_value=1000
    ),
    "notify_unknown_person": lambda v: validate_boolean(v, "Unknown Person Detected notification"),
    "notify_camera_offline": lambda v: validate_boolean(v, "Camera Offline notification"),
    "system_dashboard_refresh_seconds": lambda v: validate_number_range(
        v, "Dashboard Auto Refresh Interval", min_value=5, max_value=3600
    ),
}

# Every key the Settings page can save. get_settings() always returns
# exactly this key set (saved value if one exists, this default
# otherwise) — a route handler can never end up inventing a value or
# silently dropping a field the UI expects to round-trip.
DEFAULT_SETTINGS = {
    # Camera Settings
    "camera_resolution": "1080p (Full HD)",
    "camera_frame_rate": "30 fps",
    "camera_continuous_recording": True,
    "camera_night_vision": True,
    "camera_auto_reconnect": True,
    # AI Settings
    # NOTE: whether unknown faces get saved and whether attendance gets
    # recorded are no longer user-editable settings — they moved to the
    # Super Admin-only Customers > Customer Details > AI Configuration
    # section (api/ai_config.py, customer_ai_settings table), which the
    # AI pipeline now consults instead of these keys.
    "ai_confidence_threshold": 82,
    "ai_retry_interval_minutes": 10,
    "ai_min_face_size": 40,
    # Notification Settings
    "notify_unknown_person": True,
    "notify_camera_offline": True,
    # System Settings
    "system_dashboard_refresh_seconds": 30,
}


def init_settings_table():
    """Settings are per-account — two accounts (whether two Users, or a
    User and their Company Admin) must never be able to see or overwrite
    each other's configuration. Keyed by (customer_id, key) — customer_id
    here holds the specific account's own id, NOT necessarily the company/
    tenant id (see api/routes.py's use of
    auth.auth.resolve_settings_target_id, which is what decides whose id
    that actually is for a given request) — with ON DELETE CASCADE so a
    removed account's saved settings can't linger as an orphaned row.
    Table creation is handled by Base.metadata.create_all() in
    auth.database.init_db()."""


def get_settings(user_id):
    """Current settings for the account identified by user_id — a saved
    app_settings row for THIS user_id wins for its key, otherwise
    DEFAULT_SETTINGS fills the gap. Every User (and the Company Admin) has
    their own independent set of saved values, since callers always pass
    that specific account's own id — see
    auth.auth.resolve_settings_target_id for how a request resolves which
    id that is (a User's own id always; a Company Admin's own id by
    default, or one of their Users' ids when the Admin is viewing/editing
    that User's settings)."""

    with get_session() as session:
        rows = session.scalars(select(AppSetting).where(AppSetting.customer_id == user_id)).all()

    saved = {}

    for row in rows:

        # A key no longer in DEFAULT_SETTINGS (a setting that has since
        # been removed from the product) is dropped here rather than
        # leaking into the response — the UI can never end up showing an
        # option that was deliberately taken out.
        if row.key not in DEFAULT_SETTINGS:
            continue

        try:
            saved[row.key] = json.loads(row.value)
        except (TypeError, ValueError):
            continue

    return {**DEFAULT_SETTINGS, **saved}


def save_settings(user_id, new_values):
    """Persists only recognized setting keys (an unexpected key from a
    malformed request body is silently ignored, never stored), scoped to
    this user_id only — saving User A's settings can never affect User B's
    or the Company Admin's, since every write here is scoped by this one
    id. Returns (settings, error) — settings is the full merged settings
    on success so the caller can re-render from exactly what is now in the
    database; on validation failure, error is a message and NOTHING is
    written (no partial save)."""

    if not isinstance(new_values, dict):
        new_values = {}

    to_save = {}

    for key, value in new_values.items():

        if key not in DEFAULT_SETTINGS:
            continue

        validator = _SETTINGS_VALIDATORS.get(key)
        error = validator(value) if validator else None

        if error:
            return None, error

        to_save[key] = value

    with get_session() as session:
        for key, value in to_save.items():
            row = session.get(AppSetting, (user_id, key))

            if row is None:
                session.add(AppSetting(customer_id=user_id, key=key, value=json.dumps(value)))
            else:
                row.value = json.dumps(value)

    return get_settings(user_id), None


def reset_settings(user_id):
    """Deletes every saved app_settings row for this user_id, reverting
    them back to DEFAULT_SETTINGS — the Admin (or a User, for their own
    settings) choosing "Reset to Defaults". Scoped to this user_id only,
    same isolation guarantee as save_settings above."""

    with get_session() as session:
        session.query(AppSetting).filter(AppSetting.customer_id == user_id).delete()

    return get_settings(user_id)
