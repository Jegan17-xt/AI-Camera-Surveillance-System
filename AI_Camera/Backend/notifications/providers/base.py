"""BaseNotificationProvider — the interface every delivery channel
(WhatsApp today, anything else later) implements, so NotificationService
and reports/daily_report.py never depend on a concrete provider.

Every method returns a plain dict, never raises:
    {"success": bool, "status": str, "message": str, "provider": str}

"status" is a short machine-readable reason ("sent", "not_configured",
"error", ...); "message" is the human-readable one shown in
NotificationLog.error_message / ReportLog.error_message on failure.
"""


class BaseNotificationProvider:

    name = "base"

    def send_template(self, recipient, template_name, variables, image_path=None, customer_id=None):
        """A templated text message, optionally with a header image
        (e.g. the Unknown Person Alert). `image_path` is a local
        filesystem path; `customer_id` identifies whose file it is —
        a provider that supports header images needs both to turn it
        into whatever the API actually wants (e.g. a fetchable public
        URL)."""

        raise NotImplementedError

    def send_media(self, recipient, image_path, caption=None):
        """A standalone image with an optional caption."""

        raise NotImplementedError

    def send_document(self, recipient, document_path, caption=None):
        """A file attachment (e.g. the Daily Report PDF)."""

        raise NotImplementedError
