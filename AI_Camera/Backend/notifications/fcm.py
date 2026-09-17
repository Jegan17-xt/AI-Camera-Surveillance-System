"""Firebase Cloud Messaging (FCM) web push — Super Admin "New Lead"
notifications only (see api/leads.py / api/routes.py's
public_leads_create). No other notification kind in this project uses
this module; WhatsApp alerts (notifications/providers/whatsapp.py) are
completely separate and untouched.

Every public function here is exception-isolated the same way
notifications/service.py's Unknown Person Alert path already is: a
missing/bad Firebase credential, a network error, or a single dead
device token must NEVER break lead creation — POST /public/leads must
keep succeeding and saving the lead even if every notification call
below fails outright.

Configuration (Backend/.env, never hardcoded):
    FIREBASE_SERVICE_ACCOUNT_JSON — the full Firebase service account
    JSON (Project Settings > Service Accounts > Generate new private
    key), as ONE-LINE JSON text in a single env var. Left unset, every
    function below simply no-ops (logs once, returns) — the app runs
    completely normally with push notifications disabled, same
    "_not_configured" degrade WhatsAppProvider already uses.
"""

import json
import os
from datetime import datetime

from sqlalchemy import select

from db import get_session
from auth.models import FcmToken, User
from auth.database import ROLE_SUPER_ADMIN
from error_logging import log_exception

try:
    import firebase_admin
    from firebase_admin import credentials, messaging
except ImportError:  # pragma: no cover - firebase-admin is an optional prod dependency
    firebase_admin = None
    credentials = None
    messaging = None

TOKEN_MAX_LEN = 255

_firebase_app = None
_init_attempted = False
_warned_not_configured = False


def init_fcm_tokens_table():
    """Table creation is handled by Base.metadata.create_all() in
    auth.database.init_db() — `fcm_tokens` is a brand-new table, nothing
    to migrate. Kept only for startup-call symmetry with every other
    api/*.py module's init_*_table() (see api/app.py)."""


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def is_fcm_configured():
    """True once a real Firebase app has been (or can be) initialized —
    used by the register-token route to give the frontend an honest
    answer instead of silently accepting a token nothing will ever use."""

    return _get_app() is not None


def _get_app():
    """Lazy, once-only init — mirrors db.py's module-level engine: cheap
    to call repeatedly, only does real work the first time. Returns None
    (never raises) if firebase-admin isn't installed or isn't configured,
    so every caller can just check `if app is None: return` instead of
    handling an exception."""

    global _firebase_app, _init_attempted, _warned_not_configured

    if _firebase_app is not None:
        return _firebase_app

    if _init_attempted:
        return None

    _init_attempted = True

    if firebase_admin is None:
        print("[fcm] firebase-admin package not installed — Lead push notifications disabled.")
        return None

    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")

    if not raw:
        if not _warned_not_configured:
            print("[fcm] FIREBASE_SERVICE_ACCOUNT_JSON is not set — Lead push notifications disabled.")
            _warned_not_configured = True
        return None

    try:
        service_account_info = json.loads(raw)
        cred = credentials.Certificate(service_account_info)
        _firebase_app = firebase_admin.initialize_app(cred)
        print("[fcm] Firebase Admin initialized — Lead push notifications enabled.")
        return _firebase_app
    except Exception as e:
        # Never let a malformed credential crash app startup/import — the
        # rest of the app (including lead creation itself) must keep
        # working unaffected.
        log_exception(e, context="fcm_init")
        print(f"[fcm] Failed to initialize Firebase Admin ({type(e).__name__}) — Lead push notifications disabled.")
        return None


def register_token(user_id, token):
    """Upsert one Super Admin device's FCM token. `user_id` must already
    be verified as a Super Admin by the caller (see
    api/routes.py's @super_admin_required route) — this function itself
    does not re-check the role, same division of responsibility every
    other api/*.py write function in this codebase uses (route validates
    identity/authorization, the module below just persists). Returns
    (True, None) or (None, error)."""

    token = (token or "").strip()

    if not token:
        return None, "Device token is required."

    if len(token) > TOKEN_MAX_LEN:
        return None, "Device token is invalid."

    with get_session() as session:
        existing = session.scalar(select(FcmToken).where(FcmToken.token == token))
        now = _now()

        if existing is not None:
            # Same token re-registering (page reload, token refresh
            # firing again) — just bump ownership/timestamp rather than
            # inserting a duplicate row. Reassigning user_id covers the
            # rare case of a shared browser profile switching between two
            # Super Admin accounts on the same device.
            existing.user_id = user_id
            existing.updated_at = now
        else:
            session.add(FcmToken(user_id=user_id, token=token, created_at=now, updated_at=now))

    return True, None


def unregister_token(token):
    """Removes one token (logout / "turn off notifications on this
    device"). Returns True if a row was deleted, False if it was already
    gone — either way nothing to error about."""

    token = (token or "").strip()

    if not token:
        return False

    with get_session() as session:
        row = session.scalar(select(FcmToken).where(FcmToken.token == token))

        if row is None:
            return False

        session.delete(row)
        return True


def _list_super_admin_tokens():

    with get_session() as session:
        rows = session.execute(
            select(FcmToken.token).join(User, User.id == FcmToken.user_id).where(User.role == ROLE_SUPER_ADMIN)
        ).all()
        return [row[0] for row in rows]


def _delete_tokens(tokens):

    if not tokens:
        return

    with get_session() as session:
        session.query(FcmToken).filter(FcmToken.token.in_(tokens)).delete(synchronize_session=False)


def send_new_lead_notification(lead):
    """Fire-and-forget push to every registered Super Admin device —
    called only for a genuinely NEW lead (see api/routes.py's
    public_leads_create; a duplicate-phone update never reaches here).
    No-ops quietly (Firebase not configured, or no Super Admin has
    registered a device yet) — this is always best-effort, on top of the
    lead already being safely saved in the database and visible on the
    Leads page regardless of whether this push ever arrives."""

    try:
        app = _get_app()

        if app is None:
            return

        tokens = _list_super_admin_tokens()

        if not tokens:
            print("[fcm] New lead saved but no Super Admin device is registered for push — skipping notification.")
            return

        name = (lead.get("name") or "Someone").strip()
        phone = (lead.get("phone") or "").strip()
        title = "New Lead Received"
        body = f"New lead from {name} - {phone}" if phone else f"New lead from {name}"

        message = messaging.MulticastMessage(
            tokens=tokens,
            notification=messaging.Notification(title=title, body=body),
            data={
                "type": "new_lead",
                "leadId": str(lead.get("id", "")),
                "source": str(lead.get("source", "")),
                # Relative path — the service worker's notificationclick
                # handler resolves this against its own origin, so this
                # never needs to know the deployed frontend's domain.
                "click_action": "/super-admin/leads",
            },
            webpush=messaging.WebpushConfig(
                notification=messaging.WebpushNotification(title=title, body=body, icon="/icons/icon-192.png"),
            ),
        )

        response = messaging.send_each_for_multicast(message, app=app)

        invalid_tokens = [
            token
            for token, result in zip(tokens, response.responses)
            if not result.success and isinstance(result.exception, messaging.UnregisteredError)
        ]

        if invalid_tokens:
            _delete_tokens(invalid_tokens)
            print(f"[fcm] Removed {len(invalid_tokens)} invalid/unregistered device token(s).")

        print(f"[fcm] New lead push sent — success={response.success_count} failure={response.failure_count}")
    except Exception as e:
        # Whatever went wrong (network, quota, malformed message, a
        # firebase_admin internal error), the lead itself was already
        # committed to the database before this function was ever
        # called — this is purely best-effort on top of that.
        log_exception(e, context="fcm_send_new_lead")
