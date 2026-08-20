import os
import sys
from datetime import timedelta

from flask import Flask, request
from flask_cors import CORS

from api.routes import api
from auth.database import init_db, get_or_create_secret_key
from api.settings import init_settings_table
from api.cameras import init_cameras_table
from api.branding import init_branding_table
from api.ai_config import init_ai_config_table
from api.subscriptions import init_subscriptions_table
from api.registered import init_registered_persons_table
from api.attendance import init_attendance_table
from api.unknown import init_unknown_persons_table
from api.notification_settings import init_notification_report_tables
from api.billing import init_billing_tables
from api.retention_settings import init_retention_tables
from camera.detection_service import start_all_enabled_cameras
from reports.scheduler import start_report_scheduler
from retention.scheduler import start_retention_scheduler

app = Flask(__name__)

# Auth Setup
init_db()
app.secret_key = get_or_create_secret_key()

# Settings Setup — creates the app_settings table if this is the first
# run, so GET /settings always has a real (if default-filled) row to
# read the moment the app starts.
init_settings_table()

# Cameras Setup — must run after init_db(), since the cameras table's
# FOREIGN KEY references the users table.
init_cameras_table()

# Branding Setup — platform-wide Application Name/Logo (Super Admin
# System Settings), independent of any customer's own per-customer
# app_settings row.
init_branding_table()

# AI Configuration Setup — per-customer Super Admin-only pipeline
# toggles (Customers > Customer Details > AI Configuration). Must run
# after init_db(), since the table's FOREIGN KEY references users.
init_ai_config_table()

# Subscription & Payment Setup — Super Admin's manual per-company plan/
# status records and payment log. Must run after init_db(), since both
# tables' FOREIGN KEY references users.
init_subscriptions_table()

# Per-User Data Isolation — owner_user_id backfill for the three tables
# that predate this column (Camera's own backfill already runs inside
# init_cameras_table() above). Must run after init_db(), same FOREIGN
# KEY-references-users reasoning as everything above. The new
# `notifications` table needs no migration here — it's created directly
# by init_db()'s Base.metadata.create_all() since it's brand new.
init_registered_persons_table()
init_attendance_table()
init_unknown_persons_table()

# Notification & Reporting Layer — backfills notification_logs/
# report_logs with the columns User-Specific WhatsApp Report Settings
# added after those two tables already existed live. Must run after
# init_db(), same reasoning as everything above.
init_notification_report_tables()

# Project-Wide Billing & Pricing — backfills billing_cycle/status/
# transaction_id/subtotal/tax_amount onto the existing `payments` table
# and seeds the real default billing catalog (modules, WhatsApp
# notifications, camera/storage/hosting lines). Must run after
# init_db(), same FOREIGN-KEY-references-users/permissions reasoning as
# everything above.
init_billing_tables()

# Data Retention — Super Admin's per-Company-Admin auto-delete policy for
# captured/generated data (Admin & User Overview page). Brand-new table,
# no migration needed; init_retention_tables() exists only so this
# startup sequence reads the same as every other init_*_table() call
# site above. Must run after init_db(), same FOREIGN-KEY-references-
# users reasoning as everything above.
init_retention_tables()

# Production Deployment (AWS EC2): FLASK_DEBUG controls both Werkzeug's
# debug mode/auto-reloader below AND the background-services guard right
# here — unset (or anything other than "true"/"1"/"yes") means
# production-safe by default: no interactive debugger, no reloader.
# Never enable this on a server reachable from the open internet — the
# Werkzeug debugger allows arbitrary code execution to anyone who can
# reach it. Set FLASK_DEBUG=true only for local development.
_flask_debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes")

# AI Detection Engine — starts every enabled camera's own background
# worker (camera/detection_service.py) the moment the backend process
# comes up, independent of the React frontend, any logged-in session, or
# any Live Camera page ever being opened. Runs for as long as this
# process runs; a worker only stops if its camera is disabled, deleted,
# or the backend itself stops.
#
# _should_start_background_services is True in exactly one process,
# whichever mode is active:
#   - FLASK_DEBUG off (production/EC2, no reloader): there is only ONE
#     process ever, and Werkzeug never sets WERKZEUG_RUN_MAIN in this
#     mode at all — so this must run unconditionally, not gated on that
#     env var. This is also true with zero cameras configured yet (a
#     fresh EC2 deployment): the loop below simply iterates nothing and
#     returns immediately — no RTSP connection, and no local device
#     (e.g. /dev/video0) is ever touched by this call, so the API starts
#     and serves requests fine with no camera attached at all.
#   - FLASK_DEBUG on (local dev): Werkzeug's reloader re-execs THIS
#     ENTIRE MODULE in a child process and sets WERKZEUG_RUN_MAIN=true
#     only inside that real, serving child — the outer "watcher" process
#     (which never serves a single request, see restart_with_reloader in
#     werkzeug/_reloader.py) also imports this module top-to-bottom on
#     its way to calling app.run(). Without this half of the guard,
#     every camera would get TWO competing workers in dev — one in the
#     outer process that serves nothing but still opens RTSP connections
#     and writes duplicate attendance/unknown-person rows, and one in
#     the real server.
_should_start_background_services = (
    not _flask_debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true"
)

if _should_start_background_services:
    start_all_enabled_cameras()

    # Notification & Reporting Layer — Daily Report scheduler. Same
    # guard as the AI Detection Engine above, same reasoning. A scheduler
    # failure is isolated inside reports/scheduler.py itself and can
    # never affect camera workers.
    start_report_scheduler()

    # Data Retention scheduler — same guard, same reasoning: exactly one
    # background sweep thread, isolated inside retention/scheduler.py,
    # independent of the Super Admin page ever being open.
    start_retention_scheduler()

# HTTPS + Secure Session Cookie (security fix): the cookie's `Secure`
# attribute tells the browser to withhold it from any plain http://
# request — correct and necessary once this app sits behind a TLS-
# terminating reverse proxy (nginx, an AWS ALB, etc), but flipping it on
# unconditionally here would silently break every login the instant this
# ships to a deployment where that reverse proxy isn't set up yet — a
# real possibility today, since nothing in this repo configures one (see
# app.run(host="0.0.0.0", ...) below). Left OFF unless explicitly turned
# on via env var, so this change has ZERO effect on today's behavior
# until whoever deploys this has actually finished the TLS side and can
# safely opt in. Local HTTP development is completely unaffected either
# way, since it's the same "unset = off" default.
_session_cookie_secure = os.environ.get("SESSION_COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes")

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=_session_cookie_secure,
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    # Without this, Werkzeug fully buffers a request body of ANY size
    # before any handler's own per-file size check ever runs — a request
    # could exhaust memory/disk before being rejected. 100MB comfortably
    # covers the largest legitimate upload today (Registered Persons'
    # multi-image add/edit form, up to MIN_IMAGES=20+ files at up to
    # api/registered.py's own MAX_IMAGE_BYTES=5MB each); every smaller
    # upload (avatar, branding logo, camera test-connection preview) is
    # far under this. Werkzeug returns 413 Request Entity Too Large for
    # anything over it, before any handler code runs.
    MAX_CONTENT_LENGTH=100 * 1024 * 1024,
)

# Enable React Access (credentials required so the session cookie is sent).
# Vite picks the next free port (5173, 5174, ...) when one is already in
# use, so both are whitelisted here — never "*", since supports_credentials
# requires an explicit origin per the CORS spec.
CORS(
    app,
    supports_credentials=True,
    origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
    ],
)

# Register Routes
app.register_blueprint(api)


@app.after_request
def apply_no_store(response):
    """Every response from this API carries session-gated data (or the
    session cookie itself). Without this, a browser is free to serve a
    prior response — including a still-200 /dashboard or /me payload —
    from disk cache or back-forward cache after the session that produced
    it has been logged out, which is exactly how a "logged-out user still
    sees protected data" report happens without any code path being
    individually wrong.

    /public/unknown-image/... is the one deliberate exception: it's
    already access-controlled by its own HMAC signature + expiry
    (notifications/image_links.py), not by session, and it exists
    specifically for wa.mydreamstechnology.in's servers to fetch and
    cache on WhatsApp's own CDN before delivering the image to a
    recipient's device — confirmed live that a blanket no-store here
    was silently preventing that (ImageUrl requests never even showed
    up in this app's own access log, meaning their fetcher gave up
    before ever completing a GET). A positive, short cache window
    matching the signed link's own TTL is safe: the link is already
    single-purpose and about to expire regardless.
    """

    if request.path.startswith("/public/unknown-image/"):
        response.headers["Cache-Control"] = "public, max-age=900"
        response.headers.pop("Pragma", None)
        return response

    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response

# Run Server
if __name__ == "__main__":
    # Werkzeug's reloader (the `watchdog`-backed one, since that package is
    # installed) watches every entry on sys.path as a raw directory root,
    # with no filtering of its own for that path — unlike its stat-based
    # fallback, it never checks sys.prefix here. Because this project runs
    # against the global per-user Python install rather than a virtualenv,
    # sys.path includes the interpreter's own Lib/site-packages directory
    # directly, so — left unexcluded — the reloader ends up recursively
    # watching the *entire* Python installation: every third-party package
    # (NumPy, OpenCV, onnxruntime, InsightFace, ...), not just this
    # project's own files. Any change inside any of them (e.g. a compiled
    # extension's cache being touched) then triggers a full app restart.
    # Excluding the interpreter's own prefix directories keeps the
    # reloader — and debug mode's auto-restart — scoped to this project's
    # source tree only.
    _python_prefixes = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix}
    _reloader_exclude_patterns = [f"{prefix}*" for prefix in _python_prefixes] + [
        "*/site-packages/*",
        "*/dist-packages/*",
        # __pycache__/*.pyc files inside this project's OWN tree are not
        # excluded by the patterns above (they're not under a Python
        # prefix or site-packages) — every first-time import writes one,
        # which the watchdog reloader reads as a real source change and
        # restarts on, interrupting whatever the live camera pipeline was
        # doing mid-frame. Confirmed live in this project's own logs: a
        # cascade of "Detected change ... reloading" across many
        # unrelated files, immediately followed by an in-flight
        # serve_forever thread exception.
        "*/__pycache__/*",
        # --- Windows path-separator fix for the exclusion above ---
        # watchdog's PatternMatchingEventHandler matches paths via
        # pathlib.PurePosixPath(raw_path).match(pattern) (see
        # watchdog.utils.patterns._match_path) — PurePosixPath only
        # recognizes '/' as a directory separator. A real Windows path
        # (backslash-separated) parses as a SINGLE path component with no
        # '/' in it at all, so a slash-anchored pattern like
        # "*/__pycache__/*" or "*/site-packages/*" NEVER matches on
        # Windows — confirmed directly: PurePosixPath(a real Windows
        # __pycache__ path).match("*/__pycache__/*") returns False. The
        # slash-based patterns above are silently dead code on this OS,
        # which is exactly how the "Confirmed live" incident above kept
        # recurring even after they were added: every first-time module
        # import during live AI processing (detection/detector.py,
        # face/face_detector.py, and everything frame_processor.py lazily
        # imports on the first real frame — api.ai_config, face.quality,
        # face.recognizer, face.track_verifier, attendance.attendance,
        # ...) writes a fresh .pyc, which still matches the watched
        # "*.pyc" pattern and triggers a full restart, tearing down every
        # camera worker thread mid-frame before it can ever publish an
        # annotated frame. A slash-FREE substring pattern has no
        # separator to get lost — it matches the *.pyc path as one flat
        # string on Windows, and still matches correctly as a path
        # component on real POSIX systems where PurePosixPath parses
        # normally, so both platforms are covered by keeping both pattern
        # forms in this list.
        "*__pycache__*",
        "*site-packages*",
        "*dist-packages*",
        # Editors, IDEs, and file-sync/backup/AV tools commonly write a
        # file's new contents to a sibling temp file first, then rename it
        # over the original (atomic save — avoids a half-written file if
        # the write is interrupted). That create+rename is itself a real
        # filesystem event, and the watchdog reloader's ReadDirectoryChanges
        # -based backend sees it regardless of the temp file's own name
        # never being one of the project's tracked .py files — confirmed
        # live in this project's own logs again: a burst of "Detected
        # change" across several UNRELATED .py files (their own mtimes
        # unchanged) landing at the same instant, immediately followed by
        # "Restarting with watchdog" and every running camera worker
        # thread being torn down mid-frame. These patterns match the
        # naming convention every atomic-save implementation we've
        # observed here uses (e.g. frame_processor.py.tmp.<random>) —
        # source changes never look like this, so it's always safe to
        # ignore.
        "*.tmp",
        "*.tmp.*",
        "*~",
        "*.swp",
        "*.bak",
    ]

    app.run(
        host="0.0.0.0",
        port=5000,
        # Production (FLASK_DEBUG unset/false, e.g. on EC2): no debugger,
        # no auto-reloader — see _flask_debug's comment above for why
        # that matters on a server reachable from the open internet.
        # Local dev (FLASK_DEBUG=true): identical behavior to before this
        # change.
        debug=_flask_debug,
        # The live camera MJPEG stream is a long-lived connection — without
        # threading, it would block every other request on the dev server
        # for as long as anyone has the Live Camera page open.
        threaded=True,
        use_reloader=_flask_debug,
        exclude_patterns=_reloader_exclude_patterns if _flask_debug else None,
    )