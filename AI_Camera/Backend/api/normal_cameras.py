from datetime import datetime

from sqlalchemy import select

from db import get_session
from auth.models import NormalCamera, to_dict
from api.validators import validate_text_field
from api.scope import apply_owner_scope
from auth.database import get_users_by_parent

# Deliberately generous but bounded — this is a free-text notes field,
# not a structured name/address, so (unlike camera_name/camera_location
# below) it isn't run through validate_text_field's restricted charset.
DESCRIPTION_MAX = 500

CAMERA_NAME_MIN = 3
CAMERA_NAME_MAX = 50
LOCATION_MAX = 100


def _validate_owner_user_id(customer_id, owner_user_id):
    """None (unassigned) is always fine. A real id must belong to one of
    THIS company's own Users — never trusted blind, never lets one
    company's camera be assigned to another company's User. Same idiom
    as api/cameras.py's _validate_owner_user_id."""

    if owner_user_id is None:
        return None

    company_user_ids = {u["id"] for u in get_users_by_parent(customer_id)}

    if owner_user_id not in company_user_ids:
        return "Selected user does not belong to this company."

    return None


def _validate_description(description):

    if not description:
        return None

    if len(description) > DESCRIPTION_MAX:
        return f"Description must be at most {DESCRIPTION_MAX} characters."

    return None


def _serialize(row):
    return {
        "id": row["id"],
        "customer_id": row["customer_id"],
        "camera_name": row["camera_name"],
        "camera_location": row["camera_location"],
        "description": row["description"] or "",
        "owner_user_id": row.get("owner_user_id"),
        "created_at": row["created_at"],
    }


def get_normal_cameras_for_customer(customer_id, owner_user_id=None):

    with get_session() as session:
        query = (
            select(NormalCamera)
            .where(NormalCamera.customer_id == customer_id)
            .order_by(NormalCamera.created_at.desc())
        )
        query = apply_owner_scope(query, NormalCamera.owner_user_id, owner_user_id)
        rows = session.scalars(query).all()
        return [_serialize(to_dict(r)) for r in rows]


def get_normal_camera(camera_id, customer_id, restrict_to_owner_user_id=None):
    """`restrict_to_owner_user_id`, when passed (a User caller, forced to
    their own id), restricts this to a camera that User actually owns —
    same Per-User Data Isolation idiom as api/cameras.py's get_camera."""

    with get_session() as session:
        query = select(NormalCamera).where(NormalCamera.id == camera_id, NormalCamera.customer_id == customer_id)
        query = apply_owner_scope(query, NormalCamera.owner_user_id, restrict_to_owner_user_id)
        row = session.scalar(query)
        return _serialize(to_dict(row)) if row else None


def add_normal_camera(customer_id, camera_name, camera_location, description, owner_user_id=None):

    camera_name = (camera_name or "").strip()
    camera_location = (camera_location or "").strip()
    description = (description or "").strip()

    error = (
        validate_text_field(camera_name, "Camera Name", min_len=CAMERA_NAME_MIN, max_len=CAMERA_NAME_MAX)
        or validate_text_field(camera_location, "Location", min_len=1, max_len=LOCATION_MAX, address_like=True)
        or _validate_description(description)
        or _validate_owner_user_id(customer_id, owner_user_id)
    )

    if error:
        return None, error

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with get_session() as session:
        row = NormalCamera(
            customer_id=customer_id,
            camera_name=camera_name,
            camera_location=camera_location,
            description=description or None,
            owner_user_id=owner_user_id,
            created_at=now,
        )
        session.add(row)
        session.flush()
        camera_id = row.id

    return get_normal_camera(camera_id, customer_id), None


def update_normal_camera(
    camera_id, customer_id, camera_name, camera_location, description, owner_user_id=None,
    restrict_to_owner_user_id=None,
):
    """`restrict_to_owner_user_id`, when passed (a User caller, forced to
    their own id server-side by api/routes.py — never trusted from the
    request body), restricts which existing camera this call can even
    find, so a User can never edit a sibling User's or the Admin's
    normal camera merely by guessing its id."""

    camera_name = (camera_name or "").strip()
    camera_location = (camera_location or "").strip()
    description = (description or "").strip()

    error = (
        validate_text_field(camera_name, "Camera Name", min_len=CAMERA_NAME_MIN, max_len=CAMERA_NAME_MAX)
        or validate_text_field(camera_location, "Location", min_len=1, max_len=LOCATION_MAX, address_like=True)
        or _validate_description(description)
        or _validate_owner_user_id(customer_id, owner_user_id)
    )

    if error:
        return None, error

    with get_session() as session:
        query = select(NormalCamera).where(NormalCamera.id == camera_id, NormalCamera.customer_id == customer_id)
        query = apply_owner_scope(query, NormalCamera.owner_user_id, restrict_to_owner_user_id)
        row = session.scalar(query)

        if row is None:
            return None, "Camera not found."

        row.camera_name = camera_name
        row.camera_location = camera_location
        row.description = description or None
        row.owner_user_id = owner_user_id

    return get_normal_camera(camera_id, customer_id, restrict_to_owner_user_id=restrict_to_owner_user_id), None


def delete_normal_camera(camera_id, customer_id, restrict_to_owner_user_id=None):

    with get_session() as session:
        query = select(NormalCamera).where(NormalCamera.id == camera_id, NormalCamera.customer_id == customer_id)
        query = apply_owner_scope(query, NormalCamera.owner_user_id, restrict_to_owner_user_id)
        row = session.scalar(query)

        if row is None:
            return False

        session.delete(row)

    return True
