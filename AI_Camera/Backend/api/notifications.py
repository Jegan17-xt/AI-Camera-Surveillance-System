from datetime import datetime

from sqlalchemy import select, func

from db import get_session
from auth.models import Notification
from api.scope import apply_owner_scope

_DATETIME_FMT = "%d-%m-%Y %H:%M:%S"


def _serialize(row):
    return {
        "id": row.id,
        "type": row.type,
        "message": row.message,
        "is_read": bool(row.is_read),
        "camera_id": row.camera_id,
        "created_at": row.created_at,
    }


def get_notifications(customer_id, owner_user_id=None, unread_only=False, limit=50):

    with get_session() as session:
        query = select(Notification).where(Notification.customer_id == customer_id)
        query = apply_owner_scope(query, Notification.owner_user_id, owner_user_id)

        if unread_only:
            query = query.where(Notification.is_read == 0)

        query = query.order_by(Notification.id.desc()).limit(limit)

        rows = session.scalars(query).all()
        return [_serialize(r) for r in rows]


def get_unread_count(customer_id, owner_user_id=None):

    with get_session() as session:
        query = (
            select(func.count())
            .select_from(Notification)
            .where(Notification.customer_id == customer_id, Notification.is_read == 0)
        )
        query = apply_owner_scope(query, Notification.owner_user_id, owner_user_id)
        return session.scalar(query) or 0


def mark_notification_read(customer_id, notification_id, owner_user_id=None):

    with get_session() as session:
        query = select(Notification).where(
            Notification.id == notification_id, Notification.customer_id == customer_id
        )
        query = apply_owner_scope(query, Notification.owner_user_id, owner_user_id)
        row = session.scalar(query)

        if row is None:
            return False

        row.is_read = 1

    return True


def mark_all_read(customer_id, owner_user_id=None):

    with get_session() as session:
        query = session.query(Notification).filter(
            Notification.customer_id == customer_id, Notification.is_read == 0
        )
        query = apply_owner_scope(query, Notification.owner_user_id, owner_user_id)
        count = query.update({"is_read": 1})

    return count


def delete_notification(customer_id, notification_id, owner_user_id=None):

    with get_session() as session:
        query = select(Notification).where(
            Notification.id == notification_id, Notification.customer_id == customer_id
        )
        query = apply_owner_scope(query, Notification.owner_user_id, owner_user_id)
        row = session.scalar(query)

        if row is None:
            return False

        session.delete(row)

    return True


def create_notification(customer_id, owner_user_id, type, message, camera_id=None):
    """Called from face/unknown_manager.py (unknown-person alert) and
    camera/detection_service.py (camera-offline alert) — both already
    know exactly who owns the record/camera in question (owner_user_id
    may legitimately be None: an Unassigned camera's alert is still
    real, just only visible to the Company Admin, same rule as every
    other table)."""

    with get_session() as session:
        row = Notification(
            customer_id=customer_id,
            owner_user_id=owner_user_id,
            camera_id=camera_id,
            type=type,
            message=message,
            is_read=0,
            created_at=datetime.now().strftime(_DATETIME_FMT),
        )
        session.add(row)
        session.flush()
        return row.id
