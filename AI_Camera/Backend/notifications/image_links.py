"""Short-lived, signed public URLs for outbound WhatsApp media.

wa.mydreamstechnology.in's sendtemplate.php ImageUrl param (confirmed by
three supervised live test sends against the real API — see
notifications/providers/whatsapp.py's module docstring) has to be
fetched by their servers over the open internet, anonymously — they
can't hold a login session, so the existing GET /unknown/<filename>
route (session-gated, see api/unknown.py) can't be reused as-is.

This module is the one place that turns "this customer's locally saved
unknown-face image" into a URL safe to hand to an outside party: HMAC-
signed with the app's own persisted Flask secret key (auth.database's
get_or_create_secret_key — already stable across restarts, nothing new
to provision) and time-boxed, so a leaked/logged link can't be replayed
forever and a filename can't be guessed into a working one.
"""

import hashlib
import hmac
import os
import time

from auth.database import get_or_create_secret_key

# Long enough for the vendor's servers to fetch the image right after
# our send_template() call returns; short enough that a link sitting in
# an old WhatsApp message or a server log isn't a standing exposure.
_LINK_TTL_SECONDS = 15 * 60


def _signing_key():
    return get_or_create_secret_key().encode("utf-8")


def _sign(customer_id, filename, expires_at):

    message = f"{customer_id}:{filename}:{expires_at}".encode("utf-8")
    return hmac.new(_signing_key(), message, hashlib.sha256).hexdigest()


def build_public_image_url(customer_id, filename):
    """None in, None out — callers (WhatsAppProvider) already treat "no
    image URL" the same as "send text only", so this never needs its
    own not-configured branch. PUBLIC_BASE_URL must point at a host
    reachable from the open internet (an ngrok/cloudflared tunnel in
    dev, the real domain in production) — it falls back to localhost,
    which is correct for local browser testing but NOT fetchable by
    the WhatsApp API provider; see .env's PUBLIC_BASE_URL comment.

    expires/sig are embedded as PATH segments, not a query string —
    confirmed live (two supervised sendtemplate.php test sends, one
    against a URL that already worked query-string-free, one against
    that same URL with a fake `?expires=...&sig=...` appended) that any
    `?...` on ImageUrl makes the image silently fail to attach, even
    though a direct fetch of that exact URL works fine outside their
    pipeline. A path-only URL sidesteps whatever they do to it."""

    if not customer_id or not filename:
        return None

    base = (os.environ.get("PUBLIC_BASE_URL") or "http://localhost:5000").rstrip("/")
    expires_at = int(time.time()) + _LINK_TTL_SECONDS
    sig = _sign(customer_id, filename, expires_at)

    return f"{base}/public/unknown-image/{customer_id}/{expires_at}/{sig}/{filename}"


def verify_public_image_link(customer_id, filename, expires_at, sig):
    """Constant-time compare (hmac.compare_digest) — this gates a route
    with no session/auth of any kind, so a timing side-channel on the
    signature check would matter here in a way it wouldn't behind a
    login wall."""

    try:
        expires_at = int(expires_at)
    except (TypeError, ValueError):
        return False

    if time.time() > expires_at:
        return False

    expected = _sign(customer_id, filename, expires_at)

    return hmac.compare_digest(expected, sig or "")


def build_public_document_url(customer_id, filename):
    """Same signed-link mechanism as build_public_image_url above, for
    a generated Daily Report PDF instead of an unknown-face image — the
    signing scheme (customer_id + filename + expiry, HMAC'd with the
    app's own secret key) isn't file-type-specific, so this only differs
    in the URL prefix (routed to report_folder(customer_id) instead of
    unknown_folder(customer_id) — see api/routes.py's
    public_daily_report_document). Kept as its own function rather than
    a shared "kind" parameter so the two media types' routes stay
    independently swappable. None in, None out — see
    build_public_image_url's docstring for why callers never need their
    own not-configured branch for this."""

    if not customer_id or not filename:
        return None

    base = (os.environ.get("PUBLIC_BASE_URL") or "http://localhost:5000").rstrip("/")
    expires_at = int(time.time()) + _LINK_TTL_SECONDS
    sig = _sign(customer_id, filename, expires_at)

    return f"{base}/public/daily-report/{customer_id}/{expires_at}/{sig}/{filename}"


def verify_public_document_link(customer_id, filename, expires_at, sig):
    """Identical check to verify_public_image_link — the signature
    scheme isn't file-type-specific; this is its own named function only
    so the /public/daily-report route's intent stays self-explanatory at
    the call site."""

    return verify_public_image_link(customer_id, filename, expires_at, sig)


def build_public_event_image_url(customer_id, relpath):
    """Same signed-link mechanism as build_public_image_url above, for
    an AI Detection Alert (fire/smoke/vehicle/animal/bird) snapshot
    instead of an unknown-face image. Different from both
    build_public_image_url and build_public_document_url in one way:
    `relpath` here is events/manager.py's DetectionEvent.image_path
    shape — a SUBFOLDER-relative path ("<DD-MM-YYYY>/<type>_<HH-MM-SS>.
    jpg"), not a bare filename — served from
    api.detection_events.detection_events_folder(customer_id) instead of
    unknown_folder(customer_id). The signing scheme itself isn't
    filename-shaped either way (see _sign), so this needs no changes
    there. None in, None out — see build_public_image_url's docstring
    for why callers never need their own not-configured branch for
    this."""

    if not customer_id or not relpath:
        return None

    base = (os.environ.get("PUBLIC_BASE_URL") or "http://localhost:5000").rstrip("/")
    expires_at = int(time.time()) + _LINK_TTL_SECONDS
    sig = _sign(customer_id, relpath, expires_at)

    return f"{base}/public/event-image/{customer_id}/{expires_at}/{sig}/{relpath}"


def verify_public_event_image_link(customer_id, relpath, expires_at, sig):
    """Identical check to verify_public_image_link — the signature
    scheme isn't file-type-specific; this is its own named function only
    so the /public/event-image route's intent stays self-explanatory at
    the call site."""

    return verify_public_image_link(customer_id, relpath, expires_at, sig)
