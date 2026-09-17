import time
from datetime import datetime

from sqlalchemy import select, text

from db import get_session, engine
from auth.models import CustomerAiSetting

# Every customer's AI pipeline behavior. Most of these toggles (see
# COMPANY_ADMIN_AI_KEYS below) are also self-service editable by that
# customer's own Company Admin, via Settings > AI Detection Controls —
# unknown_alerts_enabled remains Super Admin-only (see
# auth.auth.super_admin_required on /users/<id>/ai-config). Every toggle
# defaults ON, matching a brand-new customer getting the full pipeline
# until deliberately turned off.
DEFAULT_AI_CONFIG = {
    "face_recognition_enabled": True,
    "registered_detection_enabled": True,
    "unknown_detection_enabled": True,
    "save_unknown_persons": True,
    "attendance_enabled": True,
    "unknown_alerts_enabled": True,
    # --- Company Admin -> AI Settings (Final Production Readiness) ---
    # Every value below used to be a hardcoded module constant — see
    # api/routes.py's /company/settings/ai routes and the "Was hardcoded
    # in ..." comment at each real call site (face/recognizer.py,
    # face/quality.py, attendance/attendance.py, face/unknown_manager.py)
    # for exactly what each one used to be and now reads dynamically.
    "recognition_threshold": 0.50,
    "min_face_size": 32,
    "blur_threshold": 25.0,
    "brightness_min": 25.0,
    "brightness_max": 235.0,
    "max_yaw": 60.0,
    "max_roll": 45.0,
    "attendance_cooldown_seconds": 5,
    "unknown_duplicate_threshold": 0.50,
    "face_quality_enabled": True,
    "tracking_enabled": True,
    # --- Multi-Object & Fire Detection ---
    # Master switches for the non-face detection paths. object/animal
    # detection ride on the existing single YOLO model (see
    # detection/detector.py); fire detection uses a separate optional
    # model (detection/fire_detector.py) and stays inactive if no model
    # file is installed regardless of this flag. All default ON.
    "object_detection_enabled": True,
    "animal_detection_enabled": True,
    "fire_detection_enabled": True,
}

# Which keys are booleans (stored as 0/1) vs numeric (stored as-is) —
# needed because update_ai_config can no longer treat every key the same
# way now that this table holds thresholds, not just on/off switches.
_BOOLEAN_KEYS = {
    "face_recognition_enabled",
    "registered_detection_enabled",
    "unknown_detection_enabled",
    "save_unknown_persons",
    "attendance_enabled",
    "unknown_alerts_enabled",
    "face_quality_enabled",
    "tracking_enabled",
    "object_detection_enabled",
    "animal_detection_enabled",
    "fire_detection_enabled",
}

# (min, max) inclusive bounds for every numeric key — enforced by
# update_ai_config before anything is written, per this task's explicit
# "Validate inputs" requirement. A value outside these is a real
# validation error, not silently clamped.
_NUMERIC_BOUNDS = {
    "recognition_threshold": (0.0, 1.0),
    "min_face_size": (1, 2000),
    "blur_threshold": (0.0, 10000.0),
    "brightness_min": (0.0, 255.0),
    "brightness_max": (0.0, 255.0),
    "max_yaw": (0.0, 90.0),
    "max_roll": (0.0, 90.0),
    "attendance_cooldown_seconds": (0, 86400),
    "unknown_duplicate_threshold": (0.0, 1.0),
}

# The two numeric columns that are genuinely INTEGER in the DB — every
# other numeric key is a FLOAT. Explicit, not guessed from the JSON
# request's own type (a JS client sending 32.0 for an int field is
# completely normal and must not silently become a float column write).
_INTEGER_KEYS = {"min_face_size", "attendance_cooldown_seconds"}

# The subset of DEFAULT_AI_CONFIG a Company Admin may read/write about
# their OWN company via the self-service routes (api/routes.py) —
# unknown_alerts_enabled is deliberately excluded, staying exclusively
# controlled from Customers > Customer Details > AI Configuration
# (Super Admin only).
COMPANY_ADMIN_AI_KEYS = (
    "face_recognition_enabled",
    "registered_detection_enabled",
    "unknown_detection_enabled",
    "save_unknown_persons",
    "attendance_enabled",
    "object_detection_enabled",
    "animal_detection_enabled",
    "fire_detection_enabled",
)

# Everything a Company Admin's new AI Settings page (Settings >
# AI Settings) can read/write about their own company — the toggles
# above PLUS every numeric threshold. Kept as a separate list from
# COMPANY_ADMIN_AI_KEYS (used by the older, narrower AI Detection
# Controls card) rather than replacing it, so that existing card keeps
# working unchanged.
COMPANY_ADMIN_AI_SETTINGS_KEYS = (
    "face_recognition_enabled",
    "attendance_enabled",
    "unknown_detection_enabled",
    "face_quality_enabled",
    "tracking_enabled",
    "recognition_threshold",
    "min_face_size",
    "blur_threshold",
    "brightness_min",
    "brightness_max",
    "max_yaw",
    "max_roll",
    "attendance_cooldown_seconds",
    "unknown_duplicate_threshold",
)

_CONFIG_KEYS = tuple(DEFAULT_AI_CONFIG.keys())

# Re-reading this table on every processed video frame (see
# camera/frame_processor.py, which calls get_ai_config() once per frame)
# would add a DB round-trip to the hot path — the same concern
# face/unknown_manager.py's cooldown cache already exists for. Kept per
# customer_id so one customer's config can never leak into another
# customer's cached read. update_ai_config() clears a customer's entry
# immediately on save, so a Super Admin's change is never masked by a
# stale cached read — including on their own very next GET.
_cache = {}  # customer_id -> {"config": {...}, "checked_at": float}
_CACHE_TTL = 3  # seconds


def init_ai_config_table():
    """Every customer (a Company Admin account in `users`) gets their own
    AI configuration row — ON DELETE CASCADE means deleting a customer
    also removes their config, and changing Customer A's row can never
    affect Customer B's, since every read/write here is scoped by
    customer_id. Table creation is handled by Base.metadata.create_all()
    in auth.database.init_db().

    Every column below was added to this table after it already existed
    in deployed databases — create_all() only creates missing TABLES, it
    never adds columns to one that's already there, so a live database
    from before this change needs them backfilled explicitly. Checked
    against information_schema first (rather than a blind ALTER) so this
    stays safe to run on every startup."""

    with engine.connect() as conn:
        existing_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customer_ai_settings'"
                )
            )
        }

        column_types = {
            "registered_detection_enabled": "INTEGER NOT NULL DEFAULT 1",
            "unknown_detection_enabled": "INTEGER NOT NULL DEFAULT 1",
            "recognition_threshold": "FLOAT NOT NULL DEFAULT 0.50",
            "min_face_size": "INTEGER NOT NULL DEFAULT 32",
            "blur_threshold": "FLOAT NOT NULL DEFAULT 25.0",
            "brightness_min": "FLOAT NOT NULL DEFAULT 25.0",
            "brightness_max": "FLOAT NOT NULL DEFAULT 235.0",
            "max_yaw": "FLOAT NOT NULL DEFAULT 60.0",
            "max_roll": "FLOAT NOT NULL DEFAULT 45.0",
            "attendance_cooldown_seconds": "INTEGER NOT NULL DEFAULT 5",
            "unknown_duplicate_threshold": "FLOAT NOT NULL DEFAULT 0.50",
            "face_quality_enabled": "INTEGER NOT NULL DEFAULT 1",
            "tracking_enabled": "INTEGER NOT NULL DEFAULT 1",
            "object_detection_enabled": "INTEGER NOT NULL DEFAULT 1",
            "animal_detection_enabled": "INTEGER NOT NULL DEFAULT 1",
            "fire_detection_enabled": "INTEGER NOT NULL DEFAULT 1",
        }

        for column, ddl_type in column_types.items():
            if column not in existing_columns:
                conn.execute(text(f"ALTER TABLE customer_ai_settings ADD COLUMN {column} {ddl_type}"))
                conn.commit()


def _row_to_config(row):
    config = {}
    for key in _CONFIG_KEYS:
        value = getattr(row, key)
        config[key] = bool(value) if key in _BOOLEAN_KEYS else value
    return config


def _fetch_or_create(customer_id):
    """Reads this customer's row, lazily provisioning one (every default
    above) the first time it's asked for — so "every customer must have
    their own configuration" holds without needing an explicit
    provisioning step wherever a customer account gets created."""

    with get_session() as session:
        row = session.scalar(select(CustomerAiSetting).where(CustomerAiSetting.customer_id == customer_id))

        if row is None:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            defaults = {
                key: (1 if value else 0) if key in _BOOLEAN_KEYS else value
                for key, value in DEFAULT_AI_CONFIG.items()
            }
            row = CustomerAiSetting(
                customer_id=customer_id,
                created_at=now,
                updated_at=now,
                **defaults,
            )
            session.add(row)
            session.flush()

        return _row_to_config(row)


# The three detection flags whose availability is also gated by the
# Security & Detection package (api.module_packages) — a company that
# hasn't bought that package, or whose Super Admin has switched the
# matching sub-module off platform-wide, never runs that detection path
# regardless of the stored column value. Purely a read-time gate: the
# stored value is left untouched so it comes back the moment the package
# is (re)acquired.
_PACKAGE_GATED_FLAGS = (
    "object_detection_enabled",
    "animal_detection_enabled",
    "fire_detection_enabled",
)


def _apply_package_gate(tenant_id, config):
    """Return `config` with any package-gated detection flag forced False
    when the company isn't entitled to it. Never mutates the cached dict.

    `tenant_id` is the COMPANY this entitlement is billed to — never the
    AI-config row's own customer_id, which (via Settings > "Managing
    Settings For") can be one individual User's id instead. Package
    ownership (module_packages.company_package_keys) is only ever
    recorded under the company's own id, so gating against the row's raw
    customer_id would incorrectly lock these flags for every User row
    and for every Company-Admin-on-behalf-of-a-User row."""

    try:
        from api.module_packages import ai_flag_allowed  # lazy — avoids import cycle
    except Exception:
        return config

    gated = None
    for key in _PACKAGE_GATED_FLAGS:
        if config.get(key) and not ai_flag_allowed(tenant_id, key):
            if gated is None:
                gated = dict(config)
            gated[key] = False

    return gated if gated is not None else config


def get_ai_flag_locks(tenant_id):
    """{flag_key: True} for each of the 3 package-gated detection flags
    this tenant (company) is NOT entitled to right now — no Security &
    Detection package, the package globally disabled, this company's
    per-company access to it revoked, or the specific sub-module
    switched off. The Company Admin / User AI Settings pages use this to
    render 🔒 Locked and refuse the toggle client-side, matching exactly
    what update_ai_config/get_ai_config would enforce server-side
    regardless."""

    try:
        from api.module_packages import ai_flag_allowed  # lazy — avoids import cycle
    except Exception:
        return {key: False for key in _PACKAGE_GATED_FLAGS}

    return {key: not ai_flag_allowed(tenant_id, key) for key in _PACKAGE_GATED_FLAGS}


def get_ai_config(customer_id, tenant_id=None):
    """Current AI configuration for one customer. This is what the
    Super Admin's AI Configuration section loads, the Company Admin's
    AI Settings page loads, and what the AI pipeline (camera/
    frame_processor.py, face/quality.py, face/recognizer.py,
    attendance/attendance.py, face/unknown_manager.py) must consult
    before running face recognition, saving an unknown person, marking
    attendance, or raising an unknown-person alert for this customer.

    The object / animal / fire detection flags are additionally gated by
    the Security & Detection package here (see _apply_package_gate).
    `tenant_id` is the company that entitlement is checked against —
    defaults to `customer_id` (correct for every caller except the
    Settings pages, which may be reading/writing one specific User's own
    row on behalf of their company; see api/routes.py's resolve_settings_
    target_id vs get_tenant_id)."""

    if tenant_id is None:
        tenant_id = customer_id

    now = time.time()
    cached = _cache.get(customer_id)

    if cached is not None and now - cached["checked_at"] < _CACHE_TTL:
        return _apply_package_gate(tenant_id, cached["config"])

    config = _fetch_or_create(customer_id)
    _cache[customer_id] = {"config": config, "checked_at": now}

    return _apply_package_gate(tenant_id, config)


def validate_ai_settings(new_values):
    """Bounds-checks every numeric key present in new_values. Returns an
    error message string, or None if everything present is valid.
    Booleans are never rejected (any truthy/falsy JSON value coerces
    cleanly). Unknown keys are ignored here — update_ai_config() itself
    only ever persists recognized keys."""

    for key, (lo, hi) in _NUMERIC_BOUNDS.items():

        if key not in new_values:
            continue

        try:
            value = float(new_values[key])
        except (TypeError, ValueError):
            return f"{key} must be a number."

        if value < lo or value > hi:
            return f"{key} must be between {lo} and {hi}."

    brightness_min = new_values.get("brightness_min")
    brightness_max = new_values.get("brightness_max")

    if brightness_min is not None and brightness_max is not None and float(brightness_min) >= float(brightness_max):
        return "brightness_min must be less than brightness_max."

    return None


def update_ai_config(customer_id, new_values, tenant_id=None):
    """Persists only recognized keys, scoped to this customer_id only —
    changing Customer A's configuration can never affect Customer B's,
    since every statement here is scoped by customer_id. Returns the
    full merged configuration so the caller can re-render from exactly
    what is now in the database.

    `tenant_id` is forwarded to the final get_ai_config() re-read so the
    package gate (object/animal/fire detection) is checked against the
    right company — see get_ai_config's docstring. A write to a
    package-gated flag this tenant isn't entitled to is still persisted
    here (so it comes back the instant entitlement is restored) but the
    value handed back to the caller is gated False, same as any other
    read.

    Does NOT itself validate — callers that accept raw external input
    (api/routes.py's PUT handlers) must call validate_ai_settings()
    first and reject the request on error before ever reaching here."""

    _fetch_or_create(customer_id)  # ensure the row exists before UPDATE

    changed = {}

    for key in _CONFIG_KEYS:

        if key not in new_values:
            continue

        if key in _BOOLEAN_KEYS:
            changed[key] = 1 if new_values[key] else 0
        elif key in _INTEGER_KEYS:
            changed[key] = int(round(float(new_values[key])))
        else:
            changed[key] = float(new_values[key])

    if changed:
        with get_session() as session:
            row = session.scalar(select(CustomerAiSetting).where(CustomerAiSetting.customer_id == customer_id))

            for key, value in changed.items():
                setattr(row, key, value)

            row.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    _cache.pop(customer_id, None)

    return get_ai_config(customer_id, tenant_id=tenant_id)


def reset_ai_config(customer_id, tenant_id=None):
    """Deletes this customer_id's row entirely, reverting it back to
    DEFAULT_AI_CONFIG — the next get_ai_config() call lazily reprovisions
    a fresh, all-defaults row via _fetch_or_create. Scoped to this
    customer_id only, same isolation guarantee as update_ai_config above.
    `tenant_id` is forwarded the same way as in update_ai_config."""

    with get_session() as session:
        session.query(CustomerAiSetting).filter(CustomerAiSetting.customer_id == customer_id).delete()

    _cache.pop(customer_id, None)

    return get_ai_config(customer_id, tenant_id=tenant_id)
