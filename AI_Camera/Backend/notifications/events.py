"""Event payloads passed from the AI detection pipeline into
NotificationService. The pipeline (face/unknown_manager.py) only ever
builds one of these plain dicts and hands it off — it never imports a
provider, never touches NotificationLog/ReportLog, and never knows
whether WhatsApp is configured. This is the seam the whole feature is
built around:

    AI Detection -> Unknown Confirmation -> Unknown Person Manager
        -> Notification Event -> NotificationService -> WhatsAppProvider
        -> External API (later)
"""

EVENT_UNKNOWN_PERSON_CONFIRMED = "UNKNOWN_PERSON_CONFIRMED"


def build_unknown_person_confirmed_event(
    customer_id,
    unknown_person_id,
    camera_id,
    camera_name,
    captured_image_path,
    confidence,
    detected_at,
    location=None,
    owner_user_id=None,
):
    """Plain dict, not a class — matches every other cross-module payload
    in this codebase (to_dict() rows, get_data_scope() results, etc.), so
    it round-trips through logging/queues/JSON with no extra step.

    `owner_user_id` (Per-User Data Isolation, User-Specific WhatsApp
    Report Settings) is the capturing camera's own Camera.owner_user_id
    — None for an unassigned camera. NotificationService uses it to
    decide whether to route this alert to that specific User's own
    WhatsApp number instead of the company-level fallback recipient."""

    return {
        "event": EVENT_UNKNOWN_PERSON_CONFIRMED,
        "customer_id": customer_id,
        "unknown_person_id": unknown_person_id,
        "camera_id": camera_id,
        "camera_name": camera_name,
        "captured_image_path": captured_image_path,
        "confidence": confidence,
        "detected_at": detected_at,
        "location": location,
        "owner_user_id": owner_user_id,
    }
