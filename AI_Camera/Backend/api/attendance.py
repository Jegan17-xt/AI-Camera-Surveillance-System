import os
import io
import csv
from datetime import datetime
from datetime import date as date_cls

from sqlalchemy import select, text

from db import get_session, engine
from auth.models import RegisteredPerson, Attendance, Report
from api.validators import validate_calendar_date, validate_month
from api.scope import apply_owner_scope

# Base Path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Report files themselves still live on disk (the raw-file download
# feature serves them directly) — only the attendance records and report
# metadata moved into MySQL. Same customer_id isolation boundary as
# every other module.
CUSTOMERS_ROOT = os.path.join(BASE_DIR, "attendance", "customers")


def init_attendance_table():
    """Per-User Data Isolation — owner_user_id backfill for an attendance
    table that predates this column, same idempotent pattern as
    api/cameras.py's init_cameras_table(). Must run after
    auth.database.init_db()."""

    with engine.connect() as conn:
        existing_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'"
                )
            )
        }

        if "owner_user_id" not in existing_columns:
            conn.execute(text("ALTER TABLE attendance ADD COLUMN owner_user_id INTEGER NULL"))
            conn.execute(text("ALTER TABLE attendance ADD INDEX idx_attendance_owner_user_id (owner_user_id)"))
            conn.execute(text(
                "ALTER TABLE attendance ADD CONSTRAINT fk_attendance_owner_user_id "
                "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL"
            ))
            conn.commit()

        # Query Performance — composite index matching the actual hot-path
        # predicate (customer_id + attendance_date together), same
        # "existing deployed DB predates this" backfill pattern as
        # owner_user_id above. Base.metadata.create_all() only creates
        # missing TABLES, never adds an index to one that's already
        # there — see auth/models.py's Attendance.__table_args__, which
        # only takes effect on a genuinely fresh database. Additive only;
        # every existing index is untouched.
        existing_indexes = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'"
                )
            )
        }

        if "ix_attendance_customer_date" not in existing_indexes:
            conn.execute(text(
                "ALTER TABLE attendance ADD INDEX ix_attendance_customer_date (customer_id, attendance_date)"
            ))
            conn.commit()


def _customer_root(customer_id):
    return os.path.join(CUSTOMERS_ROOT, str(customer_id))


def report_folder(customer_id):
    return os.path.join(_customer_root(customer_id), "attendance_reports")


def _row_to_dict(row, person_name):
    return {
        "name": person_name,
        "date": row.attendance_date.strftime("%d-%m-%Y") if row.attendance_date else "",
        "in_time": row.check_in.strftime("%H:%M:%S") if row.check_in else "",
        "out_time": row.check_out.strftime("%H:%M:%S") if row.check_out else "",
        "status": row.attendance_status or "",
    }


def get_attendance_records(customer_id, owner_user_id=None, limit=None, offset=None):
    """`limit`/`offset` (both default None — unbounded, identical to
    every existing caller's current behavior) optionally page the
    RETURNED records list only. present/absent are always computed from
    the FULL matching set BEFORE any slicing, never from just one page —
    the page shown must never change what these summary numbers say."""

    with get_session() as session:

        query = (
            select(Attendance, RegisteredPerson.person_name)
            .join(RegisteredPerson, RegisteredPerson.id == Attendance.person_id)
            .where(Attendance.customer_id == customer_id)
        )
        query = apply_owner_scope(query, Attendance.owner_user_id, owner_user_id)

        rows = session.execute(query).all()

        records = [_row_to_dict(attendance, name) for attendance, name in rows]

    present = sum(1 for r in records if r["status"] == "Present")
    total = len(records)
    absent = total - present

    if limit is not None or offset is not None:
        start = offset or 0
        end = (start + limit) if limit is not None else None
        records = records[start:end]

    return records, present, absent, total


def is_valid_date(date):
    """A real, existing DD-MM-YYYY calendar date that is not in the
    future — attendance can't exist for a date that hasn't happened yet.
    Used everywhere a date is looked up (report/download/export), so a
    shape-only match like "31-02-2026" or "99-99-9999" (which the old
    regex-only check accepted) is rejected the same way everywhere,
    instead of one endpoint being stricter than its sibling."""

    error, _parsed = validate_calendar_date(date, allow_future=False)
    return error is None


def is_valid_month(month):
    """A real YYYY-MM month that is not in the future."""

    error, _parsed = validate_month(month, allow_future=False)
    return error is None


def _attendance_rows_matching(customer_id, date_filter=None, month_filter=None, owner_user_id=None):

    query = (
        select(Attendance, RegisteredPerson.person_name)
        .join(RegisteredPerson, RegisteredPerson.id == Attendance.person_id)
        .where(Attendance.customer_id == customer_id)
    )
    query = apply_owner_scope(query, Attendance.owner_user_id, owner_user_id)

    if date_filter is not None:
        query = query.where(Attendance.attendance_date == date_filter)

    if month_filter is not None:
        year, mon = month_filter
        range_start = date_cls(year, mon, 1)
        # First day of the next month (December wraps to next January) —
        # an exclusive upper bound avoids needing a DB-specific
        # EXTRACT()/date-part function, portable across MySQL/SQLite.
        range_end = date_cls(year + 1, 1, 1) if mon == 12 else date_cls(year, mon + 1, 1)
        query = query.where(
            Attendance.attendance_date >= range_start,
            Attendance.attendance_date < range_end,
        )

    with get_session() as session:
        rows = session.execute(query).all()
        return [_row_to_dict(attendance, name) for attendance, name in rows]


def get_attendance_by_date(customer_id, date, owner_user_id=None):
    """Real per-person attendance rows for one exact DD-MM-YYYY date.
    Returns None for a malformed date so callers can tell "invalid" apart
    from "valid date, just nothing recorded"."""

    if not is_valid_date(date):
        return None

    parsed = datetime.strptime(date, "%d-%m-%Y").date()

    return _attendance_rows_matching(customer_id, date_filter=parsed, owner_user_id=owner_user_id)


def get_attendance_by_month(customer_id, month, owner_user_id=None):
    """Real per-person attendance rows for every date within a YYYY-MM month."""

    if not is_valid_month(month):
        return None

    year, mon = month.split("-")

    return _attendance_rows_matching(customer_id, month_filter=(int(year), int(mon)), owner_user_id=owner_user_id)


def delete_attendance_for_person(customer_id, name):
    """Cascade-delete: removes every attendance row for a person who was
    just deleted from Registered Persons, so the Attendance page and
    Reports can never keep showing attendance for someone who no longer
    exists. Attendance.person_id also has ON DELETE CASCADE at the DB
    level — this stays as an explicit, defensive second call site (and
    covers a DB that isn't enforcing the FK)."""

    if not name:
        return

    with get_session() as session:

        person = session.scalar(
            select(RegisteredPerson).where(
                RegisteredPerson.customer_id == customer_id,
                RegisteredPerson.person_name == name,
            )
        )

        if person is None:
            return

        session.query(Attendance).filter(
            Attendance.customer_id == customer_id, Attendance.person_id == person.id
        ).delete()


def rename_attendance_person(customer_id, old_name, new_name):
    """No-op — Attendance now references a person by a stable person_id
    (RegisteredPerson.id), not by name, so a rename in Registered Persons
    is already reflected everywhere attendance is displayed (the name is
    joined live from RegisteredPerson) without touching any Attendance
    row. Kept as a function so api/registered.py's existing call site
    doesn't need to change."""


def clear_attendance_records(customer_id, owner_user_id=None):
    """Wipes attendance rows for this customer — used by Settings >
    Storage > Clear Attendance Logs. `owner_user_id` (passed as the
    caller's own id when they're a User, never trusted otherwise) is a
    real fix bundled into the Per-User Data Isolation work: this route
    was previously reachable by any User with the `attendance` module
    and unconditionally wiped the WHOLE company's attendance, including
    every other User's and the Admin's — it's now restricted to that
    User's own rows, exactly like every other User-facing mutation."""

    with get_session() as session:
        query = session.query(Attendance).filter(Attendance.customer_id == customer_id)
        query = apply_owner_scope(query, Attendance.owner_user_id, owner_user_id)
        query.delete()


def records_to_csv_bytes(records):

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow(["Name", "Date", "In Time", "Out Time", "Status"])

    for r in records:
        writer.writerow([r["name"], r["date"], r["in_time"], r["out_time"], r["status"]])

    return output.getvalue().encode("utf-8")


def get_daily_report(customer_id, date):

    if not is_valid_date(date):
        return None

    report_file = os.path.join(report_folder(customer_id), f"report_{date}.csv")

    if not os.path.exists(report_file):
        return None

    with open(report_file, "r", newline="") as file:
        reader = csv.DictReader(file)
        rows = [row for row in reader]

    return rows


def get_report_filename(customer_id, date):

    if not is_valid_date(date):
        return None

    filename = f"report_{date}.csv"

    if not os.path.exists(os.path.join(report_folder(customer_id), filename)):
        return None

    return filename


def delete_attendance_reports_older_than(customer_id, cutoff_dt):
    """Data Retention (api/retention_settings.py): deletes old generated
    Daily Attendance CSV exports — the `Report` metadata row plus its
    report_{DD-MM-YYYY}.csv file under report_folder() — whose
    generated_at is strictly older than cutoff_dt. generated_at is a
    "%Y-%m-%d %H:%M:%S" string (attendance/report_generator.py's own
    format). Deliberately never touches the Attendance table itself
    (individual check-in/check-out records) — those are ongoing
    attendance history, not "captured" data this policy covers."""

    with get_session() as session:

        rows = session.scalars(
            select(Report).where(Report.customer_id == customer_id, Report.report_type == "daily_attendance")
        ).all()

        deleted_count = 0
        folder = report_folder(customer_id)

        for row in rows:
            try:
                generated_at = datetime.strptime(row.generated_at, "%Y-%m-%d %H:%M:%S")
            except (TypeError, ValueError):
                continue

            if generated_at < cutoff_dt:
                if row.file_path:
                    file_path = os.path.join(folder, row.file_path)
                    if os.path.exists(file_path):
                        os.remove(file_path)
                session.delete(row)
                deleted_count += 1

    return deleted_count
