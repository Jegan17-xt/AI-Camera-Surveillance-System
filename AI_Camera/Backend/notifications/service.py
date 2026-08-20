"""NotificationService — the ONLY place that decides whether an
Unknown Person Alert actually gets sent, and the ONLY caller of a
NotificationProvider. face/unknown_manager.py hands this module an
event dict and moves on; it never checks Admin settings, never touches
NotificationLog, and never knows whether the send succeeded.

Every public function here is exception-isolated: a bug in this module
(a bad template, a DB hiccup writing NotificationLog, whatever) must
never propagate back into the AI detection pipeline. See
handle_unknown_person_confirmed's try/except for the actual guarantee.
"""

from datetime import datetime, timedelta

from sqlalchemy import select

from db import get_session
from auth.database import get_user_by_id
from auth.models import NotificationLog, to_dict
from error_logging import log_exception
from api.notification_settings import get_notification_settings
from api.user_notification_settings import get_user_notification_settings
from notifications.providers.whatsapp import WhatsAppProvider
from notifications.utils import mask_recipient

_DATETIME_FMT = "%d-%m-%Y %H:%M:%S"

# Per-notification-layer cooldown/duplicate-suppression state — entirely
# separate from face/unknown_manager.py's own embedding-similarity
# dedup (which decides "is this a new UnknownPerson row at all"). This
# one only decides "have we already alerted about THIS unknown_person_id
# recently", keyed (customer_id, unknown_person_id) -> last-sent time.
# In-memory only: a backend restart simply lets the very next repeat
# sighting send one more alert, which is the safe direction to fail in
# (never worse than "duplicate cooldown reset", never "alert silently
# lost forever").
_last_alert_sent_at = {}


def _provider():
    return WhatsAppProvider()


def _log_notification(customer_id, type_, recipient, template_name, related_unknown_id, related_camera_id, status, provider_name, error_message=None, related_user_id=None):

    now_str = datetime.now().strftime(_DATETIME_FMT)

    with get_session() as session:
        row = NotificationLog(
            customer_id=customer_id,
            type=type_,
            recipient=recipient,
            template_name=template_name,
            related_unknown_id=related_unknown_id,
            related_camera_id=related_camera_id,
            related_user_id=related_user_id,
            status=status,
            provider=provider_name,
            error_message=error_message,
            created_at=now_str,
            sent_at=now_str if status == "Sent" else None,
        )
        session.add(row)
        session.flush()
        return row.id


def log_notification(customer_id, type_, recipient, template_name, status, error_message=None, related_user_id=None):
    """Public entry point into NotificationLog for notification types
    that don't originate from handle_unknown_person_confirmed's own
    event flow (e.g. Daily Unknown Person Count — see
    reports/daily_report.py's send_daily_unknown_count). related_unknown_id/
    related_camera_id don't apply to a daily aggregate, so they're
    always NULL through this path."""

    return _log_notification(
        customer_id, type_, recipient, template_name, None, None, status, "whatsapp",
        error_message, related_user_id=related_user_id,
    )


def registered_whatsapp_number(user_id):
    """This account's own registration phone number (auth.database's
    users.phone_number — collected at Add/Edit User time, validated by
    api.validators.PHONE_PATTERN as exactly 10 digits, no country code,
    same India-only assumption every phone field in this app already
    makes), normalized into the +91-prefixed form WhatsAppProvider's
    Contact param needs. Not a substitute for an explicit WhatsApp
    number override — callers only fall back to this when nothing more
    specific has been configured. None if there's no account, or no
    phone_number saved on it.

    Public (no leading underscore): reused by reports/daily_report.py's
    Daily Report recipient resolution, which must fall back to this
    exact same registered-number logic Unknown Person Alerts already use
    (_resolve_unknown_alert_target below) — not a second, separately
    invented phone format."""

    if user_id is None:
        return None

    user = get_user_by_id(user_id)
    phone = user.get("phone_number") if user else None

    return f"+91{phone}" if phone else None


def _resolve_unknown_alert_target(company_settings, owner_user_id, customer_id):
    """User-Specific WhatsApp Report Settings: "the same user-specific
    WhatsApp number should be used for Unknown Person Alerts unless
    Admin configures a separate alert recipient." Priority:

      1. The capturing camera's assigned User has their own Unknown
         Alert turned ON -> send to THEM: their explicit WhatsApp
         Report number if they saved one, else their own registered
         (Add/Edit User) phone number, looked up fresh from the
         database every time so a later profile edit takes effect on
         the very next alert with no separate WhatsApp setup required.
      2. Otherwise -> the company-level fallback recipient (Admin
         Settings > Notifications & Reports) if one is configured,
         else the Company Admin's (customer_id's) own registered phone
         number, same dynamic lookup as case 1.

    No number is ever hardcoded here — every recipient this function
    can return traces back to a database column (UserNotificationSettings.
    whatsapp_number, NotificationSettings.unknown_alert_recipient, or
    users.phone_number), so User A's camera can only ever resolve to
    User A's own numbers and User B's to User B's.

    Returns a dict: {"recipient": str|None, "send_image": bool,
    "related_user_id": int|None, "skip_reason": str|None}.
    `related_user_id` is only set when case 1 wins, so NotificationLog
    can tell "sent to this User personally" apart from "sent to the
    company recipient". `skip_reason` is only set when the assigned
    User opted in but has no number anywhere (neither an explicit
    override nor a registered phone number) — worth logging as a
    misconfiguration rather than silently falling back."""

    if owner_user_id is not None:
        user_settings = get_user_notification_settings(owner_user_id)

        if user_settings["unknown_alert_enabled"]:
            recipient = user_settings["whatsapp_number"] or registered_whatsapp_number(owner_user_id)

            if recipient:
                return {
                    "recipient": recipient,
                    "send_image": user_settings["send_unknown_image"],
                    "related_user_id": owner_user_id,
                    "skip_reason": None,
                }

            return {
                "recipient": None, "send_image": None, "related_user_id": owner_user_id,
                "skip_reason": "No WhatsApp number configured for this user.",
            }

    recipient = company_settings["unknown_alert_recipient"] or registered_whatsapp_number(customer_id)

    if recipient:
        return {
            "recipient": recipient,
            "send_image": company_settings["unknown_alert_send_image"],
            "related_user_id": None,
            "skip_reason": None,
        }

    return {"recipient": None, "send_image": None, "related_user_id": None, "skip_reason": None}


def _is_within_cooldown(dedup_key, cooldown_minutes):

    last_sent = _last_alert_sent_at.get(dedup_key)

    if last_sent is None:
        return False

    return datetime.now() - last_sent < timedelta(minutes=cooldown_minutes)


def handle_unknown_person_confirmed(event):
    """event: a dict from notifications.events.build_unknown_person_confirmed_event.

    Never raises. Every exit path (alerts disabled, no recipient
    configured, below confidence threshold, suppressed by cooldown, or
    a real send attempt) is either a silent no-op or a logged
    NotificationLog row — detection/attendance/tracking continue
    identically regardless of what happens in here."""

    try:
        customer_id = event["customer_id"]
        settings = get_notification_settings(customer_id)

        # Company-level toggle is the master kill switch: OFF means
        # nothing goes to anyone in this company, regardless of what any
        # individual User has configured for themselves.
        if not settings["unknown_alert_enabled"]:
            return

        unknown_person_id = event.get("unknown_person_id")
        owner_user_id = event.get("owner_user_id")

        target = _resolve_unknown_alert_target(settings, owner_user_id, customer_id)

        if not target["recipient"]:
            if target["skip_reason"]:
                _log_notification(
                    customer_id, "unknown_person_alert", None, "unknown_person_alert",
                    unknown_person_id, event.get("camera_id"), "Failed", "whatsapp",
                    target["skip_reason"], related_user_id=target["related_user_id"],
                )
            return

        confidence = event.get("confidence")
        min_confidence = settings["unknown_alert_min_confidence"]

        if confidence is not None and min_confidence is not None and confidence < min_confidence:
            return

        # Cooldown/dedup stays keyed by (customer_id, unknown_person_id)
        # only — one alert per physical unknown person within the
        # window, regardless of which recipient (a User or the company
        # fallback) actually receives it.
        dedup_key = (customer_id, unknown_person_id)

        if settings["unknown_alert_dedup_enabled"] and _is_within_cooldown(dedup_key, settings["unknown_alert_cooldown_minutes"]):
            # Continue detection/tracking as normal — only the repeat
            # WhatsApp alert for this same unknown person is suppressed.
            return

        now = datetime.now()
        template_vars = {
            "camera": event.get("camera_name") or "Unassigned Camera",
            "date": now.strftime("%d-%m-%Y"),
            "time": now.strftime("%H:%M:%S"),
        }

        image_path = event.get("captured_image_path") if target["send_image"] else None

        provider = _provider()
        result = provider.send_template(
            recipient=target["recipient"],
            template_name="unknown_person_alert",
            variables=template_vars,
            image_path=image_path,
            customer_id=customer_id,
        )

        status = "Sent" if result.get("success") else "Failed"
        error_message = None if result.get("success") else result.get("message")

        _log_notification(
            customer_id, "unknown_person_alert", target["recipient"], "unknown_person_alert",
            unknown_person_id, event.get("camera_id"), status, provider.name, error_message,
            related_user_id=target["related_user_id"],
        )

        # The cooldown clock starts on this attempt regardless of
        # success/failure — a provider outage must not turn into a
        # retry-storm the instant the same lingering unknown person is
        # seen again a few seconds later.
        if settings["unknown_alert_dedup_enabled"]:
            _last_alert_sent_at[dedup_key] = now

    except Exception as e:
        log_exception(e, "NotificationService.handle_unknown_person_confirmed")


def get_notification_logs(customer_id, limit=100, related_user_id=None):
    """Settings > WhatsApp & Reports > Notification History. Recipient
    numbers are masked here (not in NotificationSettings' own GET, which
    the Admin needs to actually edit) — this is the read-only history
    view.

    `related_user_id`: None shows every notification for this company
    (the "self/company" scope); a real id narrows it to exactly the
    alerts routed to that ONE User's own WhatsApp number — the same
    per-User scoping every other history view in this app already uses."""

    with get_session() as session:
        query = select(NotificationLog).where(NotificationLog.customer_id == customer_id)

        if related_user_id is not None:
            query = query.where(NotificationLog.related_user_id == related_user_id)

        rows = session.scalars(query.order_by(NotificationLog.id.desc()).limit(limit)).all()

    logs = [to_dict(r) for r in rows]

    for log in logs:
        log["recipient"] = mask_recipient(log.get("recipient"))

    return logs


def delete_notification_log(customer_id, log_id):
    """Settings > WhatsApp & Reports > Notification History's Delete
    button. Scoped to customer_id exactly like get_notification_logs
    above — a log_id belonging to a different company 404s here (the
    route treats False as "not found"), never silently deletes across
    tenants. No associated file to clean up (unlike delete_report_log,
    a NotificationLog row has no PDF/image of its own) — a plain row
    delete is the whole operation."""

    with get_session() as session:
        row = session.scalar(
            select(NotificationLog).where(NotificationLog.id == log_id, NotificationLog.customer_id == customer_id)
        )

        if row is None:
            return False

        session.delete(row)

    return True


def deliver_daily_unknown_count(recipient, count, date_str):
    """Generic WhatsApp delivery for the Daily Unknown Person Count — a
    single text message, fully independent of both Unknown Person
    Alerts (handle_unknown_person_confirmed above) and the Daily Report
    PDF (deliver_daily_report below). No DB writes here: reports/
    daily_report.py's send_daily_unknown_count owns NotificationLog and
    interprets this return value itself. Never raises."""

    try:
        provider = _provider()

        return provider.send_template(
            recipient, "daily_unknown_count",
            {"date": date_str, "count": count},
        )

    except Exception as e:
        log_exception(e, "NotificationService.deliver_daily_unknown_count")
        return {"success": False, "provider": "whatsapp", "message": str(e)}


def deliver_daily_report(recipient, pdf_path, summary, customer_id=None, include_pdf=True, document_filename=None):
    """Generic WhatsApp delivery for the Daily Report — one
    send_template call carrying both the 6-parameter text BODY (summary)
    and (when include_pdf) the generated PDF as the template's document
    HEADER (DocumentUrl + DocumentFilename), the same "attach via a
    signed public URL on the same request" idiom Unknown Person Alerts
    already use for their captured image (see notifications/providers/
    whatsapp.py's module docstring) — never a second, separate media
    message sent after the template. No DB writes here: reports/
    daily_report.py owns ReportLog and interprets this return value
    itself, keeping report generation and WhatsApp delivery decoupled
    (per this feature's architecture).

    Never raises — returns {"success": False, ...} on any internal
    error instead."""

    try:
        provider = _provider()

        print(f"[DAILY REPORT] WhatsApp provider selected: {provider.name}")

        result = provider.send_template(
            recipient, "daily_report_summary", summary,
            document_path=pdf_path if include_pdf else None,
            document_filename=document_filename if include_pdf else None,
            customer_id=customer_id,
        )

        print(
            f"[DAILY REPORT] provider result — success={result.get('success')} "
            f"status={result.get('status')} message={result.get('message')}"
        )

        return {
            "success": bool(result.get("success")),
            "status": result.get("status"),
            "provider": provider.name,
            "message": result.get("message"),
        }

    except Exception as e:
        log_exception(e, "NotificationService.deliver_daily_report")
        return {"success": False, "provider": "whatsapp", "message": str(e)}
