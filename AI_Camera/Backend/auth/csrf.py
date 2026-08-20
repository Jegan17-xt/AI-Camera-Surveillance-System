"""CSRF protection (Phase 2) for the cookie/session-authenticated API.

Double-submit-cookie pattern, chosen for this codebase specifically
because the React frontend calls this API directly from ~40 files with
axios, with no shared axios instance/wrapper except one global default in
main.jsx — a token mechanism requiring per-request server state (e.g. a
server-rendered hidden form field) has no natural home here, but a global
axios request interceptor reading a plain cookie does (see main.jsx).

How it works:
  - On login, a random token is minted and stored BOTH in the signed
    session (session["csrf_token"] — the source of truth) and in a
    separate, JS-readable cookie (`csrf_token` — NOT HttpOnly, unlike the
    session cookie itself).
  - Every state-changing request (POST/PUT/PATCH/DELETE) from an
    authenticated session must echo that value back in an `X-CSRF-Token`
    header. A cross-site attacker page can trigger a cross-origin
    request that carries the SESSION cookie automatically (that's the
    entire CSRF problem) but cannot read the csrf_token cookie's value
    (browsers never allow cross-origin JS to read another origin's
    cookies) and so cannot ever produce a matching header.
  - GET/HEAD/OPTIONS and any request with no active session are exempt —
    there's nothing to forge yet.

This is defense-in-depth on top of SESSION_COOKIE_SAMESITE="Lax" (see
api/app.py), which already blocks a plain cross-site form POST from
carrying the session cookie at all — but SameSite alone stops protecting
once frontend and backend ever end up on different registrable domains in
production (SameSite is scoped to "site", not origin), which this app's
architecture doesn't rule out.
"""

import secrets

from flask import current_app

SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
COOKIE_NAME = "csrf_token"
HEADER_NAME = "X-CSRF-Token"


def set_csrf_cookie(response, token):
    """Same SameSite/Secure posture as the session cookie itself (see
    api/app.py's SESSION_COOKIE_* config) — EXCEPT httponly, which must
    stay False here: the whole point is that frontend JS reads this
    value and echoes it back as a header (see main.jsx's axios
    interceptor). A cross-origin attacker page still can't read it
    (cookies are never readable cross-origin), so this doesn't weaken
    anything — it's the mechanism, not a leak."""

    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=False,
        samesite="Lax",
        secure=current_app.config.get("SESSION_COOKIE_SECURE", False),
        max_age=current_app.config.get("PERMANENT_SESSION_LIFETIME").total_seconds(),
    )


def clear_csrf_cookie(response):
    response.delete_cookie(COOKIE_NAME)


def issue_csrf_token():
    """A fresh, unguessable token — call once per login and store the
    result in session["csrf_token"]."""

    return secrets.token_urlsafe(32)


def validate_csrf(session, headers):
    """Returns (ok, needs_cookie_refresh, token). `ok` is False only when
    a real mismatch/forgery attempt is detected. `needs_cookie_refresh`
    is True in the one legitimate grace case: a session that predates
    this feature (no "csrf_token" key yet) — the caller mints and stores
    a token, lets this single request through, and the response carries
    the new cookie so every subsequent request from that same browser
    validates normally. This never applies to a BRAND NEW login (login()
    always sets session["csrf_token"] itself), only to a session cookie
    that was already sitting in someone's browser before this feature
    shipped."""

    session_token = session.get("csrf_token")

    if session_token is None:
        new_token = issue_csrf_token()
        session["csrf_token"] = new_token
        return True, True, new_token

    header_token = headers.get(HEADER_NAME, "")

    if not header_token or not secrets.compare_digest(header_token, session_token):
        return False, False, None

    return True, False, None
