"""One-time data migration: Backend/auth/users.db (SQLite, pre-migration)
-> the MySQL database configured in Backend/.env.

Safe to re-run: every insert is skipped if a row with that primary key
already exists in MySQL, so running this twice never duplicates data.

Usage (from the Backend/ directory, with your .env already pointing at
a real, reachable MySQL server):

    python scripts/migrate_sqlite_to_mysql.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db import Base, engine, get_session  # noqa: E402
from auth.database import DB_FILE, ROLE_USER, ROLE_COMPANY_ADMIN  # noqa: E402
from auth.models import (  # noqa: E402
    User,
    Permission,
    UserPermission,
    ActivityLog,
    Camera,
    AppSetting,
    PlatformSetting,
    CustomerAiSetting,
    Subscription,
    Payment,
)

# (SQLite table name, ORM model, primary-key column name(s) as they
# appear on the model) — migrated in FK-safe order: users and
# permissions first, everything that references them after.
TABLES = [
    ("users", User, "id"),
    ("permissions", Permission, "id"),
    ("user_permissions", UserPermission, "id"),
    ("activity_logs", ActivityLog, "id"),
    ("cameras", Camera, "camera_id"),
    ("app_settings", AppSetting, ("customer_id", "key")),
    ("platform_settings", PlatformSetting, "key"),
    ("customer_ai_settings", CustomerAiSetting, "id"),
    ("subscriptions", Subscription, "customer_id"),
    ("payments", Payment, "id"),
]


def _pk_value(row, pk):
    if isinstance(pk, tuple):
        return tuple(row[col] for col in pk)
    return row[pk]


def migrate():

    if not os.path.exists(DB_FILE):
        print(f"No SQLite database found at {DB_FILE} — nothing to migrate.")
        return

    print(f"Reading from {DB_FILE} ...")

    sqlite_conn = sqlite3.connect(DB_FILE)
    sqlite_conn.row_factory = sqlite3.Row

    # Every MySQL table must exist before rows can be inserted into it.
    Base.metadata.create_all(bind=engine)

    for table_name, model, pk in TABLES:

        try:
            rows = sqlite_conn.execute(f"SELECT * FROM {table_name}").fetchall()
        except sqlite3.OperationalError:
            print(f"  {table_name}: no such table in the SQLite source, skipping.")
            continue

        inserted, skipped = 0, 0

        with get_session() as session:
            for row in rows:
                row_dict = dict(row)
                existing = session.get(model, _pk_value(row_dict, pk))

                if existing is not None:
                    skipped += 1
                    continue

                # Pre-hierarchy data only ever had two roles: Super Admin,
                # and a single "User"-role login per company (what today's
                # schema calls Company Admin — the same account, just a
                # new label). Remap so every migrated account lands in
                # the tier it actually represents; new columns that don't
                # exist in the old schema (e.g. users.parent_admin_id)
                # simply aren't in row_dict, so the model falls back to
                # its own default (NULL — no parent) for them.
                if table_name == "users" and row_dict.get("role") == ROLE_USER:
                    row_dict["role"] = ROLE_COMPANY_ADMIN

                session.add(model(**row_dict))
                inserted += 1

        print(f"  {table_name}: {inserted} inserted, {skipped} already present.")

    sqlite_conn.close()
    print("Migration complete.")


if __name__ == "__main__":
    migrate()
