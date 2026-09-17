from datetime import datetime

from sqlalchemy import select, text

from db import get_session, engine
from auth.models import Lead, to_dict
from api.validators import validate_text_field, validate_phone, validate_email, validate_choice, normalize_text

# Anonymous visitor capture — the landing page's Interest & Lead popup
# AND its Contact section form (Frontend/Ai_FE/src/pages/Landing.jsx)
# both submit here, tagged with which one via `source`. Stored here and
# surfaced to the Super Admin at GET /leads (see api/routes.py,
# Frontend/Ai_FE/src/super-admin/pages/AdminLeads.jsx). No link to any
# `users` row — a lead is not an account.

NAME_MAX = 100
PHONE_MAX = 30
ADDRESS_MAX = 255
LEAD_SOURCES = ["Landing Page", "Contact Page"]


def init_leads_table():
    """Table creation itself is handled by Base.metadata.create_all() in
    auth.database.init_db() (`leads` was brand-new when this table was
    added, nothing to migrate then).

    `source` was added after that — same added-after-the-table-already-
    existed situation as api/cameras.py's init_cameras_table() docstring
    describes for detection_enabled. NOT NULL DEFAULT 'Landing Page'
    backfills every pre-existing row to the only source that existed
    before the Contact page form was wired up to this same table.

    latitude/longitude were added later still — both NULLable with no
    DEFAULT, so this ALTER TABLE is a pure additive, safe migration: it
    never touches, recreates, or drops any existing row or column, and
    every pre-existing lead simply backfills to NULL/NULL (exactly the
    same value new leads get whenever location permission wasn't
    granted), never breaking a single existing row."""

    with engine.connect() as conn:
        existing_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'"
                )
            )
        }

        if "source" not in existing_columns:
            conn.execute(text("ALTER TABLE leads ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'Landing Page'"))
            conn.commit()

        if "latitude" not in existing_columns:
            conn.execute(text("ALTER TABLE leads ADD COLUMN latitude FLOAT NULL"))
            conn.commit()

        if "longitude" not in existing_columns:
            conn.execute(text("ALTER TABLE leads ADD COLUMN longitude FLOAT NULL"))
            conn.commit()


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _clean_coordinate(value, min_value, max_value):
    """Best-effort parse + range check for one GPS coordinate. Returns a
    float, or None for anything not usable — missing, blank, non-numeric,
    or out of physical range. NEVER raises and NEVER blocks lead
    creation: an unusable/tampered coordinate is silently treated the
    same as "location permission wasn't granted", per this feature's
    explicit requirement that a Lead submission can never be rejected
    over location data. A real navigator.geolocation reading can never
    actually be out of range, so this only ever catches a malformed
    request, not a normal denial/timeout (those simply never send a
    value at all — see Frontend/Ai_FE/src/lib/geolocation.js)."""

    if value is None or value == "":
        return None

    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    if number != number:  # NaN
        return None

    if number < min_value or number > max_value:
        return None

    return number


def list_leads():

    with get_session() as session:
        rows = session.scalars(select(Lead).order_by(Lead.id.desc())).all()
        return [to_dict(r) for r in rows]


def create_lead(name, phone, address, email, source="Landing Page", latitude=None, longitude=None):
    """Validates and stores one lead submission (popup or Contact page
    form). Returns (lead_dict, None, is_new), or (None, error, False) on
    the first validation failure.

    latitude/longitude are entirely optional, best-effort GPS metadata
    (browser Geolocation API — see Frontend/Ai_FE/src/lib/geolocation.js
    and public_leads_create). Never validated as required fields and
    never able to fail/block a submission — an unusable value (missing,
    non-numeric, out of range) is silently stored as NULL via
    _clean_coordinate, exactly like a real permission denial/timeout is.

    `is_new` is False for a duplicate-phone update — NOT derivable by a
    caller comparing lead_dict's own created_at/updated_at afterwards:
    both are set to the same `_now()` string on a genuine insert, but a
    fast-enough duplicate update (same wall-clock second — _now() only
    has second precision) sets updated_at to that SAME string too,
    without ever touching created_at, so the two can coincidentally
    match on an update as well. api/routes.py's public_leads_create
    uses this flag alone to decide whether to fire a "New Lead" push
    notification (notifications/fcm.py) — never on a duplicate/merge.

    Duplicate phone numbers: the same visitor submitting again (from
    either form, e.g. skipping the popup earlier then filling the
    Contact form, or resubmitting) updates their existing row in place
    — matched by phone — instead of inserting a second row for the same
    person. `source` is overwritten to whichever form they just used,
    since that's the most recent, most relevant touchpoint."""

    error = validate_text_field(name, "Name", min_len=1, max_len=NAME_MAX)
    if error:
        return None, error, False

    error = validate_phone(phone)
    if error:
        return None, error, False

    address = normalize_text(address)
    if address:
        error = validate_text_field(address, "Address", min_len=1, max_len=ADDRESS_MAX, address_like=True)
        if error:
            return None, error, False

    email = (email or "").strip()
    if email:
        error = validate_email(email)
        if error:
            return None, error, False

    error = validate_choice(source, "Source", LEAD_SOURCES)
    if error:
        return None, error, False

    name = normalize_text(name)
    phone = phone.strip()
    latitude = _clean_coordinate(latitude, -90, 90)
    longitude = _clean_coordinate(longitude, -180, 180)
    # A coordinate pair is only meaningful together — a lone value (the
    # other missing/invalid) is not a usable location, so it's dropped
    # entirely rather than stored half-complete.
    if latitude is None or longitude is None:
        latitude = None
        longitude = None

    with get_session() as session:
        now = _now()
        existing = session.scalar(select(Lead).where(Lead.phone == phone))
        is_new = existing is None

        if existing is not None:
            existing.name = name
            existing.address = address or None
            existing.email = email or None
            existing.source = source
            # Only overwrite previously-saved coordinates when THIS
            # submission actually provided a usable pair — a repeat
            # visitor whose second submission denied location must never
            # erase real coordinates captured on an earlier one.
            if latitude is not None and longitude is not None:
                existing.latitude = latitude
                existing.longitude = longitude
            existing.updated_at = now
            session.flush()
            lead_dict = to_dict(existing)
        else:
            row = Lead(
                name=name,
                phone=phone,
                address=address or None,
                email=email or None,
                source=source,
                latitude=latitude,
                longitude=longitude,
                created_at=now,
                updated_at=now,
            )
            session.add(row)
            session.flush()
            lead_dict = to_dict(row)

    return lead_dict, None, is_new


def delete_lead(lead_id):

    with get_session() as session:
        row = session.get(Lead, lead_id)

        if row is None:
            return False

        session.delete(row)
        return True
