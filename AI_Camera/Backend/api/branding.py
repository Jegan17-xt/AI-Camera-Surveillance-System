import os

from db import get_session
from auth.models import PlatformSetting
from api.validators import validate_text_field, validate_image_upload

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO_FOLDER = os.path.join(BASE_DIR, "dataset", "branding")

# Platform-wide identity — one value for the whole install, not scoped to
# any customer_id. Distinct from api/settings.py's per-customer
# app_settings table (camera/AI/notification preferences a customer
# configures for themselves); this is the Super Admin's own product
# branding, shown across the Super Admin portal.
DEFAULT_APP_NAME = "Sentinel Admin"

ALLOWED_LOGO_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024  # 5MB

APP_NAME_MIN_LENGTH = 3
APP_NAME_MAX_LENGTH = 50


def init_branding_table():
    """Table creation is handled by Base.metadata.create_all() in
    auth.database.init_db()."""


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


def get_branding():
    """Current platform branding — always returns a usable app_name (the
    saved one, or DEFAULT_APP_NAME if never set) and a logo_url only when
    a logo has actually been uploaded. This is what the Settings page
    loads on open and what every other Super Admin portal surface (the
    Sidebar, the browser tab title) should treat as "the app name" —
    never a hardcoded string."""

    app_name = _get_value("app_name") or DEFAULT_APP_NAME
    logo_filename = _get_value("logo_filename")

    logo_url = f"http://localhost:5000/branding/logo/{logo_filename}" if logo_filename else None

    return {"app_name": app_name, "logo_url": logo_url}


def update_app_name(name):
    """Validates and persists a new Application Name. Returns
    (branding, error) — branding is None on validation failure."""

    name = (name or "").strip()

    error = validate_text_field(
        name, "Application Name", min_len=APP_NAME_MIN_LENGTH, max_len=APP_NAME_MAX_LENGTH, address_like=True
    )
    if error:
        return None, error

    _set_value("app_name", name)

    return get_branding(), None


def _remove_logo_file(filename):

    if not filename:
        return

    path = os.path.join(LOGO_FOLDER, filename)

    if not os.path.exists(path):
        return

    try:
        os.remove(path)
    except OSError:
        # Best-effort: e.g. still momentarily held open by whatever last
        # served it (observed on Windows). Not fatal — the new/removed
        # state in the database is what matters, a leftover old file is
        # harmless.
        pass


def update_logo(file):
    """Validates and saves a new platform logo, replacing any previous
    one. Returns (branding, error) — branding is None on validation
    failure."""

    if file is None or not file.filename:
        return None, "No file was provided."

    ext = os.path.splitext(file.filename)[1].lower()

    if ext not in ALLOWED_LOGO_EXTENSIONS:
        return None, "Only JPG, JPEG, PNG, and WEBP images are supported."

    file_bytes = file.stream.read()
    file.stream.seek(0)

    error = validate_image_upload(file_bytes, ALLOWED_LOGO_EXTENSIONS, MAX_LOGO_SIZE_BYTES, label="Logo")
    if error:
        return None, error

    os.makedirs(LOGO_FOLDER, exist_ok=True)

    old_filename = _get_value("logo_filename")
    new_filename = f"logo{ext}"

    # A changed extension (e.g. png -> jpg) would otherwise leave the old
    # file behind forever alongside the new one.
    if old_filename and old_filename != new_filename:
        _remove_logo_file(old_filename)

    file.save(os.path.join(LOGO_FOLDER, new_filename))

    _set_value("logo_filename", new_filename)

    return get_branding(), None


def remove_logo():

    old_filename = _get_value("logo_filename")

    _remove_logo_file(old_filename)
    _set_value("logo_filename", "")

    return get_branding()