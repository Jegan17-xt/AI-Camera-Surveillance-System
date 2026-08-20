import os
from datetime import datetime

from sqlalchemy import select, text, func

from db import get_session, engine
from auth.models import UnknownPerson
from api.scope import apply_owner_scope

# Base Path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Unknown-person images stay filesystem-based (per the storage-migration
# spec — only structured metadata and embeddings moved to MySQL). Same
# isolation boundary as api/registered.py.
CUSTOMERS_ROOT = os.path.join(BASE_DIR, "dataset", "customers")


def init_unknown_persons_table():
    """Per-User Data Isolation — owner_user_id backfill for an
    unknown_persons table that predates this column, same idempotent
    pattern as api/cameras.py's init_cameras_table(). Must run after
    auth.database.init_db()."""

    with engine.connect() as conn:
        existing_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unknown_persons'"
                )
            )
        }

        if "owner_user_id" not in existing_columns:
            conn.execute(text("ALTER TABLE unknown_persons ADD COLUMN owner_user_id INTEGER NULL"))
            conn.execute(text("ALTER TABLE unknown_persons ADD INDEX idx_unknown_persons_owner_user_id (owner_user_id)"))
            conn.execute(text(
                "ALTER TABLE unknown_persons ADD CONSTRAINT fk_unknown_persons_owner_user_id "
                "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL"
            ))
            conn.commit()

        # Query Performance — composite index matching the actual hot-path
        # predicate (customer_id + detected_time together, see
        # api/unknown_analytics.py), same backfill pattern as
        # owner_user_id above — see auth/models.py's
        # UnknownPerson.__table_args__ for the fresh-database side of
        # this. Additive only; every existing index is untouched.
        existing_indexes = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unknown_persons'"
                )
            )
        }

        if "ix_unknown_persons_customer_detected" not in existing_indexes:
            conn.execute(text(
                "ALTER TABLE unknown_persons ADD INDEX ix_unknown_persons_customer_detected "
                "(customer_id, detected_time)"
            ))
            conn.commit()


def _customer_root(customer_id):
    return os.path.join(CUSTOMERS_ROOT, str(customer_id))


def unknown_folder(customer_id):
    return os.path.join(_customer_root(customer_id), "unknown")


def unknown_image_owner_ok(customer_id, filename, owner_user_id=None):
    """Per-User Data Isolation: existence+ownership gate for serving a
    single unknown-person face/frame image by filename — without this, a
    User could view a sibling User's (or the Admin's) unknown-person
    image just by guessing/copying a filename from another tab, even
    though the LIST is already filtered. Checked against both
    image_path and frame_image_path since either one may be requested."""

    with get_session() as session:
        query = select(UnknownPerson.id).where(
            UnknownPerson.customer_id == customer_id,
            (UnknownPerson.image_path == filename) | (UnknownPerson.frame_image_path == filename),
        )
        query = apply_owner_scope(query, UnknownPerson.owner_user_id, owner_user_id)
        return session.scalar(query) is not None


def get_unknown_persons(customer_id, owner_user_id=None, limit=None, offset=None):
    """Returns (result, total). `limit`/`offset` are optional (default
    None — unbounded, byte-for-byte the same query/response every
    existing caller already gets) — added so this endpoint can safely
    support paging for a customer whose unknown-person history has grown
    large, without changing behavior for anyone who doesn't ask for a
    page. `total` is always the FULL matching row count (a separate
    COUNT query), never just the size of whatever page was returned."""

    with get_session() as session:
        base_query = select(UnknownPerson).where(UnknownPerson.customer_id == customer_id)
        base_query = apply_owner_scope(base_query, UnknownPerson.owner_user_id, owner_user_id)

        total = session.scalar(select(func.count()).select_from(base_query.subquery()))

        query = base_query.order_by(UnknownPerson.id.desc())

        if offset is not None:
            query = query.offset(offset)
        if limit is not None:
            query = query.limit(limit)

        rows = session.scalars(query).all()

        result = [
            {
                "id": row.id,
                "face_image": f"http://localhost:5000/unknown/{row.image_path}" if row.image_path else None,
                "frame_image": f"http://localhost:5000/unknown/{row.frame_image_path}" if row.frame_image_path else None,
                "first_seen": row.detected_time,
                "last_seen": row.last_seen,
                "detection_count": row.detection_count,
                "status": "Unknown",
            }
            for row in rows
        ]

    return result, total or 0


def _remove_unknown_files(customer_id, image_path, frame_image_path):

    for path in (
        os.path.join(unknown_folder(customer_id), image_path) if image_path else None,
        os.path.join(unknown_folder(customer_id), frame_image_path) if frame_image_path else None,
    ):
        if path and os.path.exists(path):
            os.remove(path)


def _parse_unknown_id(unknown_id):
    """unknown_id used to be a string like "UNK007"; it's now a plain
    MySQL auto-increment integer, but the DELETE route's URL param is
    still an untyped string — accept either shape defensively. Python's
    int() already handles a leading-zero decimal string correctly
    (int("007") == 7), so only the old "UNK" prefix needs stripping."""

    text = str(unknown_id).strip()

    if text.upper().startswith("UNK"):
        text = text[3:]

    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def delete_unknown_person(customer_id, unknown_id, owner_user_id=None):

    target_id = _parse_unknown_id(unknown_id)

    if target_id is None:
        return False

    with get_session() as session:

        query = select(UnknownPerson).where(UnknownPerson.id == target_id, UnknownPerson.customer_id == customer_id)
        query = apply_owner_scope(query, UnknownPerson.owner_user_id, owner_user_id)
        row = session.scalar(query)

        if row is None:
            return False

        _remove_unknown_files(customer_id, row.image_path, row.frame_image_path)
        session.delete(row)

    return True


def delete_multiple_unknown_persons(customer_id, unknown_ids, owner_user_id=None):
    """Deletes several unknown persons in a single pass."""

    target_ids = {_parse_unknown_id(i) for i in (unknown_ids or [])}
    target_ids.discard(None)

    if not target_ids:
        return 0

    with get_session() as session:

        query = select(UnknownPerson).where(
            UnknownPerson.id.in_(target_ids), UnknownPerson.customer_id == customer_id
        )
        query = apply_owner_scope(query, UnknownPerson.owner_user_id, owner_user_id)
        rows = session.scalars(query).all()

        deleted_count = 0

        for row in rows:
            _remove_unknown_files(customer_id, row.image_path, row.frame_image_path)
            session.delete(row)
            deleted_count += 1

    return deleted_count


def delete_all_unknown_persons(customer_id, owner_user_id=None):
    """Deletes unknown persons for this customer (optionally restricted
    to one owner_user_id scope): database rows and every saved
    face/frame image file."""

    with get_session() as session:

        query = select(UnknownPerson).where(UnknownPerson.customer_id == customer_id)
        query = apply_owner_scope(query, UnknownPerson.owner_user_id, owner_user_id)
        rows = session.scalars(query).all()

        deleted_count = 0

        for row in rows:
            _remove_unknown_files(customer_id, row.image_path, row.frame_image_path)
            session.delete(row)
            deleted_count += 1

    return deleted_count


def delete_unknown_persons_older_than(customer_id, cutoff_dt):
    """Data Retention (api/retention_settings.py): deletes every
    UnknownPerson row (+ its face/frame image files) for this customer
    whose detected_time is strictly older than cutoff_dt. detected_time
    is a "%d-%m-%Y %H:%M:%S" string (this codebase's convention, see
    auth/models.py) — not lexically sortable, so every row is parsed and
    compared in Python rather than with a SQL string comparison. A
    malformed/unparseable row is skipped, never guessed at, so a bad
    legacy row can't cause an unintended delete."""

    with get_session() as session:

        rows = session.scalars(
            select(UnknownPerson).where(UnknownPerson.customer_id == customer_id)
        ).all()

        deleted_count = 0

        for row in rows:
            try:
                detected_at = datetime.strptime(row.detected_time, "%d-%m-%Y %H:%M:%S")
            except (TypeError, ValueError):
                continue

            if detected_at < cutoff_dt:
                _remove_unknown_files(customer_id, row.image_path, row.frame_image_path)
                session.delete(row)
                deleted_count += 1

    return deleted_count
