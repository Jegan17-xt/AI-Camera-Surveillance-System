"""Daily Report scheduler — a single background daemon thread, same
plain-threading style camera/detection_service.py already uses (no new
dependency like APScheduler). Started once from api/app.py, guarded by
the same WERKZEUG_RUN_MAIN check start_all_enabled_cameras() uses, so
Flask's debug-mode reloader can never start two competing scheduler
threads.

Duplicate-generation protection is NOT time-based in-memory state here
(that would reset on every restart) — it's delegated entirely to
reports.daily_report.generate_and_send_daily_report's own DB-backed
idempotency check (a ReportLog row already existing for that date), so
"don't generate twice" holds even across a backend restart.
"""

import threading
import time
from datetime import datetime

from sqlalchemy import select

from db import get_session
from auth.database import ROLE_COMPANY_ADMIN, get_users_by_parent
from auth.models import User
from error_logging import log_exception
from api.notification_settings import get_notification_settings
from api.user_notification_settings import get_user_notification_settings
from reports.daily_report import generate_and_send_daily_report, send_daily_unknown_count

# Coarse enough to be cheap (one lightweight settings read per company
# admin per tick), fine enough that a configured HH:MM is never missed
# by more than half a minute.
_CHECK_INTERVAL_SECONDS = 30

_scheduler_thread = None
_scheduler_lock = threading.Lock()


def _all_company_admin_ids():

    with get_session() as session:
        return list(session.scalars(select(User.id).where(User.role == ROLE_COMPANY_ADMIN)).all())


def _tick():

    current_hhmm = datetime.now().strftime("%H:%M")

    for customer_id in _all_company_admin_ids():
        try:
            settings = get_notification_settings(customer_id)

            # Company-level toggle is the master kill switch for the
            # company-wide report AND every User's own personalized
            # Daily Report — an Admin flipping this OFF must actually
            # silence report delivery for that company, not just the
            # company-wide copy. Deliberately NOT consulted below for
            # Daily Unknown Person Count, which is fully independent
            # (see reports/daily_report.py's send_daily_unknown_count).
            company_daily_report_enabled = settings["daily_report_enabled"]

            if company_daily_report_enabled and settings["daily_report_time"] == current_hhmm:
                generate_and_send_daily_report(customer_id)

            for user in get_users_by_parent(customer_id):
                try:
                    user_settings = get_user_notification_settings(user["id"])
                    time_matches = user_settings["daily_report_time"] == current_hhmm

                    if company_daily_report_enabled and user_settings["daily_report_enabled"] and time_matches:
                        generate_and_send_daily_report(customer_id, target_user_id=user["id"])

                    # Daily Unknown Person Count: independent of both the
                    # company master switch above and of Unknown Person
                    # WhatsApp Alerts — gated only by this User's own
                    # toggle, scheduled at this same daily_report_time.
                    if user_settings["daily_unknown_count_enabled"] and time_matches:
                        send_daily_unknown_count(customer_id, user["id"])

                except Exception as e:
                    # One User's failure must never stop this company's
                    # other Users (or the company-wide report above) from
                    # being checked this same tick.
                    log_exception(e, f"daily report scheduler tick (customer={customer_id}, user={user['id']})")

        except Exception as e:
            # One company's failure must never stop the loop from
            # checking every other company this same tick.
            log_exception(e, f"daily report scheduler tick (customer={customer_id})")


def _scheduler_loop():

    print("[REPORT SCHEDULER] Daily report scheduler started")

    while True:
        try:
            _tick()
        except Exception as e:
            log_exception(e, "daily report scheduler loop")

        time.sleep(_CHECK_INTERVAL_SECONDS)


def start_report_scheduler():
    """Idempotent — a second call while the thread is already running is
    a no-op. Called once at backend boot (api/app.py)."""

    global _scheduler_thread

    with _scheduler_lock:

        if _scheduler_thread is not None and _scheduler_thread.is_alive():
            return

        _scheduler_thread = threading.Thread(target=_scheduler_loop, daemon=True)
        _scheduler_thread.start()
