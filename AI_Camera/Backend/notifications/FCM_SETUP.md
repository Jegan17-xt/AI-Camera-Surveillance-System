# Super Admin "New Lead" push notifications (Firebase Cloud Messaging)

Web push, via Firebase Cloud Messaging — works whether the Super Admin's
site/TWA is open, backgrounded, or fully closed, because delivery is
handled by the browser's own Push API + a service worker, not by any tab
staying open. Nothing else in the app uses Firebase; WhatsApp alerts
(`notifications/providers/whatsapp.py`) are a completely separate,
untouched system.

## What triggers a notification

`POST /public/leads` (`api/routes.py`, both the Landing Page popup and
the Contact Page form post here) sends **exactly one** push, only when
`create_lead()` reports `is_new=True` — a brand-new phone number, never
a duplicate-phone update (`api/leads.py`'s dedup-by-phone). A failure
anywhere in the send path is caught and logged
(`notifications/fcm.py`'s `send_new_lead_notification`) — it can never
turn a successful lead submission into an error response, and the lead
is always saved regardless of whether the push succeeds.

## One-time setup

### 1. Create/use a Firebase project

[Firebase Console](https://console.firebase.google.com) → create a
project (or use an existing one) → **Project Settings**.

### 2. Backend credential — `FIREBASE_SERVICE_ACCOUNT_JSON`

Project Settings → **Service Accounts** → "Generate new private key" →
downloads a JSON file. Set its **entire contents**, as one line, as the
`FIREBASE_SERVICE_ACCOUNT_JSON` env var in `Backend/.env` (and on the
real AWS backend's environment):

```bash
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...", ...}
```

Never commit this file or value — `Backend/.env` is already git-ignored.
Left unset, `is_fcm_configured()` returns `False` and every push
silently no-ops (logged once at startup) — the rest of the app,
including lead creation itself, is completely unaffected.

### 3. Frontend config — `VITE_FIREBASE_*` + VAPID key

Project Settings → **General** → "Your apps" → add a **Web app** (if
none exists) → copy the `firebaseConfig` values into
`Frontend/Ai_FE/.env.production` (and `.env.development` for local
testing):

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Then **Project Settings → Cloud Messaging → Web configuration → Web
Push certificates** → "Generate key pair" → that's `VITE_FIREBASE_VAPID_KEY`.

None of these are secret — Firebase's web config is designed to ship in
the client bundle (security is enforced server-side/by rules, not by
hiding these values), and the VAPID key here is the **public** half of
the pair; its private half never leaves Firebase. Left empty,
`isFirebaseConfigured` is `false` and the Super Admin push UI simply
never appears — no error, no broken page.

### 4. Rebuild and redeploy the frontend

`npm run build` in `Frontend/Ai_FE` bakes the `VITE_FIREBASE_*` values
into the built bundle (Vite env vars are compile-time) — ship that
`dist/` the same way every other frontend deploy already does.

## How it works

- **Frontend** (`src/lib/firebase.js`,
  `super-admin/components/PushNotificationManager.jsx`, mounted only in
  `SuperAdminLayout.jsx` — never the Admin or User portals): on a Super
  Admin page load, if permission hasn't been decided yet, a small
  dismissible banner offers to enable notifications (never auto-prompts
  without a click). Once granted, a device token is fetched and POSTed
  to `POST /fcm/register-token` (`@super_admin_required`). Re-registering
  the same token is a harmless upsert (`notifications/fcm.py`'s
  `register_token`), so multiple Super Admin devices/browsers/accounts
  all end up with their own row in `fcm_tokens` and all get notified.
- **Foreground** (tab open + focused): `onMessage` in `firebase.js`
  shows an in-app toast; clicking it navigates to `/super-admin/leads`.
- **Background/closed**: `public/firebase-messaging-sw.js` — a
  dedicated service worker at its own scope
  (`/firebase-cloud-messaging-push-scope`), so it never conflicts with
  the app's separate PWA/caching worker (`public/sw.js`, root scope)
  — shows the OS-level notification and, on click, either focuses an
  already-open tab (posting it a message to navigate) or opens a new one
  at `/super-admin/leads`.
- **Backend** (`notifications/fcm.py`): on a new lead, loads every
  `fcm_tokens` row belonging to a Super Admin account (role-scoped at
  the query, not per-app), sends via
  `firebase_admin.messaging.send_each_for_multicast`, and deletes any
  token Firebase reports as `UnregisteredError` (uninstalled app,
  cleared browser data, expired subscription) so future sends don't keep
  retrying a dead device.

## Permission — what this can and can't do

Browser/OS notification permission is entirely the user's own choice —
nothing here can grant, bypass, or auto-enable it. If it's already
**denied** at the browser level, `PushNotificationManager` shows a
short note pointing at the browser's own site-settings UI (the
lock/info icon in the address bar → Notifications) instead of the
"Enable" banner — it never claims a way around that.

## Testing without waiting for a real device

```bash
cd Backend
python -c "
from api.leads import create_lead
from notifications.fcm import send_new_lead_notification, is_fcm_configured
print('configured:', is_fcm_configured())
lead, error, is_new = create_lead('Test', '9998887771', '', '', source='Landing Page')
print(lead, error, is_new)
if is_new:
    send_new_lead_notification(lead)  # no-ops safely if not configured; sends for real once it is
"
```

`is_new` must be `True` for a fresh phone number and `False` for a
repeat submission of the same one (from either the popup or the Contact
form) — confirms the dedup-vs-new distinction the whole notification
trigger depends on, independent of whether Firebase itself is
configured yet.
