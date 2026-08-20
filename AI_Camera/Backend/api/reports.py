import os
from collections import defaultdict
from datetime import datetime

from sqlalchemy import select

from db import get_session
from auth.models import Report, Attendance, RegisteredPerson
from api.attendance import report_folder, get_attendance_by_date, is_valid_date, _row_to_dict
from api.registered import get_registered_persons
from api.scope import apply_owner_scope

REPORT_PREFIX = "report_"
REPORT_SUFFIX = ".csv"


def _date_from_filename(filename):

    if not filename.startswith(REPORT_PREFIX) or not filename.endswith(REPORT_SUFFIX):
        return None

    return filename[len(REPORT_PREFIX):-len(REPORT_SUFFIX)]


def _sort_key(report):

    try:
        return datetime.strptime(report["date"], "%d-%m-%Y")
    except ValueError:
        return datetime.min


def get_reports(customer_id, owner_user_id=None):
    """Lists this customer's daily-report metadata from MySQL (no more
    os.listdir() on attendance_reports/) but computes Total Records/
    Present/Absent live rather than from anything stored in the row —
    same behavior as before this migration.

    The `reports` rows themselves (one per calendar date) stay
    company-wide — Per-User Data Isolation only scopes the LIVE numbers
    rendered per report (Total Records/Present/Absent), via
    `owner_user_id`, so what's shown matches whatever scope (Admin's
    selected User, Unassigned, or a User's own self-view) is active,
    without needing a separate Report row per User.

    Total Records = the CURRENT total number of Registered Persons for
    this customer (not a count of attendance rows, and not a historical
    snapshot) — loaded fresh from get_registered_persons(customer_id),
    the same function the Registered Persons page and Dashboard use.

    Present = the live number of people actually marked present on that
    report's date (get_attendance_by_date — the exact same call
    get_report_content() uses for the View Report dialog, so the two can
    never disagree).

    Absent = Total Records - Present."""

    with get_session() as session:
        rows = session.scalars(
            select(Report)
            .where(Report.customer_id == customer_id, Report.report_type == "daily_attendance")
            .order_by(Report.generated_at.desc())
        ).all()
        report_rows = [(r.file_path, r.generated_at) for r in rows]

    _, total_registered = get_registered_persons(customer_id, owner_user_id=owner_user_id)

    # --- N+1 fix: batch the Present-count lookup ---
    # Previously called get_attendance_by_date() — its own get_session()
    # + query — once PER REPORT ROW, i.e. one DB round trip per calendar
    # date this customer has ever generated a report for (one report row
    # accumulates per day the system runs). Parsing/validating every
    # report's date up front lets this run ONE query for every needed
    # date at once (Attendance.attendance_date.in_(...)), grouped by date
    # in Python — same per-report Present/Absent numbers as before, just
    # not one query each.
    parsed_reports = []  # (file_path, generated_at, date_str, parsed_date_or_None)
    valid_dates = set()

    for file_path, generated_at in report_rows:

        date_str = _date_from_filename(file_path or "")

        if date_str is None:
            continue

        parsed_date = None

        if is_valid_date(date_str):
            parsed_date = datetime.strptime(date_str, "%d-%m-%Y").date()
            valid_dates.add(parsed_date)

        parsed_reports.append((file_path, generated_at, date_str, parsed_date))

    records_by_date = defaultdict(list)

    if valid_dates:
        query = (
            select(Attendance, RegisteredPerson.person_name)
            .join(RegisteredPerson, RegisteredPerson.id == Attendance.person_id)
            .where(Attendance.customer_id == customer_id, Attendance.attendance_date.in_(valid_dates))
        )
        query = apply_owner_scope(query, Attendance.owner_user_id, owner_user_id)

        with get_session() as session:
            for attendance, name in session.execute(query).all():
                records_by_date[attendance.attendance_date].append(_row_to_dict(attendance, name))

    reports = []

    for file_path, generated_at, date_str, parsed_date in parsed_reports:

        live_records = records_by_date.get(parsed_date, []) if parsed_date is not None else []
        present = len(live_records)
        absent = max(total_registered - present, 0)

        reports.append(
            {
                "date": date_str,
                "file_name": file_path,
                "total_records": total_registered,
                "present": present,
                "absent": absent,
                "created_time": generated_at,
                "download_url": f"/reports/download/{file_path}",
            }
        )

    reports.sort(key=_sort_key, reverse=True)

    return reports


def get_report_filepath(customer_id, filename):

    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        return None

    with get_session() as session:
        exists = session.scalar(
            select(Report.id).where(Report.customer_id == customer_id, Report.file_path == filename)
        )

    if exists is None:
        return None

    file_path = os.path.join(report_folder(customer_id), filename)

    if not os.path.isfile(file_path):
        return None

    return filename


def get_report_content(customer_id, filename, owner_user_id=None):
    """The report_*.csv files only store an aggregate daily summary row,
    so the per-person Name/In Time/Out Time/Status view is built by
    filtering this customer's Attendance rows down to this report's date
    — the exact same call get_reports() uses for its Present count, so
    the two can never disagree on who was actually present."""

    date = _date_from_filename(filename)

    if date is None:
        return None

    with get_session() as session:
        exists = session.scalar(
            select(Report.id).where(Report.customer_id == customer_id, Report.file_path == filename)
        )

    if exists is None:
        return None

    return get_attendance_by_date(customer_id, date, owner_user_id=owner_user_id) or []
