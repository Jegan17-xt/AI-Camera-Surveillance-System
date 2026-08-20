"""Shared input-validation helpers, used across users/cameras/settings/
registered-persons/attendance/branding/avatar so every endpoint rejects bad
input the same way instead of each module hand-rolling its own checks.

Every `validate_*` function returns `None` on success or a user-facing
message string on failure — the same convention api/cameras.py already
used for `_validate_camera_name` etc. before this module existed.
"""

import io
import re
from datetime import datetime

import numpy as np

EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PHONE_PATTERN = re.compile(r"^\d{10}$")
# WhatsApp recipient numbers are E.164-ish (optional leading '+', country
# code included, e.g. +919876543210) — deliberately looser than
# PHONE_PATTERN above (a strict 10-digit-only rule), since a WhatsApp
# number always carries a country code and this app has no fixed one.
WHATSAPP_NUMBER_PATTERN = re.compile(r"^\+?\d{8,15}$")
IPV4_PATTERN = re.compile(
    r"^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$"
)

# Plain names/identifiers: letters, numbers, spaces, hyphen, underscore only.
NAME_CHARS_PATTERN = re.compile(r"^[A-Za-z0-9 _-]+$")
# Address-like free text (Camera Location, Application Name) additionally
# allows the punctuation real addresses/titles actually need.
ADDRESS_CHARS_PATTERN = re.compile(r"^[A-Za-z0-9 _\-,.#]+$")

PASSWORD_MIN = 8
PASSWORD_MAX = 64
PASSWORD_COMPLEXITY_PATTERN = re.compile(
    r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$"
)

PORT_MIN = 1
PORT_MAX = 65535
CHANNEL_MIN = 1
CHANNEL_MAX = 256

MULTI_SPACE_PATTERN = re.compile(r" {2,}")

# Signature bytes for the formats we actually accept — the Pillow-free
# equivalent of a magic-byte / content-type sniff, using numpy + cv2
# (both already project dependencies) to attempt a real image decode
# rather than trusting the filename extension or the browser-supplied
# Content-Type header.
try:
    import cv2
except ImportError:  # pragma: no cover - cv2 is a hard project dependency
    cv2 = None


def normalize_text(value):
    """Trim outer whitespace and collapse internal runs of spaces to one,
    e.g. "  John   Doe  " -> "John Doe". Never rejects — just normalizes,
    so callers still run validate_text_field on the result."""

    return MULTI_SPACE_PATTERN.sub(" ", (value or "").strip())


def validate_text_field(value, label, min_len=1, max_len=100, required=True, address_like=False):
    """Generic Name/Location/Application-Name style field: required
    (unless required=False and blank), length bounds, and a restricted
    charset (letters/numbers/spaces/hyphen/underscore, plus `, . #` for
    address_like fields)."""

    value = normalize_text(value)

    if not value:
        if required:
            return f"{label} is required."
        return None

    if len(value) < min_len:
        return f"{label} must be at least {min_len} characters."

    if len(value) > max_len:
        return f"{label} must be {max_len} characters or fewer."

    pattern = ADDRESS_CHARS_PATTERN if address_like else NAME_CHARS_PATTERN

    if not pattern.match(value):
        if address_like:
            return f"{label} can only contain letters, numbers, spaces, hyphens, underscores, and , . #"
        return f"{label} can only contain letters, numbers, spaces, hyphens, and underscores."

    return None


def validate_email(value, required=True):

    value = (value or "").strip()

    if not value:
        if required:
            return "Please enter a valid email address."
        return None

    if not EMAIL_PATTERN.match(value):
        return "Please enter a valid email address."

    return None


def validate_phone(value, required=True):

    value = (value or "").strip()

    if not value:
        if required:
            return "Phone number is required."
        return None

    if not PHONE_PATTERN.match(value):
        return "Phone number must contain exactly 10 digits."

    return None


def validate_whatsapp_number(value, label="Recipient WhatsApp Number", required=True):

    value = (value or "").strip()

    if not value:
        if required:
            return f"{label} is required."
        return None

    if not WHATSAPP_NUMBER_PATTERN.match(value):
        return f"{label} must be a valid phone number with country code (e.g. +919876543210)."

    return None


def validate_ipv4(value, label="IP Address"):

    value = (value or "").strip()

    if not value:
        return f"{label} is required."

    if not IPV4_PATTERN.match(value):
        return f"{label} must be a valid IPv4 address."

    return None


def validate_port(value):

    try:
        port_int = int(value)
    except (TypeError, ValueError):
        return f"Port number must be between {PORT_MIN} and {PORT_MAX}."

    if port_int < PORT_MIN or port_int > PORT_MAX:
        return f"Port number must be between {PORT_MIN} and {PORT_MAX}."

    return None


def validate_channel(value):

    try:
        channel_int = int(value)
    except (TypeError, ValueError):
        return f"Channel Number must be between {CHANNEL_MIN} and {CHANNEL_MAX}."

    if channel_int < CHANNEL_MIN or channel_int > CHANNEL_MAX:
        return f"Channel Number must be between {CHANNEL_MIN} and {CHANNEL_MAX}."

    return None


def validate_password(value, label="Password", strong=True, max_len=PASSWORD_MAX):
    """strong=True enforces the full account-password policy (8-64 chars,
    upper/lower/digit/special). strong=False is for device credentials
    (camera/DVR passwords) — required + a sane max length only, since
    real-world DVRs frequently use short/numeric-only passwords that a
    strength policy would wrongly reject."""

    if not value:
        return f"{label} is required."

    if not strong:
        if len(value) > max_len:
            return f"{label} must be {max_len} characters or fewer."
        return None

    if len(value) < PASSWORD_MIN or len(value) > PASSWORD_MAX:
        return f"{label} must be between {PASSWORD_MIN} and {PASSWORD_MAX} characters."

    if not re.search(r"[a-z]", value):
        return f"{label} must contain at least one lowercase letter."

    if not re.search(r"[A-Z]", value):
        return f"{label} must contain at least one uppercase letter."

    if not re.search(r"\d", value):
        return f"{label} must contain at least one number."

    if not re.search(r"[^A-Za-z0-9]", value):
        return f"{label} must contain at least one special character."

    return None


def validate_number_range(value, label, min_value=None, max_value=None, integer=True):

    if isinstance(value, bool) or value is None:
        return f"{label} must be a number."

    try:
        number = int(value) if integer else float(value)
    except (TypeError, ValueError):
        return f"{label} must be a number."

    if integer and not isinstance(value, bool):
        # Reject "10.5" style values silently truncated by int() — a
        # non-integer number for a field that must be a whole number.
        try:
            if float(value) != number:
                return f"{label} must be a whole number."
        except (TypeError, ValueError):
            return f"{label} must be a number."

    if min_value is not None and number < min_value:
        return f"{label} must be between {min_value} and {max_value}."

    if max_value is not None and number > max_value:
        return f"{label} must be between {min_value} and {max_value}."

    return None


def validate_choice(value, label, allowed_values):

    if value not in allowed_values:
        return f"{label} must be one of: {', '.join(str(v) for v in allowed_values)}."

    return None


def validate_boolean(value, label):

    if not isinstance(value, bool):
        return f"{label} must be true or false."

    return None


def validate_calendar_date(value, label="Date", date_format="%d-%m-%Y", allow_future=True):
    """Unlike a regex-shape check, this rejects syntactically-plausible
    but impossible dates (e.g. 31-02-2026) by actually parsing them."""

    value = (value or "").strip()

    if not value:
        return f"{label} is required.", None

    try:
        parsed = datetime.strptime(value, date_format)
    except ValueError:
        return f"{label} is not a valid date.", None

    if not allow_future and parsed.date() > datetime.now().date():
        return f"{label} cannot be in the future.", None

    return None, parsed


def validate_month(value, label="Month", allow_future=True):

    value = (value or "").strip()

    if not value:
        return f"{label} is required.", None

    try:
        parsed = datetime.strptime(value, "%Y-%m")
    except ValueError:
        return f"{label} is not a valid month.", None

    if not allow_future:
        now = datetime.now()
        if (parsed.year, parsed.month) > (now.year, now.month):
            return f"{label} cannot be in the future.", None

    return None, parsed


# Real (non-animated) signature check for the four accepted formats —
# enough to reject a renamed non-image file without adding a new
# dependency, using cv2 (already required by camera/frame_processor.py).
def validate_image_upload(file_bytes, allowed_extensions, max_bytes, label="File"):
    """file_bytes: raw bytes already read from the upload. Returns None on
    success or a message string. Checks size and that the bytes actually
    decode as an image — catches a renamed .exe/.php passed off as .jpg,
    which extension-only checks (the previous behavior) can't."""

    if not file_bytes:
        return f"{label} is empty."

    if len(file_bytes) > max_bytes:
        max_mb = max_bytes // (1024 * 1024)
        return f"{label} must be {max_mb}MB or smaller."

    if cv2 is None:
        return None

    array = np.frombuffer(file_bytes, dtype=np.uint8)
    decoded = cv2.imdecode(array, cv2.IMREAD_UNCHANGED)

    if decoded is None:
        allowed = "/".join(ext.lstrip(".").upper() for ext in allowed_extensions)
        return f"{label} does not look like a valid {allowed} image."

    return None
