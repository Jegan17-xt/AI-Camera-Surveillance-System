import os
import re
import sys
import uuid
from datetime import timedelta

from flask import Flask, g, jsonify, request, session
from flask_cors import CORS

from api.routes import api
from auth.database import init_db, get_or_create_secret_key, log_security_event, get_user_by_id
from auth.csrf import validate_csrf, set_csrf_cookie, SAFE_METHODS as CSRF_SAFE_METHODS
from error_logging import log_exception
from api.settings import init_settings_table
from api.cameras import init_cameras_table
from api.sites import init_sites_tables
from api.branding import init_branding_table
from api.website_content import init_website_content_table
from api.ai_config import init_ai_config_table
from api.subscriptions import init_subscriptions_table
from api.registered import init_registered_persons_table
from api.attendance import init_attendance_table
from api.unknown import init_unknown_persons_table
from api.notification_settings import init_notification_report_tables
from api.billing import init_billing_tables
from api.module_packages import init_module_packages_tables
from api.retention_settings import init_retention_tables
from api.detection_events import init_detection_events_table
from api.leads import init_leads_table
from notifications.fcm import init_fcm_tokens_table
from camera.detection_service import start_all_enabled_cameras
from camera import ai_prewarm
from reports.scheduler import start_report_scheduler
from retention.scheduler import start_retention_scheduler

app = Flask(__name__)

# Production Deployment (AWS EC2): FLASK_DEBUG controls Werkzeug's debug
# mode/auto-reloader (see app.run() below), the background-services guard,
# and — Phase 2 — how strictly CORS/logging behave. Moved to the very top
# so every section below (CORS included) can rely on it. Unset (or
# anything other than "true"/"1"/"yes") means production-safe by default:
# no interactive debugger, no reloader, strict CORS. Never enable this on
# a server reachable from the open internet — the Werkzeug debugger
# allows arbitrary code execution to anyone who can reach it.
_flask_debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes")

# Auth Setup
init_db()
app.secret_key = get_or_create_secret_key()

# Settings Setup — creates the app_settings table if this is the first
# run, so GET /settings always has a real (if default-filled) row to
# read the moment the app starts.
init_settings_table()

# Site / VPN Gateway Management Setup — creates/backfills the `sites`,
# `site_users`, and `cameras.site_id` schema. Both the `sites` and
# `cameras` tables it touches are already created by init_db()'s
# Base.metadata.create_all() above, so this only needs to run after
# init_db(). It MUST run before init_cameras_table(): on a database that
# predates the `site_id` column, init_cameras_table()'s own ORM query
# selects Camera (which now includes `site_id`), so that column has to
# exist first or startup crashes with "Unknown column 'cameras.site_id'".
init_sites_tables()

# Cameras Setup — must run after init_db(), since the cameras table's
# FOREIGN KEY references the users table. Runs after init_sites_tables()
# so the `cameras.site_id` column exists before any Camera ORM query here.
init_cameras_table()

# Branding Setup — platform-wide Application Name/Logo (Super Admin
# System Settings), independent of any customer's own per-customer
# app_settings row.
init_branding_table()

# Website Settings Setup — public landing page content (Super Admin >
# System Settings > Website Settings). Reuses the same platform_settings
# table as Branding above; nothing to migrate, kept for startup symmetry.
init_website_content_table()

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

# Module-Based Pricing & Access — seeds the 4 purchasable packages
# (Cameras / People / Security & Detection / Reports) as "package:*"
# BillableItem rows + their sub-module composition, then migrates every
# existing Company Admin onto all 4 packages (frozen price 0, so their
# agreed amount is untouched) and drops the obsolete per-module catalog.
# Must run AFTER init_billing_tables() (shares the billable_items table).
init_module_packages_tables()

# Data Retention — Super Admin's per-Company-Admin auto-delete policy for
# captured/generated data (Admin & User Overview page). Brand-new table,
# no migration needed; init_retention_tables() exists only so this
# startup sequence reads the same as every other init_*_table() call
# site above. Must run after init_db(), same FOREIGN-KEY-references-
# users reasoning as everything above.
init_retention_tables()

# Multi-Object & Fire Detection — the `detection_events` table is created
# by init_db()'s create_all() above (brand-new table); this only ensures
# its composite indexes exist on a database that predates them and is the
# home for any future additive migration. Must run after init_db().
init_detection_events_table()

# Landing Page Interest & Lead popup — brand-new table, no migration
# needed; init_leads_table() exists only for startup-call symmetry with
# every other init_*_table() call site above. Must run after init_db().
init_leads_table()

# Super Admin "New Lead" push notifications (FCM) — brand-new table, no
# migration needed; init_fcm_tokens_table() exists only for startup-call
# symmetry with every other init_*_table() call site above. Must run
# after init_db(). Firebase itself is initialized lazily, on first actual
# send (see notifications/fcm.py) — nothing here touches Firebase.
init_fcm_tokens_table()

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

# --- Single-instance guard (AI Detection Engine) ---
# `start_all_enabled_cameras()` + `ai_prewarm.start_prewarm()` below open
# an RTSP connection per camera and load YOLO + the fire model +
# InsightFace — all at MODULE IMPORT time, before app.run() ever tries to
# bind the port. So a second `python -m api.app` started by mistake does
# ALL of that work (duplicate RTSP workers for the same camera, a second
# full set of model loads) and only fails much later, on the port bind —
# by which point it has already been fighting the real instance for CPU
# for minutes. On a 4-core box that alone is enough to stall InsightFace
# warmup long enough that the real instance never starts detecting.
# Confirmed live: two instances -> InsightFace warmup never completes ->
# stream works but zero detections/events.
#
# Fix: before starting ANY background service, probe the API port. If
# something is already listening there, another instance owns it — this
# process would be a useless second API server anyway, so exit now,
# before a single model or RTSP connection is touched. A lone TIME_WAIT
# socket never accepts a connection, so this only trips on a live
# listener. No effect on the normal single-instance case, and the
# Werkzeug reloader child (WERKZEUG_RUN_MAIN=true) probes before its own
# parent has bound anything, so dev mode is unaffected too.
_API_PORT = int(os.environ.get("PORT") or os.environ.get("API_PORT") or 5000)


def _another_instance_is_listening(port):
    import socket

    for host in ("127.0.0.1", "::1"):
        try:
            family = socket.AF_INET6 if ":" in host else socket.AF_INET
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.5)
                if probe.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            continue
    return False


if _should_start_background_services and _another_instance_is_listening(_API_PORT):
    print(
        f"[app.py] ANOTHER BACKEND INSTANCE is already running on port {_API_PORT}. "
        f"This process would only duplicate the camera workers and reload YOLO / "
        f"the fire model / InsightFace, starving CPU and blocking the running "
        f"instance's warmup. Exiting now — run exactly ONE backend."
    )
    sys.exit(1)

if _should_start_background_services:
    start_all_enabled_cameras()

    # AI model pre-warm — automatic, one-time, at boot, off the request
    # path. camera/detection_service.py's processor loop already calls the
    # same warmup() functions before it processes its first frame; the
    # problem is WHEN. With zero enabled RTSP cameras, the very first
    # thing that ever loads YOLO + InsightFace is the local-webcam debug
    # toggle — and InsightFace's first get_app() (buffalo_l download +
    # onnxruntime session build) can take minutes on a cold machine. For
    # that whole window the webcam's reader thread keeps publishing raw
    # frames (live view works) but the processor thread hasn't produced a
    # single annotated frame yet, so NO detection overlay is drawn.
    #
    # camera/ai_prewarm.py owns this now: it spawns exactly ONE daemon
    # thread (never blocks app.run() binding the port), exposes an
    # internal readiness state (AI_PREWARMING / AI_READY /
    # AI_PREWARM_FAILED), and — critically — lets each camera processor
    # thread WAIT for that shared warm-up instead of starting its own
    # concurrent cold load. Nothing about detection/recognition itself
    # changes: same models, same thresholds, same code path, only pulled
    # one step earlier and coordinated through one place.
    ai_prewarm.start_prewarm()

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

# Cookie `Domain` attribute — unset by default, which makes both the
# session cookie and the CSRF cookie (auth/csrf.py) host-only: scoped
# exactly to the hostname that set them. That's correct and sufficient
# whenever the frontend calls this API directly (the browser already
# attaches a host-only cookie to every request back to that same host,
# same-origin or not). It breaks down specifically for the CSRF cookie
# when the frontend and this API are deployed on different subdomains of
# the same parent domain (e.g. frontend on app.example.com, API on
# api.example.com): the frontend's JS reads the CSRF cookie via
# document.cookie to echo it back as a header (see main.jsx), and
# document.cookie can only ever see cookies whose Domain matches the
# PAGE's own host — never a different subdomain's host-only cookie, even
# though the browser happily sends that same cookie back to the API on
# XHR requests. The session cookie still works fine in that layout
# without this (it's HttpOnly, never read by JS, and is always sent
# straight to the API host it was issued for) — only the CSRF cookie
# actually needs the wider scope. Set this to the shared parent domain
# (e.g. ".example.com") only when frontend and API are split across
# subdomains like that; leave unset when they share one host.
_session_cookie_domain = os.environ.get("SESSION_COOKIE_DOMAIN", "").strip() or None

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=_session_cookie_secure,
    SESSION_COOKIE_DOMAIN=_session_cookie_domain,
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
# Phase 2 — production CORS: origins now come from CORS_ALLOWED_ORIGINS
# (comma-separated) instead of a hardcoded dev-only list, so a production
# deploy must explicitly configure its real frontend origin(s) rather than
# silently trusting whatever localhost ports Vite happened to pick.
_cors_env_origins = [o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()]

if "*" in _cors_env_origins:
    # Never valid together with supports_credentials=True — browsers
    # themselves refuse a wildcard Access-Control-Allow-Origin whenever
    # credentials are involved, and honoring it here would defeat the
    # whole point of scoping this to specific trusted origins.
    print(
        "[app.py] CRITICAL: CORS_ALLOWED_ORIGINS contains '*' -- rejected. "
        "List explicit origin(s) instead, e.g. https://app.example.com"
    )
    _cors_env_origins = [o for o in _cors_env_origins if o != "*"]

if _cors_env_origins:
    _cors_origins = _cors_env_origins
elif _flask_debug:
    # Unset in local dev: today's exact 4-origin fallback — zero behavior
    # change for anyone not using CORS_ALLOWED_ORIGINS yet. Vite picks the
    # next free port (5173, 5174, ...) when one is already in use, so
    # both are whitelisted.
    _cors_origins = [
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
    ]
else:
    # Unset in production (FLASK_DEBUG off): fail CLOSED, never wildcard.
    # Same-origin/server-to-server calls are unaffected; cross-origin
    # BROWSER calls are simply refused until this is configured.
    print(
        "[app.py] CRITICAL: CORS_ALLOWED_ORIGINS is not set in production "
        "(FLASK_DEBUG is off). No cross-origin browser request will be "
        "allowed until it's configured -- set CORS_ALLOWED_ORIGINS to your "
        "real frontend origin(s), e.g. https://app.example.com"
    )
    _cors_origins = []

CORS(app, supports_credentials=True, origins=_cors_origins)


def _validate_production_config():
    """Production configuration hardening (Phase 2, §14) — a single,
    loud, startup-time check. Only WARNS (never raises/crashes the
    process over a config problem) so a misconfigured but otherwise
    working deployment still starts and is fixable from its own logs,
    but nothing here silently proceeds without being flagged. No secret
    VALUE is ever printed, only whether one is present. No-ops entirely
    in local dev (FLASK_DEBUG on) — none of this is relevant there."""

    if _flask_debug:
        return

    warnings = []

    if not os.environ.get("DB_PASSWORD") and not os.environ.get("DATABASE_URL"):
        warnings.append("DB_PASSWORD (or DATABASE_URL) is not set — database connections will likely fail.")

    if not _cors_origins:
        # Already loudly warned above at the point of the actual decision;
        # repeated here so this single function is a complete "production
        # readiness" summary on its own.
        warnings.append("CORS_ALLOWED_ORIGINS is not configured — no cross-origin browser request is allowed.")

    if not _session_cookie_secure:
        warnings.append(
            "SESSION_COOKIE_SECURE is not set — if this app is served over HTTPS (it should be, in "
            "production), set SESSION_COOKIE_SECURE=true so the session/CSRF cookies are never sent "
            "over a plain http:// connection."
        )

    if not warnings:
        print("[app.py] Production config check: OK.")
        return

    print("=" * 70)
    print("[app.py] PRODUCTION CONFIGURATION WARNINGS:")
    for warning in warnings:
        print(f"  - {warning}")
    print("=" * 70)


_validate_production_config()

# Register Routes
app.register_blueprint(api)


# --- Phase 2: request ID, JSON body size cap, CSRF -----------------------

_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,64}$")

# A plain JSON POST/PUT/PATCH (login, settings, camera CRUD, ...) never
# legitimately needs anywhere near this much — MAX_CONTENT_LENGTH (100MB,
# set above) stays the real ceiling for the actual multipart file-upload
# routes (avatar/logo/registered-person images), which are a different
# content type and are therefore untouched by this check.
JSON_BODY_MAX_BYTES = 1 * 1024 * 1024

# Emergency ops kill switch ONLY — never used to special-case a single
# endpoint (every endpoint goes through the same check above). Defaults
# on; exists so a bad rollout interaction can be turned off from
# environment config alone, without a code deploy, while it's diagnosed.
_csrf_protection_enabled = os.environ.get("CSRF_PROTECTION_ENABLED", "true").strip().lower() not in (
    "0", "false", "no",
)


@app.before_request
def phase2_request_guards():
    """Runs, in order, for every request: (1) assign/validate a
    correlation id so it's available to every log line and error response
    for this request (see the error handler below and
    auth.database.log_security_event), (2) reject an oversized JSON body
    early, (3) validate the CSRF token on any authenticated,
    state-changing request. Each step returns its own response and stops
    here on failure; anything that passes all three reaches the normal
    view function unchanged."""

    # (1) Correlation / request ID (Phase 2, §12). A client-supplied
    # X-Request-ID is honored only if it matches a safe, bounded pattern
    # — otherwise (or if absent) a fresh one is generated. Never trust an
    # unbounded/free-form client value into a log line.
    incoming_id = request.headers.get("X-Request-ID", "")
    g.request_id = incoming_id if _REQUEST_ID_PATTERN.match(incoming_id) else uuid.uuid4().hex

    # (2) JSON body size cap (Phase 2, §9) — defense in depth alongside
    # MAX_CONTENT_LENGTH, scoped to non-upload JSON requests only.
    if (
        request.method in ("POST", "PUT", "PATCH")
        and request.content_type
        and request.content_type.startswith("application/json")
        and request.content_length
        and request.content_length > JSON_BODY_MAX_BYTES
    ):
        return jsonify({
            "success": False,
            "message": "Request body too large.",
            "request_id": g.request_id,
        }), 413

    # (3) CSRF (Phase 2, §6) — only state-changing methods, only once a
    # session actually exists (an unauthenticated request, including
    # /login itself, has nothing to forge yet). See auth/csrf.py for the
    # full design and the legacy-session grace case handled below.
    if _csrf_protection_enabled and request.method not in CSRF_SAFE_METHODS and session.get("user_id"):
        ok, needs_cookie_refresh, fresh_token = validate_csrf(session, request.headers)

        if not ok:
            log_security_event(
                "CSRF Validation Failed",
                user=get_user_by_id(session.get("user_id")),
                target_type="request",
                success=False,
                details=f"{request.method} {request.path}",
            )
            return jsonify({
                "success": False,
                "message": "Your session could not be verified. Please refresh the page and try again.",
                "request_id": g.request_id,
            }), 403

        if needs_cookie_refresh:
            g.csrf_token_to_set = fresh_token

    return None


@app.after_request
def apply_security_headers(response):
    """Security headers (Phase 2, §5) applied to every response. This API
    only ever returns JSON or a downloaded file — never HTML/inline
    scripts — so a strict `default-src 'none'` CSP is safe here (see
    api/app.py's module docstring / the Phase 2 report for the separate
    CSP the React SPA itself needs wherever it's actually served, since
    this Flask app never serves that HTML — verified: no static_folder /
    send_from_directory pointing at the frontend build anywhere in this
    codebase)."""

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"

    # HSTS only when HTTPS is already confirmed terminated in front of
    # this app (same _session_cookie_secure signal SESSION_COOKIE_SECURE
    # uses below) — sending it over plain local HTTP dev would tell the
    # browser to refuse http:// entirely for this host, which is correct
    # in production and wrong on a laptop.
    if _session_cookie_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    if getattr(g, "request_id", None):
        response.headers["X-Request-ID"] = g.request_id

    if getattr(g, "csrf_token_to_set", None):
        set_csrf_cookie(response, g.csrf_token_to_set)

    return response


@app.errorhandler(404)
def handle_not_found(_error):
    return jsonify({
        "success": False,
        "message": "Not found.",
        "request_id": getattr(g, "request_id", None),
    }), 404


@app.errorhandler(413)
def handle_too_large(_error):
    return jsonify({
        "success": False,
        "message": "Request too large.",
        "request_id": getattr(g, "request_id", None),
    }), 413


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    """Error response standardization (Phase 2, §11). Every OTHER error
    response in this codebase is an existing, hand-written
    `jsonify({"success": False, "message": ...}), 4xx` — those already
    carry a safe, specific message and are untouched by this handler,
    which only ever fires for something genuinely UNHANDLED. Full detail
    (with URL/password/RTSP credentials already sanitized — see
    error_logging.sanitize_sensitive_url) goes to the server log only;
    the client gets a generic message plus the request id to correlate
    against that log line, never a traceback/SQL error/filesystem path."""

    from werkzeug.exceptions import HTTPException

    if isinstance(error, HTTPException):
        # A route-level abort()/HTTPException with its own status code —
        # let Flask's normal handling return it as-is rather than
        # flattening every 4xx into this generic 500-shaped body.
        return error

    log_exception(error, context=f"{request.method} {request.path}")

    return jsonify({
        "success": False,
        "message": "An unexpected error occurred. Please try again.",
        "request_id": getattr(g, "request_id", None),
    }), 500


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