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

Image attachment: ImageUrl (a publicly fetchable HTTPS URL, alongside
the existing Template/Param/Contact params) is what this API accepts
without error for every template kind — the request returns HTTP 200
with the vendor's own "message_status":"accepted" regardless of
whether ImageUrl is present, reachable, or garbage. That response is
NOT confirmation the header image actually renders: this vendor's
JSON reply is Meta's own WhatsApp Cloud API response shape passed
straight through, and Meta's Cloud API accepts a template send
synchronously before it ever fetches the header media — the fetch
(and any rendering fallback) happens after, invisibly to this
process. It is NOT a direct file upload either way — sendtemplate.php
stays a GET request, so the image has to already be hosted somewhere
their servers can reach; see notifications/image_links.py for how a
locally saved unknown-face image becomes that URL.

Root-cause investigation (2026-09-02, live production data, customer_id=5):
the Unknown Person Alert's approved `Unknown_person_alert` template kept
showing its own static header image in the actually-delivered WhatsApp
message, even after independently proving every layer this process
controls: the snapshot file, the signed public URL (self-fetched and
byte-verified equal to the source file, through a genuinely live
tunnel — ruling out the "accepted but unreachable" trap this exact
vendor is separately known for, see build_public_image_url's docstring),
and the request payload (confirmed via a real full-payload dump).
ImageUrl, MediaUrl, HeaderImage, and Image were all sent together in
the same request as a further diagnostic — still no change. With every
parameter name this integration has ever tried ruled out, the remaining
explanation is that this specific approved template's header was set
up on the vendor's/Meta's side as a fixed image, not a dynamic image
variable — a template-configuration limit outside this codebase, not
fixable by changing what we send here. If the vendor's dashboard is
ever used to re-approve or replace this template with a genuine
dynamic IMAGE header, this code needs no changes to pick that up —
ImageUrl is already exactly what such a header expects.

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

AI Detection Alert (ai_detection_alert, added 2026-09-01) is a
DISTINCT ALERT KIND on this same mechanism, for events/manager.py's
non-face detections (fire, smoke, vehicle, animal, bird), sending the
actual captured snapshot as ImageUrl, same as Unknown Person Alert's
photo — except the snapshot lives under a DIFFERENT folder
(api.detection_events.detection_events_folder, not unknown_folder) with
a subfolder-relative path, so it needs its own signed-URL builder
(notifications/image_links.py's build_public_event_image_url) rather
than reusing build_public_image_url. Recipient resolution deliberately
reuses Unknown Person Alert's own company-level fallback number
(NotificationSettings.unknown_alert_recipient, else the Company Admin's
registered phone) — see notifications/service.py's
deliver_ai_detection_alert — rather than adding a second, separate
recipient setting; there is no enable/disable toggle of its own either,
since fire/vehicle/animal detection being enabled at all (the existing
AI Settings toggles) is already the gate for whether an event — and so
this alert — ever fires.

TEMPORARILY (2026-09-01, until a dedicated ai_detection_alert template
is approved on the vendor's dashboard), this alert kind is sent through
the ALREADY-APPROVED Unknown Person Alert template — self.template_name
(WHATSAPP_TEMPLATE) and its 3-param ("camera", "date", "time") shape,
NOT a separate WHATSAPP_AI_DETECTION_TEMPLATE / 4-param shape (that
plumbing — self.ai_detection_template_name / _AI_DETECTION_ALERT_
PARAM_KEYS below — exists but is currently unused; see the comment on
send_template's AI_DETECTION_ALERT_TEMPLATE branch for how to switch it
back on). This IS the fix for "the sample header image was shown
instead of the real snapshot": that was never a bug in the ImageUrl-
building code — it happened because the send was targeting a Template
name the vendor's API doesn't recognize at all, so the request never
got far enough to look at ImageUrl. `_within_cooldown` is keyed by
(contact, template_name kind) rather than contact alone specifically
because of this reuse — otherwise a Fire alert and a genuine Unknown
Person alert to the same number could suppress each other.

Any other template_name (daily_unknown_count, ...) has no confirmed
request format either, so it keeps the original "not configured" stub
behavior untouched.
"""

import os
import re
import threading
import time

import requests

from notifications.image_links import build_public_image_url, build_public_document_url, build_public_event_image_url
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

# AI Detection Alert — events/manager.py's non-face detections (fire,
# smoke, vehicle, animal, bird), added 2026-09-01. Same confirmed
# request mechanism as the two templates above (GET sendtemplate.php,
# ImageUrl as the header image), its own WHATSAPP_AI_DETECTION_TEMPLATE-
# configured template name (independent of the other two — none of the
# three ever have to be reconfigured together) and its own {{1}}..{{4}}
# order:
#   {{1}} Detection Type  {{2}} Date  {{3}} Time  {{4}} Location
AI_DETECTION_ALERT_TEMPLATE = "ai_detection_alert"
_AI_DETECTION_ALERT_PARAM_KEYS = ("detection_type", "date", "time", "location")

_REQUEST_TIMEOUT_SECONDS = 10

# Module-level (not per-instance): NotificationService's _provider()
# constructs a fresh WhatsAppProvider() on every call, so per-recipient
# cooldown state has to live outside the instance to mean anything.
_cooldown_lock = threading.Lock()
_last_sent_at = {}  # (normalized contact, template_name kind) -> time.monotonic() of last send attempt


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
        # Same independence — its own env var, its own default.
        self.ai_detection_template_name = os.environ.get("WHATSAPP_AI_DETECTION_TEMPLATE") or "AI_Detection_Alert"
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

    def _within_cooldown(self, contact, kind):
        """Hard, provider-level floor (WHATSAPP_ALERT_COOLDOWN) on top of
        NotificationService's own per-unknown-person-id cooldown/dedup —
        this one is keyed by (recipient number, alert kind), so it also
        catches e.g. two different unknown people alerting the same
        recipient in quick succession. Records the attempt whether or
        not it turns out to be within cooldown, so back-to-back calls in
        the same instant only ever let the first one through.

        `kind` is `template_name` (UNKNOWN_PERSON_ALERT_TEMPLATE or
        AI_DETECTION_ALERT_TEMPLATE), not the actual vendor Template
        string sent — AI Detection Alert currently reuses Unknown Person
        Alert's own approved template/param shape (ai_detection_alert
        isn't approved yet), so keying by contact ALONE would let a Fire
        alert suppress a genuine Unknown Person alert to the same number
        moments later, or vice versa. Keeping them separate keys means
        Unknown Person Alert's own cooldown timing is exactly what it
        was before AI Detection Alert existed."""

        now = time.monotonic()
        key = (contact, kind)

        with _cooldown_lock:
            last = _last_sent_at.get(key)

            if last is not None and (now - last) < self.cooldown_seconds:
                return True

            _last_sent_at[key] = now
            return False

    def send_template(self, recipient, template_name, variables, image_path=None, document_path=None, document_filename=None, customer_id=None, image_kind=None):

        is_daily_report = template_name == DAILY_REPORT_SUMMARY_TEMPLATE
        is_ai_detection_alert = template_name == AI_DETECTION_ALERT_TEMPLATE
        is_unknown_person_alert = template_name == UNKNOWN_PERSON_ALERT_TEMPLATE

        if template_name == UNKNOWN_PERSON_ALERT_TEMPLATE:
            configured_template = self.template_name
            param_keys = ("camera", "date", "time")
        elif is_daily_report:
            configured_template = self.daily_report_template_name
            param_keys = _DAILY_REPORT_PARAM_KEYS
        elif template_name == AI_DETECTION_ALERT_TEMPLATE:
            # TEMPORARY, until a dedicated ai_detection_alert template is
            # approved on My Dreams Technology's dashboard: reuses the
            # ALREADY-APPROVED Unknown Person Alert template/param shape
            # (self.template_name / WHATSAPP_TEMPLATE, 3 params) instead
            # of self.ai_detection_template_name / _AI_DETECTION_ALERT_
            # PARAM_KEYS above — sending with an unapproved Template name
            # is exactly why the vendor was rendering its own sample
            # header image instead of ImageUrl (the request never even
            # reached real template rendering). Swap this branch back to
            # the ai_detection_template_name/_AI_DETECTION_ALERT_PARAM_KEYS
            # pair once that template exists — nothing else about this
            # feature (image attachment, recipient resolution, event
            # wiring) needs to change when that happens.
            configured_template = self.template_name
            param_keys = ("camera", "date", "time")
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

        if is_ai_detection_alert:
            print(f"[NOTIFICATION-TRACE] Template: {configured_template}")

        if is_unknown_person_alert:
            print(f"[UNKNOWN-WA] WhatsApp template: {configured_template}")

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

        # WHATSAPP_ALERT_COOLDOWN is an anti-spam floor for the two alert
        # kinds that can genuinely fire back-to-back for the same
        # recipient — repeat sightings of the same/different unknown
        # people (Unknown Person Alert), and several detection types
        # (fire, then smoke, then a vehicle) tripping within seconds of
        # each other (AI Detection Alert, on top of events/manager.py's
        # own per-event-type cooldown, which only rate-limits ONE type at
        # a time, not the recipient as a whole). A Daily Report send is
        # at most once a day per recipient and already has its own
        # DB-backed idempotency guard (ReportLog) one layer up — it must
        # never be silently suppressed just because an unrelated alert to
        # the same number fired moments earlier.
        if template_name in (UNKNOWN_PERSON_ALERT_TEMPLATE, AI_DETECTION_ALERT_TEMPLATE) and self._within_cooldown(contact, template_name):
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
            # `image_kind` (not `template_name`) decides which local folder/
            # signed-URL builder this path belongs to — a Daily Report send
            # can carry EITHER an unknown-face image OR a fire/vehicle/
            # animal/bird DetectionEvent snapshot depending on which one is
            # most recent that day (see reports/daily_report.py's
            # _latest_detection_snapshot), so the choice can no longer be
            # inferred from which vendor Template is being used. Defaults
            # to "unknown_person" so Unknown Person Alert's own existing
            # call site (which never passes image_kind) is completely
            # unaffected.
            resolved_image_kind = image_kind or "unknown_person"

            if is_daily_report:
                print(f"[WHATSAPP-REPORT] Snapshot path: {image_path}")

            if resolved_image_kind == "detection_event":
                # events/manager.py's DetectionEvent.image_path — a
                # "<DD-MM-YYYY>/<file>.jpg" SUBFOLDER-relative path (not a
                # bare filename, unlike the branch below), served from a
                # different folder (detection_events_folder, not
                # unknown_folder) — see notifications/image_links.py's
                # build_public_event_image_url.
                image_url = build_public_event_image_url(customer_id, image_path)
            else:
                image_url = build_public_image_url(customer_id, os.path.basename(image_path))

            if is_daily_report:
                print(f"[WHATSAPP-REPORT] Snapshot URL: {image_url}")

            if is_ai_detection_alert:
                print(f"[NOTIFICATION-TRACE] Image URL: {image_url}")

            if is_unknown_person_alert:
                print(f"[UNKNOWN-WA] Public ImageUrl: {image_url}")
                if image_url:
                    # Self-check: actually fetch the URL we're about to hand
                    # the vendor, the same way their servers would, instead
                    # of just trusting build_public_image_url's return value
                    # — proves the signed link is genuinely reachable right
                    # now, not just well-formed.
                    try:
                        probe = requests.get(image_url, timeout=_REQUEST_TIMEOUT_SECONDS)
                        print(f"[UNKNOWN-WA] ImageUrl HTTP status: {probe.status_code} ({len(probe.content)} bytes)")
                    except requests.exceptions.RequestException as probe_err:
                        print(f"[UNKNOWN-WA] ImageUrl HTTP status: request failed — {type(probe_err).__name__}")
                else:
                    print("[UNKNOWN-WA] ImageUrl HTTP status: N/A (no URL built)")

            if image_url:
                params["ImageUrl"] = image_url
                if is_daily_report:
                    print(f"[WHATSAPP-REPORT] Sending dynamic image: {image_url}")
                    print(f"[WHATSAPP-REPORT] Template image parameter: ImageUrl={image_url}")
                if is_unknown_person_alert:
                    print(f"[UNKNOWN-WA] Image parameter sent: ImageUrl={image_url}")
            else:
                # No customer_id (or no filename) to build a link from —
                # degrade to text-only rather than fail the whole alert
                # over a missing photo. Passing the actual captured
                # snapshot here (never the template's own sample/default
                # image) is the whole point of every image_path caller.
                print(
                    "[WhatsAppProvider] Image attachment requested but no "
                    "customer_id/filename to build a public ImageUrl from — "
                    "sending text-only template."
                )
                if is_daily_report:
                    print("[WHATSAPP-REPORT] Could not build a public snapshot URL — sending without a dynamic image.")
                if is_unknown_person_alert:
                    print("[UNKNOWN-WA] Image parameter sent: None (no ImageUrl in payload)")

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

        if is_unknown_person_alert:
            masked_params = {**params, "LicenseNumber": "***", "APIKey": "***"}
            print(f"[UNKNOWN-WA] Full API payload (mask credentials): {masked_params}")

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
            if is_ai_detection_alert:
                print(f"[NOTIFICATION-TRACE] API response: network error — {type(e).__name__}")
            if is_unknown_person_alert:
                print(f"[UNKNOWN-WA] API response: network error — {type(e).__name__}")
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

        if is_ai_detection_alert:
            print(f"[NOTIFICATION-TRACE] API response: status={response.status_code} body={response.text[:500]!r}")

        if is_unknown_person_alert:
            print(f"[UNKNOWN-WA] API response: status={response.status_code} body={response.text[:500]!r}")

        if response.status_code != 200:
            print("[WHATSAPP] Failed to send alert")
            print(f"[WhatsAppProvider] non-200 response — endpoint={self.api_url} status={response.status_code}")
            return {
                "success": False,
                "status": "send_failed",
                "message": f"WhatsApp API returned HTTP {response.status_code}.",
                "provider": self.name,
            }

        if is_daily_report and image_path:
            print("[WHATSAPP-REPORT] Message sent successfully")

        return {"success": True, "status": "sent", "message": None, "provider": self.name}

    def send_media(self, recipient, image_path, caption=None):

        return self._not_configured(recipient, "media", {"image_path": image_path, "caption": caption})

    def send_document(self, recipient, document_path, caption=None):

        return self._not_configured(recipient, "document", {"document_path": document_path, "caption": caption})
