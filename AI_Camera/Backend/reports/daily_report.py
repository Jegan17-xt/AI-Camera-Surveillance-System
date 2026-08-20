"""DailyReportGenerator — reads the existing database (registered
persons, attendance, unknown persons, cameras) as the sole source of
truth, builds a real PDF (reports/pdf_generator.py), and hands delivery
off to notifications/service.py. Owns ReportLog end to end: creates the
row the moment the PDF is written, then updates it in place once
delivery succeeds, fails, or is skipped (Daily Report disabled/no
recipient).

    Database -> DailyReportGenerator -> PDF file -> NotificationService
        -> WhatsAppProvider

Deliberately never imports from camera/ or face/ — every number here
comes from tables the existing pipeline already writes, read exactly the
way api/attendance.py, api/registered.py, and api/unknown_analytics.py
already read them.
"""

import os
from datetime import datetime

from sqlalchemy import select

from db import get_session
from auth.models import Camera, NotificationLog, ReportLog, UnknownPerson, to_dict
from api.attendance import get_attendance_by_date
from api.notification_settings import get_notification_settings
from api.registered import get_registered_persons
from api.scope import apply_owner_scope
from api.unknown import unknown_folder
from api.user_notification_settings import get_user_notification_settings
from error_logging import log_exception
from reports.pdf_generator import build_daily_report_pdf
from notifications.utils import mask_recipient
import notifications.service as notification_service

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Deliberately its own top-level storage root, sibling to dataset/ and
# attendance/ — kept separate from the `reports` table/folder
# api/reports.py already owns (report_*.csv attendance snapshots) so
# this feature's PDFs are never confused with that pre-existing export.
STORAGE_ROOT = os.path.join(BASE_DIR, "generated_reports", "customers")

_DATE_FMT = "%d-%m-%Y"


def report_folder(customer_id):
    return os.path.join(STORAGE_ROOT, str(customer_id))


def _whatsapp_document_filename(date_str):
    """The name shown in the recipient's WhatsApp client for the
    attached PDF — deliberately NOT the same as the internal on-disk
    filename (daily_report_<date>.pdf / daily_report_user<id>_<date>.pdf,
    used for storage/lookup only, see get_report_filepath) — this is a
    purely cosmetic, human-facing name."""

    return f"Daily_AI_Camera_Report_{date_str}.pdf"


# ==========================================================
# Daily Unknown Person Count — a separate, independent per-User feature:
# just a WhatsApp text message with that day's confirmed/saved
# unknown-person count, scheduled at the SAME daily_report_time as the
# Daily Report PDF but gated by its own toggle
# (UserNotificationSettings.daily_unknown_count_enabled) only — never by
# unknown_alert_enabled, never by daily_report_enabled, and with no time
# field of its own. See reports/scheduler.py for how it's triggered.
# ==========================================================
def _count_confirmed_unknown_persons(customer_id, date_str, owner_user_id):
    """Confirmed/saved unknown-person records only — reads the exact
    same unknown_persons table face/unknown_manager.py's save_unknown()
    already writes one row into per confirmed save (never a duplicate
    re-sighting, which only bumps last_seen/detection_count on an
    existing row — see that function's own dedup logic). This function
    only ever READS that table; detection/save logic is untouched.

    Counted the same way reports/daily_report.py's own unknown_events
    section already counts them for the PDF: `detected_time` (the
    moment the row was first created) falling on this exact date,
    scoped to this one User via the same apply_owner_scope idiom every
    other per-User view in this app uses."""

    with get_session() as session:
        query = apply_owner_scope(
            select(UnknownPerson.detected_time).where(UnknownPerson.customer_id == customer_id),
            UnknownPerson.owner_user_id, owner_user_id,
        )
        detected_times = session.scalars(query).all()

    return sum(1 for detected_time in detected_times if (detected_time or "").startswith(date_str))


def _daily_unknown_count_already_sent(customer_id, user_id, date_str):
    """DB-backed idempotency guard (NotificationLog, not in-memory) —
    survives a backend restart the same way ReportLog already does for
    the Daily Report PDF."""

    with get_session() as session:
        return session.scalar(
            select(NotificationLog.id).where(
                NotificationLog.customer_id == customer_id,
                NotificationLog.related_user_id == user_id,
                NotificationLog.type == "daily_unknown_count",
                NotificationLog.created_at.like(f"{date_str}%"),
            )
        ) is not None


def send_daily_unknown_count(customer_id, user_id, date_str=None, force=False):
    """This User's own entry point, called by reports/scheduler.py at
    their configured daily_report_time — completely independent of
    generate_and_send_daily_report above (no PDF, no ReportLog row; this
    writes a NotificationLog row instead, since it's a single WhatsApp
    text message, not a report artifact). Never raises."""

    try:
        date_str = date_str or datetime.now().strftime(_DATE_FMT)

        if not force and _daily_unknown_count_already_sent(customer_id, user_id, date_str):
            return {"status": "already_sent", "date": date_str}

        user_settings = get_user_notification_settings(user_id)

        if not user_settings["daily_unknown_count_enabled"]:
            return None

        recipient = user_settings["whatsapp_number"]

        if not recipient:
            notification_service.log_notification(
                customer_id, "daily_unknown_count", None, "daily_unknown_count",
                "Failed", error_message="No WhatsApp number configured for this user.", related_user_id=user_id,
            )
            return {"status": "Failed", "error": "No WhatsApp number configured."}

        count = _count_confirmed_unknown_persons(customer_id, date_str, owner_user_id=user_id)

        result = notification_service.deliver_daily_unknown_count(recipient, count, date_str)

        status = "Sent" if result.get("success") else "Failed"
        notification_service.log_notification(
            customer_id, "daily_unknown_count", recipient, "daily_unknown_count",
            status, error_message=None if result.get("success") else result.get("message"), related_user_id=user_id,
        )

        return {"status": status, "count": count}

    except Exception as e:
        log_exception(e, f"send_daily_unknown_count (customer={customer_id}, user={user_id})")
        return {"status": "Failed", "error": str(e)}


def _collect_report_data(customer_id, date_str, owner_user_id=None):
    """Every number/row here is read live from MySQL — nothing is
    invented. A section with no underlying rows renders as an empty
    list/zero count; reports/pdf_generator.py is what turns "empty" into
    a graceful "No records" line rather than this function guessing.

    `owner_user_id` (User-Specific WhatsApp Report Settings): None
    produces the existing company-wide report (every User pooled,
    unchanged behavior); a real id scopes every query below to exactly
    that User's own data, via the same apply_owner_scope idiom every
    other per-User view in this app already uses (api/dashboard.py,
    api/attendance.py, etc.) — "that User's own Daily Report" means
    nothing more than the company-wide report with this one extra
    filter applied everywhere."""

    # --- 1 & 2: Attendance ---
    _persons, total_registered = get_registered_persons(customer_id, owner_user_id=owner_user_id)
    attendance_rows = get_attendance_by_date(customer_id, date_str, owner_user_id=owner_user_id) or []
    present = len(attendance_rows)
    absent = max(total_registered - present, 0)

    person_wise = [
        {"name": r["name"], "first_entry": r["in_time"], "last_exit": r["out_time"], "status": r["status"]}
        for r in attendance_rows
    ]

    # --- Cameras (used for both section 4 and unknown-event camera names) ---
    with get_session() as session:
        query = apply_owner_scope(
            select(Camera).where(Camera.customer_id == customer_id), Camera.owner_user_id, owner_user_id
        )
        cameras = session.scalars(query).all()
        camera_rows = [to_dict(c) for c in cameras]

    camera_name_by_id = {c["camera_id"]: c["camera_name"] for c in camera_rows}

    # --- 3: Unknown Person Events for this date ---
    folder = unknown_folder(customer_id)

    with get_session() as session:
        query = apply_owner_scope(
            select(UnknownPerson).where(UnknownPerson.customer_id == customer_id),
            UnknownPerson.owner_user_id, owner_user_id,
        )
        unknown_rows = session.scalars(query).all()
        unknown_rows = [to_dict(u) for u in unknown_rows]

    # Each UnknownPerson row already IS one unique unknown person — a
    # repeat sighting of the same physical person never creates a second
    # row (see face/unknown_manager.py's save_unknown() duplicate check);
    # it only bumps that same row's last_seen/detection_count. So filtering
    # rows first-created today (detected_time) and reading their existing
    # last_seen/detection_count straight off the row gives unique-persons-
    # today, first/last detected time, and that person's detection count
    # for today, with no new table, no new save path, and no risk of
    # double-counting or inventing a duplicate record for the report.
    unknown_events = []

    for u in unknown_rows:
        detected = u.get("detected_time") or ""

        if not detected.startswith(date_str):
            continue

        image_path = os.path.join(folder, u["image_path"]) if u.get("image_path") else None

        unknown_events.append({
            "camera": camera_name_by_id.get(u.get("camera_id")) or "Unassigned",
            "first_seen": detected,
            "last_seen": u.get("last_seen") or detected,
            "detection_count": u.get("detection_count") or 1,
            "image_path": image_path,
        })

    # --- 5: AI Detection Summary — derived only from rows that actually
    # exist (this app persists no raw per-frame detection counter, so
    # "Total person/face detections" is deliberately omitted rather than
    # invented; these two are real, DB-grounded counts). ---
    detection_summary = {
        "registered_detections": present,
        "unknown_detections": len(unknown_events),
    }

    online_cameras = sum(1 for c in camera_rows if c["status"] == "Online")

    # WhatsApp text summary (spec section 5) — kept flat/plain since it
    # feeds directly into the WhatsApp template's {{variables}}.
    whatsapp_summary = {
        "registered": total_registered,
        "present": present,
        "absent": absent,
        "unknown_count": len(unknown_events),
        "online": online_cameras,
        "total": len(camera_rows),
        "date": date_str,
    }

    return {
        "attendance_summary": {"total_registered": total_registered, "present": present, "absent": absent},
        "person_wise": person_wise,
        "unknown_events": unknown_events,
        "camera_status": [
            {
                "name": c["camera_name"],
                "location": c["camera_location"] or "-",
                "status": c["status"],
                "last_seen": c["last_connected_time"] or "-",
            }
            for c in camera_rows
        ],
        "detection_summary": detection_summary,
        "summary": whatsapp_summary,
        "generated_at": datetime.now().strftime("%d-%m-%Y %H:%M:%S"),
    }


def _report_already_generated(customer_id, date_str, user_id=None):
    """Idempotency guard, now keyed by (customer_id, user_id, date) —
    the company-wide report (user_id=None) and each User's own
    personalized report are tracked independently, so generating one
    never blocks or gets confused with the other."""

    with get_session() as session:
        query = select(ReportLog.id).where(ReportLog.customer_id == customer_id, ReportLog.report_date == date_str)
        query = query.where(ReportLog.user_id.is_(None) if user_id is None else ReportLog.user_id == user_id)
        return session.scalar(query) is not None


def _create_report_log(customer_id, date_str, filename, recipient, user_id=None):

    now_str = datetime.now().strftime("%d-%m-%Y %H:%M:%S")

    with get_session() as session:
        row = ReportLog(
            customer_id=customer_id, user_id=user_id, report_date=date_str, file_path=filename,
            recipient=recipient, status="Pending", created_at=now_str,
        )
        session.add(row)
        session.flush()
        return row.id


def _update_report_log(log_id, status, error_message=None):

    now_str = datetime.now().strftime("%d-%m-%Y %H:%M:%S")

    with get_session() as session:
        row = session.get(ReportLog, log_id)

        if row is None:
            return

        row.status = status
        row.error_message = error_message

        if status in ("Sent", "Failed"):
            row.sent_at = now_str


def get_report_logs(customer_id, limit=100, user_id=None):
    """`user_id`: None shows the company-wide report history; a real id
    narrows it to exactly that ONE User's own personalized reports —
    same per-User scoping as notifications.service.get_notification_logs."""

    with get_session() as session:
        query = select(ReportLog).where(ReportLog.customer_id == customer_id)

        if user_id is not None:
            query = query.where(ReportLog.user_id == user_id)

        rows = session.scalars(query.order_by(ReportLog.id.desc()).limit(limit)).all()

    logs = [to_dict(r) for r in rows]

    for log in logs:
        log["recipient"] = mask_recipient(log.get("recipient"))

    return logs


def get_report_filepath(customer_id, filename):
    """Existence+ownership-scoped filename resolution, same pattern as
    api/reports.py's get_report_filepath — never trusts a caller-supplied
    filename without first confirming a ReportLog row for THIS customer
    references it."""

    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        return None

    with get_session() as session:
        exists = session.scalar(
            select(ReportLog.id).where(ReportLog.customer_id == customer_id, ReportLog.file_path == filename)
        )

    if exists is None:
        return None

    file_path = os.path.join(report_folder(customer_id), filename)

    if not os.path.isfile(file_path):
        return None

    return filename


def delete_report_logs_older_than(customer_id, cutoff_dt):
    """Data Retention (api/retention_settings.py): deletes old generated
    Daily Report PDFs — the ReportLog row plus its daily_report_*.pdf
    file under report_folder() — whose created_at is strictly older than
    cutoff_dt. created_at is a "%d-%m-%Y %H:%M:%S" string (this
    function's own _create_report_log() format above)."""

    with get_session() as session:

        rows = session.scalars(
            select(ReportLog).where(ReportLog.customer_id == customer_id)
        ).all()

        deleted_count = 0
        folder = report_folder(customer_id)

        for row in rows:
            try:
                created_at = datetime.strptime(row.created_at, "%d-%m-%Y %H:%M:%S")
            except (TypeError, ValueError):
                continue

            if created_at < cutoff_dt:
                if row.file_path:
                    file_path = os.path.join(folder, row.file_path)
                    if os.path.exists(file_path):
                        os.remove(file_path)
                session.delete(row)
                deleted_count += 1

    return deleted_count


def delete_report_log(customer_id, log_id):
    """Settings > WhatsApp & Reports > Notification History's Delete
    button, for a Daily Report entry — scoped to customer_id exactly
    like get_report_logs above, so a log_id belonging to a different
    company 404s here rather than deleting across tenants. Same
    row-plus-PDF cleanup as delete_report_logs_older_than, just for one
    caller-chosen id instead of an age cutoff."""

    with get_session() as session:
        row = session.scalar(
            select(ReportLog).where(ReportLog.id == log_id, ReportLog.customer_id == customer_id)
        )

        if row is None:
            return False

        if row.file_path:
            file_path = os.path.join(report_folder(customer_id), row.file_path)
            if os.path.exists(file_path):
                os.remove(file_path)

        session.delete(row)

    return True


def generate_and_send_daily_report(customer_id, date_str=None, force=False, target_user_id=None):
    """The Daily Report's single entry point — called by
    reports/scheduler.py on a schedule, and by the Admin's manual
    "Generate Now" test route. Idempotent per (customer_id, target_user_id,
    date_str) unless force=True: a report already logged for this key is
    never silently regenerated, so two scheduler ticks landing in the
    same minute (or a backend restart mid-day) can never produce a
    duplicate send. Never raises — a failure here must not take down the
    scheduler thread or any AI camera worker; see the module docstring.

    `target_user_id=None` generates the existing company-wide report,
    sent to NotificationSettings' own recipient. A real id (User-Specific
    WhatsApp Report Settings) generates that ONE User's own personalized
    report — scoped to their own data (_collect_report_data's
    owner_user_id) — sent to THEIR OWN WhatsApp number, looked up fresh
    here (not trusted from the caller) so a stale number can never be
    used after the Admin has since changed or cleared it."""

    try:
        date_str = date_str or datetime.now().strftime(_DATE_FMT)

        print(f"[DAILY REPORT] send started — customer_id={customer_id} target_user_id={target_user_id} date={date_str} force={force}")

        if not force and _report_already_generated(customer_id, date_str, user_id=target_user_id):
            print(f"[DAILY REPORT] already generated for this key — customer_id={customer_id} target_user_id={target_user_id} date={date_str}")
            return {"status": "already_generated", "date": date_str}

        settings = get_notification_settings(customer_id)

        if target_user_id is not None:
            user_settings = get_user_notification_settings(target_user_id)
            # Same fallback Unknown Person Alerts already use for a
            # specific User (notifications.service._resolve_unknown_alert_target,
            # case 1): an explicit WhatsApp Report number if one was
            # saved, else that User's own registered (Add/Edit User)
            # phone number — the exact same registered_whatsapp_number()
            # helper, not a second, separately invented phone format.
            recipient = user_settings["whatsapp_number"] or notification_service.registered_whatsapp_number(target_user_id)
        else:
            # Same fallback Unknown Person Alerts already use at the
            # company level (_resolve_unknown_alert_target, case 2): the
            # company-level fallback recipient if one is configured,
            # else the Company Admin's own registered phone number. This
            # is the reason Unknown Person Alerts already reach a number
            # that was never explicitly saved as unknown_alert_recipient/
            # daily_report_recipient — without this same fallback here,
            # Daily Report had no way to reach that same number and
            # unconditionally fell through to "Skipped" below.
            recipient = settings["daily_report_recipient"] or notification_service.registered_whatsapp_number(customer_id)

        print(f"[DAILY REPORT] recipient resolved — customer_id={customer_id} target_user_id={target_user_id} recipient={mask_recipient(recipient)}")

        data = _collect_report_data(customer_id, date_str, owner_user_id=target_user_id)
        pdf_bytes = build_daily_report_pdf(date_str, data, settings)

        folder = report_folder(customer_id)
        os.makedirs(folder, exist_ok=True)
        filename = (
            f"daily_report_user{target_user_id}_{date_str}.pdf" if target_user_id is not None
            else f"daily_report_{date_str}.pdf"
        )
        file_path = os.path.join(folder, filename)

        with open(file_path, "wb") as file:
            file.write(pdf_bytes)

        print(f"[DAILY REPORT] PDF written — customer_id={customer_id} filename={filename} bytes={len(pdf_bytes)}")

        log_id = _create_report_log(customer_id, date_str, filename, recipient, user_id=target_user_id)

        if not recipient:
            skipped_reason = "missing_recipient"
            error_message = "No WhatsApp number configured (no explicit recipient and no registered phone number)."
            print(f"[DAILY REPORT] SKIPPED — customer_id={customer_id} target_user_id={target_user_id} reason={skipped_reason}")
            _update_report_log(log_id, status="Skipped", error_message=error_message)
            return {"status": "Skipped", "skipped_reason": skipped_reason, "file_path": filename, "error": error_message}

        # The company-wide report additionally respects the company
        # toggle at delivery time (it may have been the master switch
        # that gated a User's own report from ever reaching this
        # function too — see reports/scheduler.py — but a manual
        # "Generate Now" always attempts delivery once a recipient
        # exists, same as before this feature). This is a deliberate
        # "Generated, not sent" outcome, distinct from "Skipped" (no
        # recipient) below — the two must never be confused.
        if target_user_id is None and not settings["daily_report_enabled"]:
            print(f"[DAILY REPORT] generated only (Daily Reports OFF) — customer_id={customer_id}")
            _update_report_log(log_id, status="Generated")
            return {"status": "Generated", "file_path": filename}

        print(
            f"[DAILY REPORT] attempting WhatsApp send — customer_id={customer_id} target_user_id={target_user_id} "
            f"recipient={mask_recipient(recipient)} include_pdf={settings['daily_report_include_pdf']}"
        )

        result = notification_service.deliver_daily_report(
            recipient, file_path, data["summary"],
            customer_id=customer_id, include_pdf=settings["daily_report_include_pdf"],
            document_filename=_whatsapp_document_filename(date_str),
        )

        if result.get("success"):
            print(f"[DAILY REPORT] SENT — customer_id={customer_id} target_user_id={target_user_id}")
            _update_report_log(log_id, status="Sent")
            return {"status": "Sent", "file_path": filename}

        print(
            f"[DAILY REPORT] FAILED — customer_id={customer_id} target_user_id={target_user_id} "
            f"provider_status={result.get('status')} message={result.get('message')}"
        )
        _update_report_log(log_id, status="Failed", error_message=result.get("message"))
        return {"status": "Failed", "file_path": filename, "error": result.get("message")}

    except Exception as e:
        log_exception(e, f"generate_and_send_daily_report (customer={customer_id}, user={target_user_id})")
        return {"status": "Failed", "error": str(e)}
