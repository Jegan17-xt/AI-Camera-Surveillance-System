"""Failed-login throttling for /login. In-memory, thread-safe (Flask's
dev server runs threaded=True, so multiple requests can hit this
concurrently) — no new dependency required (flask-limiter isn't in
requirements.txt, and this app is a single process, so a plain dict
behind a lock is sufficient without adding Redis/etc.).

Two independent counters, both keyed on a rolling time window:
  - (ip, email) pair — stops repeated password guessing against one
    account from one client.
  - ip alone, with a higher threshold — stops spraying many different
    emails from one client (username enumeration / credential stuffing)
    without that traffic ever tripping the narrower per-account counter.

A successful login clears both counters for that ip so a legitimate
user who mistyped their password a few times is never left locked out
after they get it right.
"""

import threading
import time

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

_lock = threading.Lock()
# key -> list[float] (timestamps of recent failures still inside the window)
_account_failures = {}
_ip_failures = {}
# key -> float (unix time the lockout ends)
_account_locked_until = {}
_ip_locked_until = {}


def _prune(timestamps, window_seconds, now):
    return [t for t in timestamps if now - t < window_seconds]


def _account_key(ip, email):
    return f"{ip}:{(email or '').strip().lower()}"


def is_login_blocked(ip, email):
    """Returns (blocked, retry_after_seconds). Call before attempting to
    authenticate a /login POST."""

    now = time.time()
    account_key = _account_key(ip, email)

    with _lock:
        account_until = _account_locked_until.get(account_key)
        if account_until and now < account_until:
            return True, int(account_until - now) + 1

        ip_until = _ip_locked_until.get(ip)
        if ip_until and now < ip_until:
            return True, int(ip_until - now) + 1

    return False, None


def record_failed_login(ip, email):
    """Call after authenticate() returns no user for a /login POST."""

    now = time.time()
    account_key = _account_key(ip, email)

    with _lock:
        account_hits = _prune(_account_failures.get(account_key, []), ACCOUNT_WINDOW_SECONDS, now)
        account_hits.append(now)
        _account_failures[account_key] = account_hits

        if len(account_hits) >= MAX_ATTEMPTS_PER_ACCOUNT:
            _account_locked_until[account_key] = now + ACCOUNT_LOCKOUT_SECONDS
            _account_failures[account_key] = []

        ip_hits = _prune(_ip_failures.get(ip, []), IP_WINDOW_SECONDS, now)
        ip_hits.append(now)
        _ip_failures[ip] = ip_hits

        if len(ip_hits) >= MAX_ATTEMPTS_PER_IP:
            _ip_locked_until[ip] = now + IP_LOCKOUT_SECONDS
            _ip_failures[ip] = []


def record_successful_login(ip, email):
    """Call after a /login POST authenticates successfully — clears this
    ip/account's failure history so a prior typo never lingers into a
    lockout after the user gets their password right."""

    account_key = _account_key(ip, email)

    with _lock:
        _account_failures.pop(account_key, None)
        _account_locked_until.pop(account_key, None)
        _ip_failures.pop(ip, None)
        _ip_locked_until.pop(ip, None)


# --- Camera test-connection throttling (security fix) -------------------
# The Camera Management "Test Connection" button is the endpoint's only
# legitimate caller, and no real workflow needs anywhere near this many
# attempts in a minute. Without a limit, the endpoint doubles as a free
# internal network scanner for anyone who can reach it — see
# api/cameras.py's validate_camera_destination for the other,
# independent layer (which destinations are even reachable at all).
# Same in-memory/per-process/thread-safe sliding-window design as the
# login limiter above (this is a single-process deployment today — see
# that module's own docstring); the {key: [timestamps]} shape below
# ports directly to a Redis INCR+EXPIRE-per-key scheme if this ever
# needs to survive multiple worker processes.
CAMERA_TEST_MAX_ATTEMPTS = 15
CAMERA_TEST_WINDOW_SECONDS = 60

_camera_test_lock = threading.Lock()
_camera_test_attempts = {}  # "{user_id}:{ip}" -> list[float]


def _camera_test_key(user_id, ip):
    return f"{user_id}:{ip}"


def is_camera_test_blocked(user_id, ip):
    """Returns (blocked, retry_after_seconds). Call before actually
    attempting a camera connection test."""

    now = time.time()
    key = _camera_test_key(user_id, ip)

    with _camera_test_lock:
        hits = _prune(_camera_test_attempts.get(key, []), CAMERA_TEST_WINDOW_SECONDS, now)
        _camera_test_attempts[key] = hits

        if len(hits) >= CAMERA_TEST_MAX_ATTEMPTS:
            return True, int(hits[0] + CAMERA_TEST_WINDOW_SECONDS - now) + 1

    return False, None


def record_camera_test_attempt(user_id, ip):
    """Call once per actual test-connection attempt (whether it
    ultimately succeeds or fails) — unlike the login limiter, every
    attempt counts here, not just failures, since the point is capping
    outbound-probe volume, not punishing wrong credentials."""

    now = time.time()
    key = _camera_test_key(user_id, ip)

    with _camera_test_lock:
        hits = _prune(_camera_test_attempts.get(key, []), CAMERA_TEST_WINDOW_SECONDS, now)
        hits.append(now)
        _camera_test_attempts[key] = hits
