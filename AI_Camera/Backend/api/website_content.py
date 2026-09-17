import os

from db import get_session
from auth.models import PlatformSetting
from api.validators import validate_image_upload, validate_email, validate_phone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEBSITE_FOLDER = os.path.join(BASE_DIR, "dataset", "website")

# Public Zynez landing page (Frontend/Ai_FE/src/pages/Landing.jsx) — every
# piece of copy/imagery a Super Admin can edit from Website Settings
# (Super Admin > System Settings > Website Settings), stored in the same
# platform-wide `platform_settings` key/value table api/branding.py
# already uses for Application Name / Platform Logo (no new table; keys
# below are simply namespaced "website_*" so they can never collide with
# branding.py's own "app_name"/"logo_filename" keys in that same table).
#
# Module Package pricing (Cameras/People/Security & Detection/Reports —
# monthly/yearly price, enabled) is DELIBERATELY not part of this module
# — it already lives in api.module_packages (BillableItem rows),
# read/written via the existing GET/PUT /module-packages routes the
# Super Admin's Billing & Pricing page already uses. Website Settings'
# Pricing card calls those same endpoints directly; nothing here
# duplicates that data.
#
# "extend_platform"'s monthly_price/yearly_price are different: a single
# promotional headline figure for the landing page's "Extend your
# platform" add-ons section (the ₹X/mo "starting from" banner next to
# that section's already-dynamic per-item add-on grid, which stays
# sourced from the BillableItem catalog via GET /public/pricing,
# untouched). This one number has no link to any BillableItem row — it's
# just marketing copy the Super Admin types in, like every other
# heading/description field below, so it belongs in this same
# key/value content store rather than a new table or the billing catalog.

ALLOWED_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024  # 5MB

# Each image slot is stored under a fixed, deterministic filename
# ("<slot>{ext}") — a re-upload always overwrites the previous image for
# that slot, same convention as api/branding.py's single "logo{ext}".
IMAGE_SLOTS = ("hero", "ai_detection", "unknown_person", "fire_detection", "logo")

# Every text field a section exposes, in the order Website Settings
# renders them. Drives get_website_content()/update_section() generically
# instead of one hand-written function per section (same "config dict
# drives generic logic" shape as api/module_packages.py's PACKAGE_DEFS).
SECTION_FIELDS = {
    "hero": ("heading", "description", "cta_text"),
    "ai_detection": ("heading", "description", "feature_text"),
    "unknown_person": ("heading", "description", "alert_text"),
    "fire_detection": ("heading", "description", "alert_text"),
    "contact": ("heading", "description", "email", "phone", "location", "info_text"),
    "general": ("website_name", "footer_text"),
    "extend_platform": ("monthly_price", "yearly_price"),
}

# Fields validated as a non-negative number rather than free-form text —
# currently only extend_platform's two price fields.
PRICE_FIELDS = {"monthly_price", "yearly_price"}

# The section each image slot belongs to, and the key its URL is exposed
# under in get_website_content()'s response — "logo" is the one slot
# that lives under "general" rather than matching a SECTION_FIELDS name.
IMAGE_SLOT_SECTION = {
    "hero": "hero",
    "ai_detection": "ai_detection",
    "unknown_person": "unknown_person",
    "fire_detection": "fire_detection",
    "logo": "general",
}
IMAGE_SLOT_RESPONSE_KEY = {
    "hero": "image_url",
    "ai_detection": "image_url",
    "unknown_person": "image_url",
    "fire_detection": "image_url",
    "logo": "logo_url",
}

# Today's hardcoded Landing.jsx copy, used as the fallback for every
# field that has never been saved — a fresh/never-configured install
# renders exactly as it does today, nothing looks blank or broken before
# the first Super Admin save. Keyed "{section}_{field}", matching the
# PlatformSetting key each value is stored under.
DEFAULTS = {
    "hero_heading": "Your Cameras.\nNow Think.",
    "hero_description": "Zynez is an AI-powered camera surveillance platform that detects, understands and responds to events in real time.",
    "hero_cta_text": "Start with Zynez",
    "ai_detection_heading": "See everything\nMiss nothing",
    "ai_detection_description": "Zynez detects events, analyzes them and instantly takes action.",
    "ai_detection_feature_text": "13+ real-time detection capabilities, one unified AI pipeline.",
    "unknown_person_heading": "When someone unknown enters, you know instantly.",
    "unknown_person_description": "Zynez runs face detection on every stream. A face that doesn't match your registered people is captured, stored and turned into an event — with real-time notifications.",
    "unknown_person_alert_text": "Unknown Person Detected — Alert Sent",
    "fire_detection_heading": "Smart fire & smoke detection.",
    "fire_detection_description": "Detect potential fire and smoke events early. A dedicated model watches your streams, verifies the signature, saves a snapshot and raises an alert for review.",
    "fire_detection_alert_text": "Fire Detected — Alert Sent",
    "contact_heading": "Let's Make Your Cameras Smarter.",
    "contact_description": "Have questions about Zynez? Our team is ready to help.",
    "contact_email": "support@zynez.ai",
    "contact_phone": "+91 98765 43210",
    "contact_location": "Bengaluru, India",
    "contact_info_text": "24/7 available",
    "general_website_name": "Zynez",
    "general_footer_text": "Zynez — AI-powered camera surveillance that detects, understands and responds to events in real time.",
    "extend_platform_monthly_price": "1999",
    "extend_platform_yearly_price": "19999",
}

# (min, max) length bounds per field — deliberately NO charset
# restriction (unlike api/validators.py's validate_text_field /
# ADDRESS_CHARS_PATTERN): this is free-form marketing copy that needs
# apostrophes/punctuation ("Let's Make Your Cameras Smarter.", "13+...")
# a name/address charset would wrongly reject. Only required-non-blank +
# a generous max length is enforced; email/phone below get their own
# real validators instead.
_LENGTH_BOUNDS = {
    "heading": (1, 150),
    "description": (1, 500),
    "cta_text": (1, 60),
    "feature_text": (1, 200),
    "alert_text": (1, 100),
    "location": (1, 150),
    "info_text": (1, 200),
    "website_name": (1, 50),
    "footer_text": (1, 300),
}

FIELD_LABELS = {
    "heading": "Heading",
    "description": "Description",
    "cta_text": "CTA Text",
    "feature_text": "Detection Feature Text",
    "alert_text": "Alert Text",
    "email": "Email",
    "phone": "Phone",
    "location": "Location",
    "info_text": "Contact Information",
    "website_name": "Website Name",
    "footer_text": "Footer Text",
    "monthly_price": "Monthly Price (₹)",
    "yearly_price": "Yearly Price (₹)",
}


def init_website_content_table():
    """Table creation is handled by Base.metadata.create_all() in
    auth.database.init_db() — platform_settings already exists (it's the
    same table api/branding.py uses), so there is nothing to migrate.
    Kept only for the same startup-call symmetry every other api/*.py
    module's init_*_table() establishes."""


def _get_value(key):

    with get_session() as session:
        row = session.get(PlatformSetting, key)
        return row.value if row else None


def _set_value(key, value):

    with get_session() as session:
        row = session.get(PlatformSetting, key)

        if row is None:
            session.add(PlatformSetting(key=key, value=value))
        else:
            row.value = value


def _image_url(slot):

    filename = _get_value(f"website_{slot}_image_filename")
    if not filename:
        return None

    base = (os.environ.get("PUBLIC_BASE_URL") or "http://localhost:5000").rstrip("/")
    return f"{base}/public/website-content/image/{filename}"


def get_website_content():
    """Everything the public landing page (GET /public/website-content)
    and the Website Settings page both read. Every text field resolves
    to its saved value or DEFAULTS; every image slot resolves to an
    absolute URL or None (never uploaded — the frontend falls back to
    its own bundled static asset when None)."""

    content = {}

    for section, fields in SECTION_FIELDS.items():
        content[section] = {
            field: _get_value(f"website_{section}_{field}") or DEFAULTS[f"{section}_{field}"]
            for field in fields
        }

    for slot, section in IMAGE_SLOT_SECTION.items():
        content[section][IMAGE_SLOT_RESPONSE_KEY[slot]] = _image_url(slot)

    return content


def update_section(section_key, data):
    """Validates and persists the fields present in `data` for one
    section. Returns (get_website_content(), None), or (None, error) on
    the first validation failure — nothing is written until every
    present field passes."""

    if section_key not in SECTION_FIELDS:
        return None, "Unknown section."

    data = data or {}
    allowed_fields = SECTION_FIELDS[section_key]
    to_write = {}

    for field in allowed_fields:

        if field not in data:
            continue

        label = FIELD_LABELS.get(field, field)

        # Numeric fields arrive as a JSON number, not a string — validated
        # and stored before the generic (string-only) branches below ever
        # try to call .strip() on them. Same "float(), reject < 0" rule
        # api/module_packages.py's update_package uses for its own prices.
        if field in PRICE_FIELDS:
            try:
                parsed = float(data[field])
            except (TypeError, ValueError):
                return None, f"{label} must be a number."
            if parsed < 0:
                return None, f"{label} cannot be negative."
            to_write[field] = str(parsed)
            continue

        value = (data[field] or "").strip()

        if field == "email":
            error = validate_email(value)
        elif field == "phone":
            error = validate_phone(value)
        else:
            min_len, max_len = _LENGTH_BOUNDS[field]
            if not value:
                error = f"{label} is required."
            elif len(value) < min_len:
                error = f"{label} must be at least {min_len} characters."
            elif len(value) > max_len:
                error = f"{label} must be {max_len} characters or fewer."
            else:
                error = None

        if error:
            return None, error

        to_write[field] = value

    for field, value in to_write.items():
        _set_value(f"website_{section_key}_{field}", value)

    return get_website_content(), None


def _remove_image_file(filename):

    if not filename:
        return

    path = os.path.join(WEBSITE_FOLDER, filename)

    if not os.path.exists(path):
        return

    try:
        os.remove(path)
    except OSError:
        # Best-effort, same reasoning as api/branding.py's
        # _remove_logo_file — a leftover old file is harmless.
        pass


def update_image(slot_key, file):
    """Validates and saves a new image for one slot, replacing any
    previous one. Returns (get_website_content(), None), or (None,
    error) on validation failure."""

    if slot_key not in IMAGE_SLOTS:
        return None, "Unknown image slot."

    if file is None or not file.filename:
        return None, "No file was provided."

    ext = os.path.splitext(file.filename)[1].lower()

    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        return None, "Only JPG, JPEG, PNG, and WEBP images are supported."

    file_bytes = file.stream.read()
    file.stream.seek(0)

    error = validate_image_upload(file_bytes, ALLOWED_IMAGE_EXTENSIONS, MAX_IMAGE_SIZE_BYTES, label="Image")
    if error:
        return None, error

    os.makedirs(WEBSITE_FOLDER, exist_ok=True)

    filename_key = f"website_{slot_key}_image_filename"
    old_filename = _get_value(filename_key)
    new_filename = f"{slot_key}{ext}"

    if old_filename and old_filename != new_filename:
        _remove_image_file(old_filename)

    file.save(os.path.join(WEBSITE_FOLDER, new_filename))

    _set_value(filename_key, new_filename)

    return get_website_content(), None
