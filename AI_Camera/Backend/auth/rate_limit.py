"""Rate limiting for /login, camera test-connection, and (Phase 2) a
handful of other sensitive/expensive endpoints. Backed by
auth.rate_limit_store's pluggable store (in-memory by default, Redis if
REDIS_URL is set) — see that module's docstring for why a bare in-memory
dict alone stops being correct behind more than one worker process.

Two independent counters for /login, both keyed on a rolling time window:
  - (ip, email) pair — stops repeated password guessing against one
    account from one client.
  - ip alone, with a higher threshold — stops spraying many different
    emails from one client (username enumeration / credential stuffing)
    without that traffic ever tripping the narrower per-account counter.

A successful login clears both counters for that ip so a legitimate
user who mistyped their password a few times is never left locked out
after they get it right.
"""

from functools import wraps

from flask import jsonify, request, session

from auth.rate_limit_store import store

# Per (ip, email): how many failed attempts before that pair is
# blocked, and for how long. 5 tries is generous enough that a
# legitimate user fumbling their password isn't punished, while still
# making online guessing impractical.
MAX_ATTEMPTS_PER_ACCOUNT = 5
ACCOUNT_WINDOW_SECONDS = 15 * 60
ACCOUNT_LOCKOUT_SECONDS = 15 * 60

# Per ip, across any emails: a much higher ceiling — only meant to catch
# a single client hammering many different accounts, not to interfere
# with normal shared-IP traffic (offices/NAT).
MAX_ATTEMPTS_PER_IP = 20
IP_WINDOW_SECONDS = 15 * 60
IP_LOCKOUT_SECONDS = 15 * 60


def _account_key(ip, email):
    return f"login:acct:{ip}:{(email or '').strip().lower()}"


def _ip_key(ip):
    return f"login:ip:{ip}"


def is_login_blocked(ip, email):
    """Returns (blocked, retry_after_seconds). Call before attempting to
    authenticate a /login POST."""

    account_remaining = store.get_lock_remaining(_account_key(ip, email))
    if account_remaining is not None:
        return True, int(account_remaining) + 1

    ip_remaining = store.get_lock_remaining(_ip_key(ip))
    if ip_remaining is not None:
        return True, int(ip_remaining) + 1

    return False, None


def record_failed_login(ip, email):
    """Call after authenticate() returns no user for a /login POST."""

    account_key = _account_key(ip, email)
    account_hits = store.increment(account_key, ACCOUNT_WINDOW_SECONDS)

    if account_hits >= MAX_ATTEMPTS_PER_ACCOUNT:
        store.set_lock(account_key, ACCOUNT_LOCKOUT_SECONDS)
        store.reset_hits(account_key)

    ip_key = _ip_key(ip)
    ip_hits = store.increment(ip_key, IP_WINDOW_SECONDS)

    if ip_hits >= MAX_ATTEMPTS_PER_IP:
        store.set_lock(ip_key, IP_LOCKOUT_SECONDS)
        store.reset_hits(ip_key)


def record_successful_login(ip, email):
    """Call after a /login POST authenticates successfully — clears this
    ip/account's failure history so a prior typo never lingers into a
    lockout after the user gets their password right."""

    store.reset(_account_key(ip, email))
    store.reset(_ip_key(ip))


# --- Camera test-connection throttling (security fix) -------------------
# The Camera Management "Test Connection" button is the endpoint's only
# legitimate caller, and no real workflow needs anywhere near this many
# attempts in a minute. Without a limit, the endpoint doubles as a free
# internal network scanner for anyone who can reach it — see
# api/cameras.py's validate_camera_destination for the other,
# independent layer (which destinations are even reachable at all).
CAMERA_TEST_MAX_ATTEMPTS = 15
CAMERA_TEST_WINDOW_SECONDS = 60


def _camera_test_key(user_id, ip):
    return f"cameratest:{user_id}:{ip}"


def is_camera_test_blocked(user_id, ip):
    """Returns (blocked, retry_after_seconds). Call before actually
    attempting a camera connection test."""

    key = _camera_test_key(user_id, ip)
    hits = store.count(key, CAMERA_TEST_WINDOW_SECONDS)

    if hits >= CAMERA_TEST_MAX_ATTEMPTS:
        return True, CAMERA_TEST_WINDOW_SECONDS

    return False, None


def record_camera_test_attempt(user_id, ip):
    """Call once per actual test-connection attempt (whether it
    ultimately succeeds or fails) — unlike the login limiter, every
    attempt counts here, not just failures, since the point is capping
    outbound-probe volume, not punishing wrong credentials."""

    store.increment(_camera_test_key(user_id, ip), CAMERA_TEST_WINDOW_SECONDS)


# --- Generic declarative rate limiting (Phase 2) -------------------------
# For any other sensitive/expensive endpoint (password change/reset,
# camera create/update, notification-settings updates, report triggers)
# that doesn't need the login limiter's two-tier account/IP design or the
# camera-test limiter's "every attempt counts" design — just a plain
# per-(user or IP) sliding-window cap declared at the route.


def rate_limited(bucket, max_attempts, window_seconds, per="user_ip"):
    """Decorator for a Flask view. `per` controls the key:
      - "user_ip": current session user id (or "anon") + client IP —
        the default; scopes the limit to one signed-in caller.
      - "ip": client IP alone — for routes reachable before/without a
        session.
    Returns 429 with a safe, generic message once max_attempts is hit
    inside window_seconds. Must be applied UNDER @login_required (i.e.
    listed after it) wherever the route also uses that decorator, so
    `session` is already populated when this runs.
    """

    def decorator(view_func):

        @wraps(view_func)
        def wrapper(*args, **kwargs):

            client_ip = request.remote_addr or "unknown"

            if per == "ip":
                key = f"{bucket}:{client_ip}"
            else:
                user_id = session.get("user_id", "anon")
                key = f"{bucket}:{user_id}:{client_ip}"

            hits = store.increment(key, window_seconds)

            if hits > max_attempts:
                return jsonify({
                    "success": False,
                    "message": "Too many requests. Please slow down and try again shortly.",
                }), 429

            return view_func(*args, **kwargs)

        return wrapper

    return decorator
