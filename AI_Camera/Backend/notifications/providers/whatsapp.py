"""WhatsAppProvider — real integration with My Dreams Technology's
WhatsApp Business API (sendtemplate.php), for the Unknown Person Alert
template only.

Confirmed request format (a manual GET request the project owner ran
and verified was delivered):

    GET https://wa.mydreamstechnology.in/api/sendtemplate.php
        ?LicenseNumber=<license>
        &APIKey=<key>
        &Contact=<digits-only, no leading '+'>
        &Template=Unknown_person_alert
        &Param=<camera>,<date>,<time>   (maps to {{1}},{{2}},{{3}})

Every credential is read from the environment (Backend/.env) —
WHATSAPP_LICENSE_NUMBER, WHATSAPP_API_KEY, WHATSAPP_TEMPLATE,
WHATSAPP_ALERT_COOLDOWN. The API key is never hardcoded and never
printed/logged, including on failure — see the deliberate avoidance of
error_logging.log_exception() in send_template() below, which would
otherwise leak it (requests embeds the full request URL, query string
included, in a failed GET's exception message/traceback).

Image attachment: sendtemplate.php's parameter for attaching an image
is now confirmed — ImageUrl, a publicly fetchable HTTPS URL, alongside
the existing Template/Param/Contact params (three supervised live
sends against the real API: all four of ImageUrl/MediaUrl/HeaderImage/
Image were tried together first, then bisected down to ImageUrl alone,
which was independently sufficient on its own). It is NOT a direct
file upload — sendtemplate.php stays a GET request, so the image has
to already be hosted somewhere their servers can reach; see
notifications/image_links.py for how a locally saved unknown-face
image becomes that URL.

Daily Report (daily_report_summary) reuses this exact same mechanism —
same endpoint, same LicenseNumber/APIKey, same GET request shape — just
its own template name (WHATSAPP_DAILY_REPORT_TEMPLATE, independent of
WHATSAPP_TEMPLATE so the two can be configured/changed without touching
each other) and its own {{1}}..{{6}} Param order (the template's BODY).
The generated PDF is the template's HEADER, attached the same way an
unknown-face image is (a signed, publicly-fetchable URL — here
DocumentUrl, alongside the confirmed ImageUrl — built by
notifications/image_links.py and passed in the SAME single GET request,
never a second, separate "send media" message after the template): this
is the one confirmed attachment mechanism this API has, so it's reused
rather than guessing at a second endpoint. DocumentFilename rides
alongside DocumentUrl so the recipient's WhatsApp client shows a real
name (e.g. "Daily_AI_Camera_Report_14-08-2026.pdf") instead of the
internal storage filename. Neither DocumentUrl nor DocumentFilename is
independently confirmed against the live API the way ImageUrl is (see
build_public_document_url) — verify them against a real send if the
vendor's dashboard needs different param names.

Any other template_name (daily_unknown_count, ...) has no confirmed
request format either, so it keeps the original "not configured" stub
behavior untouched.
"""

import os
import re
import threading
import time

import requests

from notifications.image_links import build_public_image_url, build_public_document_url
from notifications.providers.base import BaseNotificationProvider
from notifications.utils import mask_recipient as _mask_recipient

DEFAULT_API_URL = "https://wa.mydreamstechnology.in/api/sendtemplate.php"

# The only template with a confirmed, tested request format so far.
UNKNOWN_PERSON_ALERT_TEMPLATE = "unknown_person_alert"

# Daily Report's own template kind — same request mechanism as above,
# its own WHATSAPP_DAILY_REPORT_TEMPLATE-configured template name and
# {{1}}..{{6}} parameter order (see _DAILY_REPORT_PARAM_KEYS below).
DAILY_REPORT_SUMMARY_TEMPLATE = "daily_report_summary"

# EXACT order of reports/daily_report.py's `summary` dict keys
# ({"date", "registered", "present", "absent", "unknown_count", "online",
# "total"} — "total" is intentionally unused here) mapped to the
# template's {{1}}..{{6}} placeholders:
#   {{1}} Date  {{2}} Total Registered  {{3}} Total Present
#   {{4}} Total Absent  {{5}} Total Unknown Persons  {{6}} Cameras Online
_DAILY_REPORT_PARAM_KEYS = ("date", "registered", "present", "absent", "unknown_count", "online")

_REQUEST_TIMEOUT_SECONDS = 10

# Module-level (not per-instance): NotificationService's _provider()
# constructs a fresh WhatsAppProvider() on every call, so per-recipient
# cooldown state has to live outside the instance to mean anything.
_cooldown_lock = threading.Lock()
_last_sent_at = {}  # normalized contact -> time.monotonic() of last send attempt


def _coerce_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_contact(recipient):
    """'+91 98110 04182' -> '918110004182' — the tested-working Contact
    value was a bare digit string with no '+' or spaces."""

    return re.sub(r"\D", "", recipient or "")


class WhatsAppProvider(BaseNotificationProvider):

    name = "whatsapp"

    def __init__(self):
        self.api_url = os.environ.get("WHATSAPP_API_URL") or DEFAULT_API_URL
        self.license_number = os.environ.get("WHATSAPP_LICENSE_NUMBER")
        self.api_key = os.environ.get("WHATSAPP_API_KEY")
        self.template_name = os.environ.get("WHATSAPP_TEMPLATE") or "Unknown_person_alert"
        # Separate env var, independent of WHATSAPP_TEMPLATE above — the
        # Daily Report template can be configured/changed without ever
        # touching the Unknown Person Alert one.
        self.daily_report_template_name = os.environ.get("WHATSAPP_DAILY_REPORT_TEMPLATE") or "Daily_Report"
        self.cooldown_seconds = _coerce_int(os.environ.get("WHATSAPP_ALERT_COOLDOWN"), 60)

    def _configured(self):
        return bool(self.license_number and self.api_key)

    def _not_configured(self, recipient, payload_kind, payload):

        print(
            f"[WhatsAppProvider] NOT CONFIGURED — would send {payload_kind} "
            f"to {_mask_recipient(recipient)}: {payload}"
        )

        return {
            "success": False,
            "status": "not_configured",
            "message": "WhatsApp provider is not configured yet. No message was sent.",
            "provider": self.name,
        }

    def _within_cooldown(self, contact):
        """Hard, provider-level floor (WHATSAPP_ALERT_COOLDOWN) on top of
        NotificationService's own per-unknown-person-id cooldown/dedup —
        this one is keyed purely by recipient number, so it also catches
        e.g. two different unknown people alerting the same recipient in
        quick succession. Records the attempt whether or not it turns
        out to be within cooldown, so back-to-back calls in the same
        instant only ever let the first one through."""

        now = time.monotonic()

        with _cooldown_lock:
            last = _last_sent_at.get(contact)

            if last is not None and (now - last) < self.cooldown_seconds:
                return True

            _last_sent_at[contact] = now
            return False

    def send_template(self, recipient, template_name, variables, image_path=None, document_path=None, document_filename=None, customer_id=None):

        is_daily_report = template_name == DAILY_REPORT_SUMMARY_TEMPLATE

        if template_name == UNKNOWN_PERSON_ALERT_TEMPLATE:
            configured_template = self.template_name
            param_keys = ("camera", "date", "time")
        elif is_daily_report:
            configured_template = self.daily_report_template_name
            param_keys = _DAILY_REPORT_PARAM_KEYS
        else:
            return self._not_configured(
                recipient, "template",
                {"template": template_name, "variables": variables, "has_image": bool(image_path)},
            )

        if is_daily_report:
            print(
                f"[DAILY REPORT] WhatsAppProvider.send_template — template_kind={template_name} "
                f"configured_template={configured_template!r} param_count={len(param_keys)} "
                f"has_document={bool(document_path)}"
            )

        if not self._configured():
            if is_daily_report:
                print("[DAILY REPORT] provider NOT configured — missing WHATSAPP_LICENSE_NUMBER/WHATSAPP_API_KEY")
            return self._not_configured(
                recipient, "template",
                {"template": template_name, "variables": variables, "has_image": bool(image_path)},
            )

        contact = _normalize_contact(recipient)

        if is_daily_report:
            print(f"[DAILY REPORT] recipient normalized — raw={_mask_recipient(recipient)} normalized_valid={bool(contact)}")

        if not contact:
            return {
                "success": False,
                "status": "invalid_recipient",
                "message": "No valid WhatsApp number to send to.",
                "provider": self.name,
            }

        # WHATSAPP_ALERT_COOLDOWN is specifically an Unknown Person Alert
        # anti-spam floor (repeat sightings of the same/different unknown
        # people alerting the same number in quick succession). A Daily
        # Report send is at most once a day per recipient and already has
        # its own DB-backed idempotency guard (ReportLog) one layer up —
        # it must never be silently suppressed just because an unrelated
        # Unknown Person alert to the same number fired moments earlier.
        if template_name == UNKNOWN_PERSON_ALERT_TEMPLATE and self._within_cooldown(contact):
            print(
                f"[WhatsAppProvider] Cooldown active ({self.cooldown_seconds}s) — "
                f"suppressing repeat alert to {_mask_recipient(recipient)}"
            )
            return {
                "success": False,
                "status": "cooldown",
                "message": f"Suppressed by WHATSAPP_ALERT_COOLDOWN ({self.cooldown_seconds}s).",
                "provider": self.name,
            }

        param_value = ",".join(str(variables.get(key, "")) for key in param_keys)

        params = {
            "LicenseNumber": self.license_number,
            "APIKey": self.api_key,
            "Contact": contact,
            "Template": configured_template,
            "Param": param_value,
        }

        if image_path:
            image_url = build_public_image_url(customer_id, os.path.basename(image_path))

            if image_url:
                params["ImageUrl"] = image_url
            else:
                # No customer_id (or no filename) to build a link from —
                # degrade to text-only rather than fail the whole alert
                # over a missing photo.
                print(
                    "[WhatsAppProvider] Image attachment requested but no "
                    "customer_id/filename to build a public ImageUrl from — "
                    "sending text-only template."
                )

        if document_path:
            document_url = build_public_document_url(customer_id, os.path.basename(document_path))

            if document_url:
                params["DocumentUrl"] = document_url
                # The recipient's WhatsApp client shows this as the
                # attached file's name — falls back to the real on-disk
                # filename only if no nicer display name was given.
                params["DocumentFilename"] = document_filename or os.path.basename(document_path)
            else:
                # No customer_id (or no filename) to build a link from —
                # degrade to text-only rather than fail the whole report
                # over a missing PDF.
                print(
                    "[WhatsAppProvider] Document attachment requested but no "
                    "customer_id/filename to build a public DocumentUrl from — "
                    "sending text-only template."
                )

            if is_daily_report:
                print(
                    f"[DAILY REPORT] PDF document header — url_generated={bool(document_url)} "
                    f"filename={params.get('DocumentFilename')!r}"
                )

        try:
            response = requests.get(self.api_url, params=params, timeout=_REQUEST_TIMEOUT_SECONDS)
        except requests.exceptions.RequestException as e:
            # Deliberately not error_logging.log_exception(e, ...) here —
            # for a failed GET, requests puts the full request URL
            # (APIKey included, as a query parameter) into both the
            # exception's message and its traceback frames. Logging only
            # the exception's type keeps the key out of every log.
            print("[WHATSAPP] Failed to send alert")
            print(f"[WhatsAppProvider] request error — endpoint={self.api_url} type={type(e).__name__}")
            return {
                "success": False,
                "status": "send_failed",
                "message": "WhatsApp API request failed (network error).",
                "provider": self.name,
            }

        if is_daily_report:
            # The response BODY is the vendor's reply, never our own
            # request params — safe to log in full (no API key/license
            # in it), truncated only to keep log lines readable.
            print(
                f"[DAILY REPORT] WhatsApp API response — status={response.status_code} "
                f"body={response.text[:500]!r}"
            )

        if response.status_code != 200:
            print("[WHATSAPP] Failed to send alert")
            print(f"[WhatsAppProvider] non-200 response — endpoint={self.api_url} status={response.status_code}")
            return {
                "success": False,
                "status": "send_failed",
                "message": f"WhatsApp API returned HTTP {response.status_code}.",
                "provider": self.name,
            }

        return {"success": True, "status": "sent", "message": None, "provider": self.name}

    def send_media(self, recipient, image_path, caption=None):

        return self._not_configured(recipient, "media", {"image_path": image_path, "caption": caption})

    def send_document(self, recipient, document_path, caption=None):

        return self._not_configured(recipient, "document", {"document_path": document_path, "caption": caption})
