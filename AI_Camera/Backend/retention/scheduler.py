"""Data Retention scheduler — a single background daemon thread, same
plain-threading style reports/scheduler.py already uses (no new
dependency like APScheduler). Started once from api/app.py, guarded by
the same WERKZEUG_RUN_MAIN check start_all_enabled_cameras() and
start_report_scheduler() use, so Flask's debug-mode reloader can never
start two competing scheduler threads.

Every company defaults to "permanent" (see api/retention_settings.py's
DEFAULT_POLICY) — a company is only ever swept once a Super Admin has
explicitly set its policy to "7_days" or "1_month" on the Admin & User
Overview page. Each sweep re-derives a fresh cutoff datetime from
"now", so the actual age check always happens at delete time, on the
real stored timestamp of each row — never a cached/stale decision.
"""

import threading
import time
from datetime import datetime, timedelta

from sqlalchemy import select

from db import get_session
from auth.database import ROLE_COMPANY_ADMIN
from auth.models import User
from error_logging import log_exception
from api.retention_settings import get_all_retention_policies, RETENTION_DAYS, DEFAULT_POLICY
from api.unknown import delete_unknown_persons_older_than
from api.attendance import delete_attendance_reports_older_than
from reports.daily_report import delete_report_logs_older_than

# Daily-granularity policies don't need 30-second precision like the
# report-delivery scheduler's HH:MM matching does — hourly is frequent
# enough that a policy change or backend restart never leaves stale
# data around for long, while staying cheap (a handful of per-company
# queries per tick).
_CHECK_INTERVAL_SECONDS = 3600

_scheduler_thread = None
_scheduler_lock = threading.Lock()


def _all_company_admin_ids():

    with get_session() as session:
        return list(session.scalars(select(User.id).where(User.role == ROLE_COMPANY_ADMIN)).all())


def _sweep_company(customer_id, policy):

    days = RETENTION_DAYS.get(policy)

    if not days:  # "permanent" (or an unrecognized value) -> automatic deletion stays fully disabled
        return

    cutoff_dt = datetime.now() - timedelta(days=days)

    deleted_unknown = delete_unknown_persons_older_than(customer_id, cutoff_dt)
    deleted_report_pdfs = delete_report_logs_older_than(customer_id, cutoff_dt)
    deleted_attendance_csv = delete_attendance_reports_older_than(customer_id, cutoff_dt)

    if deleted_unknown or deleted_report_pdfs or deleted_attendance_csv:
        print(
            f"[RETENTION SCHEDULER] customer={customer_id} policy={policy} cutoff={cutoff_dt} — "
            f"deleted unknown_persons={deleted_unknown} report_pdfs={deleted_report_pdfs} "
            f"attendance_csv={deleted_attendance_csv}"
        )


def _tick():

    policies = get_all_retention_policies()

    for customer_id in _all_company_admin_ids():
        try:
            _sweep_company(customer_id, policies.get(customer_id, DEFAULT_POLICY))
        except Exception as e:
            # One company's failure must never stop the sweep from
            # checking every other company this same tick.
            log_exception(e, f"retention scheduler tick (customer={customer_id})")


def _scheduler_loop():

    print("[RETENTION SCHEDULER] Data retention scheduler started")

    while True:
        try:
            _tick()
        except Exception as e:
            log_exception(e, "retention scheduler loop")

        time.sleep(_CHECK_INTERVAL_SECONDS)


def start_retention_scheduler():
    """Idempotent — a second call while the thread is already running is
    a no-op. Called once at backend boot (api/app.py)."""

    global _scheduler_thread

    with _scheduler_lock:

        if _scheduler_thread is not None and _scheduler_thread.is_alive():
            return

        _scheduler_thread = threading.Thread(target=_scheduler_loop, daemon=True)
        _scheduler_thread.start()
