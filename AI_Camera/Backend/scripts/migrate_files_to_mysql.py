"""One-time data migration: existing CSV/.npy/filesystem-based
Registered Persons, Attendance, Unknown Persons, and Reports data ->
MySQL (via the SQLAlchemy models in Backend/auth/models.py).

Images and report CSV files themselves are left exactly where they are
— only structured metadata and embeddings move into MySQL. Safe to
re-run: every insert is skipped if an equivalent row already exists, so
running this twice never duplicates data.

Usage (from the Backend/ directory, with your .env already pointing at
a real, reachable MySQL server):

    python scripts/migrate_files_to_mysql.py
"""

import os
import csv
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db import Base, engine, get_session  # noqa: E402
from auth.models import RegisteredPerson, Attendance, UnknownPerson, Report  # noqa: E402
from sqlalchemy import select  # noqa: E402

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET_ROOT = os.path.join(BASE_DIR, "dataset", "customers")
ATTENDANCE_ROOT = os.path.join(BASE_DIR, "attendance", "customers")


def _customer_ids():
    """Every customer_id that has either a dataset/ or attendance/
    folder — the union of both, since a customer could plausibly have
    one without the other (e.g. registered persons but no attendance
    marked yet)."""

    ids = set()

    for root in (DATASET_ROOT, ATTENDANCE_ROOT):
        if os.path.isdir(root):
            for name in os.listdir(root):
                if name.isdigit() and os.path.isdir(os.path.join(root, name)):
                    ids.add(int(name))

    return sorted(ids)


def _migrate_registered_persons(session, customer_id):

    metadata_file = os.path.join(DATASET_ROOT, str(customer_id), "registered_metadata.csv")
    embeddings_folder = os.path.join(DATASET_ROOT, str(customer_id), "embeddings")

    if not os.path.exists(metadata_file):
        return 0, 0

    inserted, skipped = 0, 0

    with open(metadata_file, "r", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    for row in rows:

        name = (row.get("Name") or "").strip()

        if not name:
            continue

        existing = session.scalar(
            select(RegisteredPerson).where(
                RegisteredPerson.customer_id == customer_id,
                RegisteredPerson.person_name == name,
            )
        )

        if existing is not None:
            skipped += 1
            continue

        embedding_path = os.path.join(embeddings_folder, f"{name}.npy")
        blob = None
        status = "Incomplete"

        if os.path.exists(embedding_path):
            import numpy as np
            embeddings = np.load(embedding_path, allow_pickle=False).astype(np.float32)
            blob = embeddings.tobytes()
            status = "Active"

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        session.add(
            RegisteredPerson(
                customer_id=customer_id,
                admin_id=customer_id,
                person_name=name,
                employee_id=(row.get("Employee ID") or "").strip() or None,
                face_embedding=blob,
                status=status,
                created_at=now,
                updated_at=now,
            )
        )
        inserted += 1

    session.flush()

    return inserted, skipped


def _migrate_attendance(session, customer_id):

    attendance_file = os.path.join(ATTENDANCE_ROOT, str(customer_id), "attendance.csv")

    if not os.path.exists(attendance_file):
        return 0, 0

    persons_by_name = {
        p.person_name: p.id
        for p in session.scalars(
            select(RegisteredPerson).where(RegisteredPerson.customer_id == customer_id)
        ).all()
    }

    inserted, skipped = 0, 0

    with open(attendance_file, "r", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    for row in rows:

        name = (row.get("Name") or "").strip()
        date_str = (row.get("Date") or "").strip()

        if not name or not date_str or name not in persons_by_name:
            skipped += 1
            continue

        try:
            attendance_date = datetime.strptime(date_str, "%d-%m-%Y").date()
        except ValueError:
            skipped += 1
            continue

        person_id = persons_by_name[name]

        existing = session.scalar(
            select(Attendance).where(
                Attendance.customer_id == customer_id,
                Attendance.person_id == person_id,
                Attendance.attendance_date == attendance_date,
            )
        )

        if existing is not None:
            skipped += 1
            continue

        def _parse_time(value):
            value = (value or "").strip()
            if not value:
                return None
            try:
                return datetime.combine(attendance_date, datetime.strptime(value, "%H:%M:%S").time())
            except ValueError:
                return None

        check_in = _parse_time(row.get("In Time"))
        check_out = _parse_time(row.get("Out Time"))
        working_hours = None

        if check_in and check_out:
            working_hours = round((check_out - check_in).total_seconds() / 3600, 2)

        session.add(
            Attendance(
                customer_id=customer_id,
                admin_id=customer_id,
                person_id=person_id,
                attendance_date=attendance_date,
                check_in=check_in,
                check_out=check_out,
                working_hours=working_hours,
                attendance_status=(row.get("Status") or "Present").strip(),
                created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            )
        )
        inserted += 1

    session.flush()

    return inserted, skipped


def _migrate_unknown_persons(session, customer_id):

    database_file = os.path.join(DATASET_ROOT, str(customer_id), "unknown_database.csv")

    if not os.path.exists(database_file):
        return 0, 0

    inserted, skipped = 0, 0

    with open(database_file, "r", newline="") as f:
        rows = list(csv.reader(f))

    for row in rows:

        if len(row) < 6:
            continue

        _unknown_id, face_image, _embedding_file, first_seen, last_seen, detection_count = row[:6]

        frame_image = face_image.replace("unknown_", "frame_", 1)

        # No stable natural key survives from the old string ids (they're
        # not preserved as a column) — de-dupe by (customer_id,
        # image_path) instead, which is equally unique per capture.
        existing = session.scalar(
            select(UnknownPerson).where(
                UnknownPerson.customer_id == customer_id,
                UnknownPerson.image_path == face_image,
            )
        )

        if existing is not None:
            skipped += 1
            continue

        session.add(
            UnknownPerson(
                customer_id=customer_id,
                image_path=face_image,
                frame_image_path=frame_image,
                detected_time=first_seen,
                last_seen=last_seen,
                detection_count=int(detection_count) if str(detection_count).isdigit() else 1,
                created_at=first_seen,
            )
        )
        inserted += 1

    session.flush()

    return inserted, skipped


def _migrate_reports(session, customer_id):

    report_folder = os.path.join(ATTENDANCE_ROOT, str(customer_id), "attendance_reports")

    if not os.path.isdir(report_folder):
        return 0, 0

    inserted, skipped = 0, 0

    for filename in sorted(os.listdir(report_folder)):

        if not (filename.startswith("report_") and filename.endswith(".csv")):
            continue

        file_path = os.path.join(report_folder, filename)

        if not os.path.isfile(file_path):
            continue

        date_str = filename[len("report_"):-len(".csv")]

        existing = session.scalar(
            select(Report).where(Report.customer_id == customer_id, Report.file_path == filename)
        )

        if existing is not None:
            skipped += 1
            continue

        generated_at = datetime.fromtimestamp(os.path.getmtime(file_path)).strftime("%Y-%m-%d %H:%M:%S")

        session.add(
            Report(
                customer_id=customer_id,
                report_type="daily_attendance",
                report_name=f"Daily Attendance Report - {date_str}",
                generated_by="System",
                generated_at=generated_at,
                file_path=filename,
                status="Generated",
            )
        )
        inserted += 1

    session.flush()

    return inserted, skipped


def migrate():

    Base.metadata.create_all(bind=engine)

    customer_ids = _customer_ids()

    if not customer_ids:
        print("No existing per-customer dataset/attendance folders found — nothing to migrate.")
        return

    print(f"Found {len(customer_ids)} customer folder(s): {customer_ids}\n")

    for customer_id in customer_ids:

        print(f"--- Customer {customer_id} ---")

        with get_session() as session:
            p_ins, p_skip = _migrate_registered_persons(session, customer_id)
            print(f"  Registered Persons : {p_ins} inserted, {p_skip} already present")

            a_ins, a_skip = _migrate_attendance(session, customer_id)
            print(f"  Attendance          : {a_ins} inserted, {a_skip} skipped/already present")

            u_ins, u_skip = _migrate_unknown_persons(session, customer_id)
            print(f"  Unknown Persons     : {u_ins} inserted, {u_skip} already present")

            r_ins, r_skip = _migrate_reports(session, customer_id)
            print(f"  Reports             : {r_ins} inserted, {r_skip} already present")

    print("\nMigration complete. Images and report CSV files were left in place —")
    print("only their metadata/embeddings were copied into MySQL.")


if __name__ == "__main__":
    migrate()
