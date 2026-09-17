import base64
import ipaddress
import os
import re
import socket
import threading
from datetime import datetime
from urllib.parse import urlsplit

# Security fix: suppress FFmpeg's own native (C-level) logging before
# cv2 is imported below — without this, a failing RTSP handshake can
# print the FULL connection string, credentials included, straight to
# this process's stderr/console log, completely bypassing every
# Python-level sanitization in error_logging.sanitize_sensitive_url
# (which can only ever see what THIS code explicitly prints). -8 is
# FFmpeg's AV_LOG_QUIET.
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")

import cv2
import requests
from requests.auth import HTTPDigestAuth
from sqlalchemy import select, func, text

from db import get_session, engine
from auth.models import Camera, Site, to_dict
from api.camera_crypto import encrypt_password, decrypt_password
from api.validators import (
    validate_text_field,
    validate_password,
)
from api.scope import apply_owner_scope
from auth.database import get_users_by_parent
from api.camera_quota import validate_camera_creation_quota, validate_camera_reassignment_quota
from camera import detection_service
from error_logging import log_exception, sanitize_sensitive_url

# Sentinel distinct from None — None is a legitimate "unassign this
# camera" value for owner_user_id, so update_camera needs to tell
# "caller passed nothing, don't touch it" apart from "caller explicitly
# wants it cleared."
_UNSET = object()


def _validate_owner_user_id(customer_id, owner_user_id):
    """None (unassigned) is always fine. A real id must belong to one of
    THIS company's own Users — never trusted blind, never lets one
    company's camera be assigned to another company's User."""

    if owner_user_id is None:
        return None

    company_user_ids = {u["id"] for u in get_users_by_parent(customer_id)}

    if owner_user_id not in company_user_ids:
        return "Selected user does not belong to this company."

    return None


def _validate_site_id(customer_id, site_id):
    """Site / VPN Gateway Management: None (no Site) is always fine. A
    real id must belong to THIS company's own Sites — never trusted
    blind, never lets one company's camera be associated with another
    company's Site. Queried directly against the Site model (not via
    api/sites.py) to avoid a circular import — api/sites.py itself
    imports from this module."""

    if site_id is None:
        return None

    with get_session() as session:
        exists = session.scalar(
            select(Site.site_id).where(Site.site_id == site_id, Site.customer_id == customer_id)
        )

    if exists is None:
        return "Selected site does not belong to this company."

    return None

DEFAULT_STATUS = "Offline"
DEFAULT_PORT = 554

CAMERA_NAME_MIN = 3
CAMERA_NAME_MAX = 50
USERNAME_MAX = 50
LOCATION_MAX = 100
CUSTOM_RTSP_MAX = 500
CAMERA_PASSWORD_MAX = 128

CONNECTION_TEST_TIMEOUT_SECONDS = 8
SOCKET_PRECHECK_TIMEOUT_SECONDS = 4

# Security fix: the client-facing test-connection message is always one
# of exactly these two strings — never the raw internal `reason` (which
# can include socket errors, hostnames/IPs, or raw FFmpeg/OpenCV
# exception text). The detailed reason still exists server-side, for
# logs only (see api/routes.py's test-connection handlers).
CONNECTION_SUCCESS_MESSAGE = "Camera Connected"
CONNECTION_FAILURE_MESSAGE = (
    "Camera connection failed. Check the camera's IP address, port, brand, "
    "username, and password, then try again."
)

# Every brand this dropdown offers, and the per-channel RTSP path
# convention its DVR/NVR line typically ships with. These are
# commonly-seen defaults, not a guarantee for every model/firmware —
# that's exactly why "Test Camera" exists (to verify before saving) and
# why "custom" is offered as a full manual override.
CAMERA_BRANDS = [
    ("hikvision", "Hikvision"),
    ("dahua", "Dahua"),
    ("cp_plus", "CP Plus"),
    ("uniview", "Uniview"),
    ("axis", "Axis"),
    ("tplink_vigi", "TP-Link VIGI"),
    ("onvif_generic", "ONVIF / Generic"),
    ("custom", "Custom RTSP"),
]

BRAND_KEYS = {key for key, _ in CAMERA_BRANDS}

# CP Plus DVR/NVR firmware is Dahua-OEM, hence the identical path.
# These remain the "1080p"/legacy templates — always the main/full-
# resolution endpoint — unchanged from before Per-Camera Quality
# Selection existed, so any brand not listed in
# BRAND_QUALITY_RTSP_TEMPLATES below (Axis, TP-Link VIGI, ONVIF Generic —
# no widely-documented main/sub URL convention we can rely on the way
# Hikvision/Dahua/CP Plus/Uniview have) keeps generating exactly the same
# URL for every quality selection, same as before this feature.
BRAND_RTSP_TEMPLATES = {
    "hikvision": "rtsp://{username}:{password}@{ip}:{port}/Streaming/Channels/{channel}01",
    "dahua": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0",
    "cp_plus": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0",
    "uniview": "rtsp://{username}:{password}@{ip}:{port}/unicast/c{channel}/s0/live",
    "axis": "rtsp://{username}:{password}@{ip}:{port}/axis-media/media.amp?camera={channel}",
    "tplink_vigi": "rtsp://{username}:{password}@{ip}:{port}/stream{channel}",
    "onvif_generic": "rtsp://{username}:{password}@{ip}:{port}/onvif/profile{channel}",
}

# Per-Camera Quality Selection: which UI-facing quality tiers this
# dropdown offers, and the per-brand RTSP endpoint each one maps to — for
# the brands below, confirmed live against a real camera (Hikvision) and
# well-documented OEM conventions (Dahua/CP Plus share Dahua's firmware;
# Uniview's unicast path is equally standard). "480p" is that brand's
# genuine, always-lower-resolution SUBSTREAM endpoint. "720p" and "1080p"
# both point at the same MAINSTREAM endpoint — these camera lines only
# expose two distinct RTSP endpoints (main/sub), not three, so choosing
# between 720p and 1080p can't be done by URL alone. For Hikvision
# specifically, add_camera/update_camera additionally issue a real
# camera-side ISAPI request to set that channel's own recording
# resolution to match (see _apply_hikvision_stream_quality below) — the
# same technique confirmed live this session. Other brands' 720p/1080p
# both use the mainstream endpoint as-is; whatever resolution the camera
# itself is already configured to output there is what's received (no
# automatic camera-side reconfiguration attempted for them — unverified
# ISAPI-equivalent).
STREAM_QUALITIES = ["480p", "720p", "1080p"]
DEFAULT_STREAM_QUALITY = "1080p"

BRAND_QUALITY_RTSP_TEMPLATES = {
    "hikvision": {
        "480p": "rtsp://{username}:{password}@{ip}:{port}/Streaming/Channels/{channel}02",
        "720p": "rtsp://{username}:{password}@{ip}:{port}/Streaming/Channels/{channel}01",
        "1080p": "rtsp://{username}:{password}@{ip}:{port}/Streaming/Channels/{channel}01",
    },
    "dahua": {
        "480p": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=1",
        "720p": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0",
        "1080p": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0",
    },
    "cp_plus": {
        "480p": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=1",
        "720p": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0",
        "1080p": "rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0",
    },
    "uniview": {
        "480p": "rtsp://{username}:{password}@{ip}:{port}/unicast/c{channel}/s1/live",
        "720p": "rtsp://{username}:{password}@{ip}:{port}/unicast/c{channel}/s0/live",
        "1080p": "rtsp://{username}:{password}@{ip}:{port}/unicast/c{channel}/s0/live",
    },
}

# Hikvision channel-101-equivalent resolution to request via ISAPI for
# each quality tier that reuses the mainstream endpoint. "480p" doesn't
# appear here — it uses the substream endpoint above instead, which is
# fixed by the camera and never reconfigured.
HIKVISION_ISAPI_RESOLUTION = {
    "720p": (1280, 720),
    "1080p": (1920, 1080),
}


def init_cameras_table():
    """Every camera belongs to exactly one customer (a User-role account
    in `users`) — ON DELETE CASCADE means deleting a customer also
    removes their cameras. There is no such thing as an orphaned or
    "global" camera. Must run after auth.database.init_db(), since the
    FOREIGN KEY references the users table.

    Table creation itself is handled by Base.metadata.create_all() in
    auth.database.init_db() (all models share the one Base/engine) —
    this only does the brand/port backfill the old SQLite version did,
    which is still meaningful data cleanup, not schema setup.

    detection_enabled was added to this table after it already existed
    in deployed databases — create_all() only creates missing TABLES, it
    never adds columns to one that's already there, so a live database
    from before this change needs it backfilled explicitly. Checked
    against information_schema first (rather than a blind ALTER) so this
    stays safe to run on every startup."""

    with engine.connect() as conn:
        existing_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cameras'"
                )
            )
        }

        if "detection_enabled" not in existing_columns:
            conn.execute(text("ALTER TABLE cameras ADD COLUMN detection_enabled INTEGER NOT NULL DEFAULT 1"))
            conn.commit()

        # Per-User Data Isolation — same "existing deployed DB predates
        # this column" situation as detection_enabled above. NULL-able,
        # no DEFAULT needed: every existing row simply becomes
        # "Unassigned" (visible only to the Company Admin) until they
        # explicitly assign it to a User via Camera Management.
        if "owner_user_id" not in existing_columns:
            conn.execute(text("ALTER TABLE cameras ADD COLUMN owner_user_id INTEGER NULL"))
            conn.execute(text("ALTER TABLE cameras ADD INDEX idx_cameras_owner_user_id (owner_user_id)"))
            conn.execute(text(
                "ALTER TABLE cameras ADD CONSTRAINT fk_cameras_owner_user_id "
                "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL"
            ))
            conn.commit()

        # Per-Camera Quality Selection — same "existing deployed DB
        # predates this column" situation as detection_enabled/
        # owner_user_id above. DEFAULT '1080p' both for new rows and to
        # backfill every existing row (MySQL applies a column's DEFAULT
        # to already-existing rows on ADD COLUMN) — '1080p' always maps
        # to the main/full-resolution stream (see build_rtsp_url), i.e.
        # every camera added before this feature keeps its exact prior
        # behavior with zero manual backfill needed.
        if "stream_quality" not in existing_columns:
            conn.execute(text("ALTER TABLE cameras ADD COLUMN stream_quality VARCHAR(10) NOT NULL DEFAULT '1080p'"))
            conn.commit()

        # Security fix — see Camera.rtsp_url's docstring in auth/models.py.
        if "custom_rtsp_url_encrypted" not in existing_columns:
            conn.execute(text("ALTER TABLE cameras ADD COLUMN custom_rtsp_url_encrypted TEXT NULL"))
            conn.commit()

    with get_session() as session:
        session.query(Camera).filter(Camera.brand.is_(None)).update({"brand": "hikvision"})
        session.query(Camera).filter(Camera.port.is_(None)).update({"port": DEFAULT_PORT})

        # Security fix, one-time (per row) data migration: every camera
        # saved before this fix has its full credential-bearing
        # connection URL sitting in plaintext in rtsp_url, right next to
        # the properly Fernet-encrypted password_encrypted — defeating
        # that column's own encryption for anyone with DB/backup read
        # access. For a Custom RTSP camera, that URL is the ONLY copy of
        # its connection secret (there's no separate username/password
        # to fall back on), so it is extracted and Fernet-encrypted into
        # custom_rtsp_url_encrypted FIRST — never destroyed — before
        # rtsp_url is overwritten with a sanitized, credential-free
        # display value. Every other brand's connection is already
        # fully reconstructable from its own separate columns (camera_
        # ip/username/password_encrypted/port/channel_number/brand/
        # stream_quality), so nothing else needs to be preserved.
        #
        # Idempotent and safe to run on every startup: the LIKE filter
        # only ever matches a row whose rtsp_url still contains a
        # "://...@" userinfo segment that ISN'T already the sanitized
        # "***:***@" placeholder — a row already migrated (or a
        # brand-new one, which is written pre-sanitized by add_camera)
        # never matches again, instead of being re-selected (harmlessly,
        # but pointlessly) on every single startup forever.
        rows_needing_migration = session.scalars(
            select(Camera).where(
                Camera.rtsp_url.like("%://%@%"),
                Camera.rtsp_url.notlike("%://***:***@%"),
            )
        ).all()

        for row in rows_needing_migration:
            if row.brand == "custom" and not row.custom_rtsp_url_encrypted:
                row.custom_rtsp_url_encrypted = encrypt_password(row.rtsp_url)
            row.rtsp_url = sanitize_sensitive_url(row.rtsp_url)

        if rows_needing_migration:
            print(f"[CAMERA] Security migration: sanitized {len(rows_needing_migration)} existing camera row(s)' stored rtsp_url.")


# ==========================================
# RTSP Generation
# ==========================================
def build_rtsp_url(brand, camera_ip, username, password, port, channel_number, custom_rtsp_url=None, stream_quality=DEFAULT_STREAM_QUALITY):
    """Brand-aware RTSP URL. "custom" returns `custom_rtsp_url` exactly
    as given (the one case a Super Admin types the URL directly);
    every other brand is generated from BRAND_RTSP_TEMPLATES, or from
    BRAND_QUALITY_RTSP_TEMPLATES[brand][stream_quality] for the brands
    with a confirmed per-quality URL convention (see that dict's own
    comment for exactly which brands and why).

    Deliberately NOT URL-encoding username/password for the generated
    brands — this mirrors how these DVRs' own documentation and most
    NVR software hand out RTSP URLs verbatim, including a literal '@'
    inside a password. OpenCV/ffmpeg parse the credentials by splitting
    on the LAST '@' before the host, so this still resolves correctly."""

    if brand == "custom":
        return (custom_rtsp_url or "").strip()

    quality_templates = BRAND_QUALITY_RTSP_TEMPLATES.get(brand)
    template = quality_templates.get(stream_quality) if quality_templates else BRAND_RTSP_TEMPLATES.get(brand)

    if template is None:
        raise ValueError(f"Unsupported camera brand: {brand}")

    return template.format(
        username=username,
        password=password,
        ip=camera_ip,
        port=int(port),
        channel=int(channel_number),
    )


def validate_stream_quality(stream_quality):

    if stream_quality not in STREAM_QUALITIES:
        return f"Camera Quality must be one of: {', '.join(STREAM_QUALITIES)}."

    return None


ISAPI_TIMEOUT_SECONDS = 8


def _apply_hikvision_stream_quality(camera_ip, username, password, channel_number, stream_quality):
    """Best-effort, camera-side companion to the URL selection above:
    for "720p"/"1080p" on a Hikvision camera, the RTSP URL alone can't
    distinguish them (both point at the same mainstream endpoint — see
    BRAND_QUALITY_RTSP_TEMPLATES) since these camera lines only expose
    two distinct RTSP endpoints, not three. This calls the camera's own
    ISAPI management API (plain HTTP, port 80, digest auth — the same
    protocol/credentials/technique confirmed live against a real camera
    this session) to set that channel's OWN recording resolution to
    match, so the two labels actually produce visibly different streams.

    Deliberately never raises: a camera unreachable on port 80, ISAPI
    disabled, or any other failure here must NEVER block saving the
    camera or fail add_camera/update_camera — the RTSP URL/stream_quality
    are already correctly saved regardless of whether this extra,
    best-effort step succeeds. Only "480p" (the substream, fixed by the
    camera) and non-Hikvision brands skip this entirely — this function
    is only ever called for brand == "hikvision" and a quality present in
    HIKVISION_ISAPI_RESOLUTION.

    SSRF protection: camera_ip is re-validated here, immediately before
    the actual HTTP call, via the same central gate every other outbound
    camera connection goes through (see validate_camera_destination) —
    not just relying on whatever check ran when the camera was saved.
    Redirects are disabled on both requests: this call already resolved
    and approved `camera_ip` as the destination, so a 3xx response
    (whether from a misbehaving camera or a compromised one) must never
    be allowed to silently redirect this backend's own credentials
    (HTTPDigestAuth) somewhere else entirely."""

    if not _connection_target_allowed(camera_ip):
        print(f"[CAMERA] Hikvision ISAPI skipped — destination not allowed (camera={camera_ip})")
        return

    width, height = HIKVISION_ISAPI_RESOLUTION[stream_quality]
    channel_id = f"{int(channel_number)}01"
    url = f"http://{camera_ip}/ISAPI/Streaming/channels/{channel_id}"
    auth = HTTPDigestAuth(username, password)

    try:
        get_resp = requests.get(url, auth=auth, timeout=ISAPI_TIMEOUT_SECONDS, allow_redirects=False)
        get_resp.raise_for_status()

        new_xml = re.sub(
            r"<videoResolutionWidth>\d+</videoResolutionWidth>",
            f"<videoResolutionWidth>{width}</videoResolutionWidth>",
            get_resp.text,
        )
        new_xml = re.sub(
            r"<videoResolutionHeight>\d+</videoResolutionHeight>",
            f"<videoResolutionHeight>{height}</videoResolutionHeight>",
            new_xml,
        )

        put_resp = requests.put(
            url, auth=auth, data=new_xml.encode("utf-8"),
            headers={"Content-Type": "application/xml"}, timeout=ISAPI_TIMEOUT_SECONDS,
            allow_redirects=False,
        )
        put_resp.raise_for_status()
        print(f"[CAMERA] Hikvision ISAPI: channel {channel_id} on {camera_ip} set to {width}x{height} ({stream_quality})")
    except Exception as e:
        log_exception(e, f"Hikvision ISAPI resolution set (camera={camera_ip}, channel={channel_id}, quality={stream_quality})")


# ==========================================
# SSRF Protection
# ==========================================
# The single gate every outbound camera connection this backend makes —
# an RTSP connect (test_camera_connection, the AI Detection Engine's own
# worker) or a Hikvision ISAPI HTTP call (_apply_hikvision_stream_
# quality) — must pass through immediately before the actual network
# call. Private network ranges are ALWAYS allowed: real cameras sit on
# exactly this kind of network (192.168.x.x, 10.x.x.x, 172.16-31.x.x),
# typically reached over a VPN/site-to-site link, and must stay
# reachable. Only loopback, link-local (which includes the
# 169.254.169.254 cloud metadata endpoint), multicast, unspecified, and
# other IETF-reserved destinations are rejected.
class CameraDestinationBlocked(Exception):
    """Internal signal only — a resolved camera destination must never
    be reached. Callers that want a user-facing message should call
    validate_camera_destination() instead, which catches this and
    returns a plain string."""


_EXTRA_FORBIDDEN_NETWORKS = (
    ipaddress.ip_network("0.0.0.0/8"),
    # Covers 169.254.169.254 (AWS/Azure/GCP instance-metadata endpoint)
    # along with the rest of the link-local range — Python's
    # is_link_local already catches this too; kept explicit so the
    # intent is obvious at a glance.
    ipaddress.ip_network("169.254.0.0/16"),
)

_BLOCKED_HOSTNAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}


def _is_forbidden_ip(ip_obj):

    if ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_multicast or ip_obj.is_unspecified or ip_obj.is_reserved:
        return True

    return any(ip_obj in net for net in _EXTRA_FORBIDDEN_NETWORKS)


def _loose_ipv4(host):
    """Catches decimal/octal/hex single-integer IPv4 forms (e.g.
    "2130706433", "0x7f000001") that ipaddress.ip_address() correctly
    rejects as malformed but a more permissive resolver could still
    interpret as a real address — canonicalized here via inet_aton (the
    historically permissive BSD parser) so the forbidden-destination
    check below still catches them instead of the value falling through
    to a DNS lookup with unpredictable behavior."""

    try:
        return ipaddress.IPv4Address(socket.inet_aton(host))
    except (OSError, UnicodeError, ipaddress.AddressValueError):
        return None


def _resolve_all_ips(host):
    """Every literal/resolved address `host` could mean — a hostname
    that resolves to more than one A/AAAA record can't sneak a forbidden
    one past a check that only looked at the first answer. Raises
    CameraDestinationBlocked for anything that can't be turned into at
    least one concrete address."""

    host = (host or "").strip().strip("[]")

    if not host or host.lower() in _BLOCKED_HOSTNAMES:
        raise CameraDestinationBlocked("blocked hostname")

    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass

    loose = _loose_ipv4(host)
    if loose is not None:
        return [loose]

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise CameraDestinationBlocked("unresolvable host")

    ips = {info[4][0].split("%")[0] for info in infos}  # strip IPv6 zone id

    if not ips:
        raise CameraDestinationBlocked("unresolvable host")

    return [ipaddress.ip_address(ip) for ip in ips]


def validate_camera_destination(host):
    """Returns None if `host` (a bare hostname or IP) is an allowed
    camera destination, or a user-facing error message string if it
    isn't — same return convention as every other validate_* function in
    this module. Re-resolves DNS every call (never cached), since this
    is meant to be called again immediately before the real network
    call, not just once at form-submit time."""

    try:
        resolved_ips = _resolve_all_ips(host)
    except CameraDestinationBlocked:
        return "Camera destination is not allowed."

    if any(_is_forbidden_ip(ip) for ip in resolved_ips):
        return "Camera destination is not allowed."

    return None


def _connection_target_allowed(host):
    """Boolean form of validate_camera_destination(), used at actual
    connection time (immediately before opening a socket/RTSP
    stream/HTTP request) — a rejected destination there should just
    behave like any other unreachable camera, not surface a distinct
    message."""

    return bool(host) and validate_camera_destination(host) is None


def _hostname_from_rtsp_url(rtsp_url):
    """The real connect-time host for a (possibly credential-bearing)
    rtsp:// URL — used for Custom RTSP, where the URL itself carries the
    destination rather than the separate camera_ip field. urlsplit()
    correctly separates userinfo (user:pass@) from the host, so a URL
    like "rtsp://169.254.169.254@evil.example/" — which a naive
    string-matching check could misread — resolves to hostname
    "evil.example", exactly as a real client (browser, curl, FFmpeg)
    would interpret it."""

    try:
        return urlsplit((rtsp_url or "").strip()).hostname
    except ValueError:
        return None


# ==========================================
# Validation
# ==========================================
def _is_valid_ipv4(value):

    try:
        ipaddress.IPv4Address(value)
        return True
    except ValueError:
        return False


def _validate_camera_name(camera_name):

    return validate_text_field(camera_name, "Camera Name", min_len=CAMERA_NAME_MIN, max_len=CAMERA_NAME_MAX)


def _validate_location(camera_location):
    """Optional field — only validated (length + charset) when non-blank,
    same as before this used the shared validator."""

    return validate_text_field(
        camera_location, "Camera Location", max_len=LOCATION_MAX, required=False, address_like=True
    )


def validate_camera_brand(brand):

    if brand not in BRAND_KEYS:
        labels = ", ".join(label for _, label in CAMERA_BRANDS)
        return f"Camera Brand must be one of: {labels}."

    return None


def validate_custom_rtsp(rtsp_url):
    """Only required/checked when Camera Brand is "Custom RTSP" — every
    other brand ignores whatever is in this field and generates its own
    URL server-side."""

    rtsp_url = (rtsp_url or "").strip()

    if not rtsp_url:
        return "RTSP URL is required when Camera Brand is Custom RTSP."

    if not rtsp_url.lower().startswith("rtsp://"):
        return "RTSP URL must start with rtsp://."

    if len(rtsp_url) > CUSTOM_RTSP_MAX:
        return f"RTSP URL must be {CUSTOM_RTSP_MAX} characters or fewer."

    # SSRF protection — parsed via urlsplit (not a prefix/substring
    # check), so this can't be fooled by userinfo confusion
    # ("rtsp://safe.example@169.254.169.254/"), and the resolved
    # destination itself (not just the string) is what gets checked.
    host = _hostname_from_rtsp_url(rtsp_url)

    if not host:
        return "RTSP URL must include a valid host."

    destination_error = validate_camera_destination(host)
    if destination_error:
        return destination_error

    return None


def validate_connection_fields(camera_ip, username, password, port, channel_number, require_password=True):
    """Shared by add_camera/update_camera and the standalone Test Camera
    endpoint — the same fields (IP, username, password, port, channel)
    are what both a save and a connection test need, and both must
    reject the same bad input the same way.

    require_password=False is used only by update_camera's own Edit
    flow, where a blank password field means "keep the camera's
    currently stored password" (see update_camera) rather than "set an
    empty password" — Add Camera and Test Connection always pass the
    default (True), unchanged from before this parameter existed."""

    camera_ip = (camera_ip or "").strip()
    username = (username or "").strip()

    if not camera_ip:
        return "Camera IP Address is required."

    if not _is_valid_ipv4(camera_ip):
        return "Camera IP Address must be a valid IPv4 address."

    # SSRF protection — see validate_camera_destination's own docstring.
    destination_error = validate_camera_destination(camera_ip)
    if destination_error:
        return destination_error

    if not username:
        return "Username is required."

    if len(username) > USERNAME_MAX:
        return f"Username must be {USERNAME_MAX} characters or fewer."

    # Camera/DVR device password — required and length-capped like any
    # credential, but deliberately NOT run through the strong-password
    # complexity policy (validate_password(strong=True)) used for app
    # accounts: real DVRs frequently ship short/numeric-only passwords,
    # and this app must be able to store whatever the device actually
    # uses, not what a security policy would prefer it used.
    if require_password or password:
        error = validate_password(password, label="Password", strong=False, max_len=CAMERA_PASSWORD_MAX)
        if error:
            return error

    try:
        port_int = int(port)
    except (TypeError, ValueError):
        return "Port must be a number between 1 and 65535."

    if port_int < 1 or port_int > 65535:
        return "Port must be a number between 1 and 65535."

    try:
        channel_int = int(channel_number)
    except (TypeError, ValueError):
        return "Channel Number must be between 1 and 256."

    if channel_int < 1 or channel_int > 256:
        return "Channel Number must be between 1 and 256."

    return None


def _duplicate_exists(customer_id, camera_ip, port, channel_number, exclude_camera_id=None):
    """Same IP + Port + Channel Number for the same customer is the same
    physical camera stream — never allowed twice, though the same IP on
    a different channel (a multi-channel DVR) or a different port (a
    second device sharing the same IP) is completely valid and must not
    be blocked."""

    with get_session() as session:
        query = select(Camera).where(
            Camera.customer_id == customer_id,
            Camera.camera_ip == camera_ip,
            Camera.port == port,
            Camera.channel_number == channel_number,
        )

        if exclude_camera_id is not None:
            query = query.where(Camera.camera_id != exclude_camera_id)

        return session.scalar(query) is not None


# ==========================================
# Serialization
# ==========================================
def _serialize(row):
    """The PUBLIC-facing camera shape — everything returned by an API
    route (list/get/create/update) goes through this. Security fix: this
    used to decrypt and return the real device password, and returned
    `rtsp_url` with the password embedded in it — both are gone. Callers
    that actually need to open a real connection (opening the live
    stream, the AI Detection Engine's worker, the Hikvision ISAPI call)
    never go through this function; they use _resolve_connection_url()
    below, or already have the plaintext value in hand from the current
    request body."""

    return {
        "camera_id": row["camera_id"],
        "customer_id": row["customer_id"],
        "camera_name": row["camera_name"],
        "brand": row["brand"] or "hikvision",
        "camera_ip": row["camera_ip"],
        "username": row["username"] or "",
        # A password was set (or not) — never the password itself. The
        # Edit form treats this field as write-only: blank means "keep
        # what's already saved" (see update_camera).
        "has_password": bool(row["password_encrypted"]),
        "port": row["port"] or DEFAULT_PORT,
        "channel_number": row["channel_number"],
        # Already sanitized (no embedded credentials) at write time —
        # see Camera.rtsp_url's own docstring in auth/models.py.
        "rtsp_url": row["rtsp_url"],
        "stream_quality": row.get("stream_quality") or DEFAULT_STREAM_QUALITY,
        "camera_location": row["camera_location"] or "",
        "status": row["status"],
        "detection_enabled": bool(row["detection_enabled"]),
        "last_connected_time": row["last_connected_time"],
        "created_at": row["created_at"],
        "owner_user_id": row.get("owner_user_id"),
        # Site / VPN Gateway Management — None for every camera created
        # before this feature (and any company that never uses Sites at
        # all). Purely an access/grouping association: never read by
        # build_rtsp_url/_resolve_connection_url, so this has zero effect
        # on how a camera actually connects.
        "site_id": row.get("site_id"),
    }


def _get_raw_camera(camera_id, customer_id, restrict_to_owner_user_id=None):
    """INTERNAL ONLY — never returned from an API route. The full,
    unfiltered row (password_encrypted, custom_rtsp_url_encrypted, and
    the sanitized rtsp_url included) that _serialize() deliberately
    filters out. Used solely by update_camera's own "blank field means
    keep the existing secret" handling, and by callers that need to
    actually open a connection."""

    with get_session() as session:
        query = select(Camera).where(Camera.camera_id == camera_id, Camera.customer_id == customer_id)
        query = apply_owner_scope(query, Camera.owner_user_id, restrict_to_owner_user_id)
        row = session.scalar(query)
        return to_dict(row) if row else None


def _resolve_connection_url(camera):
    """Rebuilds the real, credential-bearing RTSP connection URL from a
    Camera ORM row's stored non-sensitive fields plus its encrypted
    secret(s) — the DB itself never stores this string; it exists only
    in memory, for exactly as long as it takes to open/restart a
    connection. `camera` is a live Camera ORM instance (attribute
    access), not a dict."""

    if camera.brand == "custom":
        if not camera.custom_rtsp_url_encrypted:
            return ""
        return decrypt_password(camera.custom_rtsp_url_encrypted)

    password = decrypt_password(camera.password_encrypted) if camera.password_encrypted else ""

    return build_rtsp_url(
        camera.brand, camera.camera_ip, camera.username, password,
        camera.port, camera.channel_number, None, camera.stream_quality or DEFAULT_STREAM_QUALITY,
    )


def get_cameras_for_customer(customer_id, owner_user_id=None):

    with get_session() as session:
        query = select(Camera).where(Camera.customer_id == customer_id).order_by(Camera.created_at.desc())
        query = apply_owner_scope(query, Camera.owner_user_id, owner_user_id)
        rows = session.scalars(query).all()
        return [_serialize(to_dict(r)) for r in rows]


def get_camera_counts(customer_id, owner_user_id=None):
    """Real online/total counts for this customer's own cameras — the
    single source of truth for both the Dashboard's "Cameras Online" card
    and the Sidebar's Camera Status widget, so the two can never disagree
    and neither ever falls back to a placeholder number."""

    with get_session() as session:
        total_query = apply_owner_scope(
            select(func.count()).select_from(Camera).where(Camera.customer_id == customer_id),
            Camera.owner_user_id, owner_user_id,
        )
        online_query = apply_owner_scope(
            select(func.count()).select_from(Camera).where(Camera.customer_id == customer_id, Camera.status == "Online"),
            Camera.owner_user_id, owner_user_id,
        )
        total = session.scalar(total_query)
        online = session.scalar(online_query)
        return {"online": online or 0, "total": total or 0}


def get_camera_counts_all():
    """Same shape as get_camera_counts(customer_id), but platform-wide —
    for the Super Admin Dashboard, which needs totals across every
    customer rather than one customer's own rows."""

    with get_session() as session:
        total = session.scalar(select(func.count()).select_from(Camera))
        online = session.scalar(select(func.count()).select_from(Camera).where(Camera.status == "Online"))
        return {"online": online or 0, "total": total or 0}


def get_camera_counts_by_customer(customer_ids):
    """Same {online, total} shape as get_camera_counts(), for every id in
    customer_ids, computed in a SINGLE grouped query instead of one query
    per customer — used by the Super Admin Dashboard's per-Company-Admin
    camera breakdown, which would otherwise be an N+1 query pattern as
    the number of companies grows."""

    counts = {cid: {"online": 0, "total": 0} for cid in customer_ids}

    if not customer_ids:
        return counts

    with get_session() as session:
        rows = session.execute(
            select(Camera.customer_id, Camera.status, func.count())
            .where(Camera.customer_id.in_(customer_ids))
            .group_by(Camera.customer_id, Camera.status)
        ).all()

    for customer_id, status, count in rows:
        counts[customer_id]["total"] += count
        if status == "Online":
            counts[customer_id]["online"] = count

    return counts


def get_camera_counts_by_owner(customer_id):
    """{owner_user_id: {"online":.., "offline":.., "total":..}} for
    every distinct owner_user_id among this customer's own cameras
    (including the None key, for unassigned cameras) — one grouped
    query, not one query per User, so the Admin Dashboard's User &
    Camera Overview (api/dashboard.py's get_admin_user_camera_overview)
    never becomes an N+1 query pattern as Users/cameras grow. A User
    with zero assigned cameras simply has no key here — callers default
    to {"online": 0, "offline": 0, "total": 0}."""

    with get_session() as session:
        rows = session.execute(
            select(Camera.owner_user_id, Camera.status, func.count())
            .where(Camera.customer_id == customer_id)
            .group_by(Camera.owner_user_id, Camera.status)
        ).all()

    counts = {}
    for owner_user_id, status, count in rows:
        entry = counts.setdefault(owner_user_id, {"online": 0, "offline": 0, "total": 0})
        entry["total"] += count
        if status == "Online":
            entry["online"] += count
        else:
            entry["offline"] += count

    return counts


def get_camera(camera_id, customer_id, restrict_to_owner_user_id=None):
    """Scoped to customer_id — a camera can only ever be read/edited/
    deleted through the customer it actually belongs to, never by
    camera_id alone. `restrict_to_owner_user_id`, when passed (a User
    caller, forced to their own id — see api/routes.py's
    _mutation_owner_restriction), additionally restricts this to a
    camera that User actually owns, so a User can never read/tamper
    with — or see the plaintext RTSP password of — a sibling User's or
    unassigned camera merely by guessing/incrementing a camera_id."""

    with get_session() as session:
        query = select(Camera).where(Camera.camera_id == camera_id, Camera.customer_id == customer_id)
        query = apply_owner_scope(query, Camera.owner_user_id, restrict_to_owner_user_id)
        row = session.scalar(query)
        return _serialize(to_dict(row)) if row else None


def add_camera(customer_id, camera_name, camera_ip, username, password, port, channel_number, brand, custom_rtsp_url, camera_location, owner_user_id=None, stream_quality=DEFAULT_STREAM_QUALITY, site_id=None):

    camera_name = (camera_name or "").strip()
    camera_ip = (camera_ip or "").strip()
    username = (username or "").strip()
    password = password or ""
    custom_rtsp_url = (custom_rtsp_url or "").strip()
    camera_location = (camera_location or "").strip()
    brand = (brand or "").strip()
    stream_quality = (stream_quality or DEFAULT_STREAM_QUALITY).strip()

    if port in (None, ""):
        port = DEFAULT_PORT

    error = (
        _validate_camera_name(camera_name)
        or validate_camera_brand(brand)
        or validate_connection_fields(camera_ip, username, password, port, channel_number)
        or _validate_location(camera_location)
        or _validate_owner_user_id(customer_id, owner_user_id)
        or validate_stream_quality(stream_quality)
        or _validate_site_id(customer_id, site_id)
    )

    if not error and brand == "custom":
        error = validate_custom_rtsp(custom_rtsp_url)

    if error:
        return None, error

    port = int(port)
    channel_number = int(channel_number)

    if _duplicate_exists(customer_id, camera_ip, port, channel_number):
        return None, "A camera with this IP Address, Port, and Channel Number already exists for this customer."

    # Camera Limit / Camera Quota Management — real, live counts checked
    # right before insert (same "count-then-insert" window
    # _duplicate_exists above already accepts; a true concurrent-request
    # race would need a row lock this codebase doesn't otherwise use).
    # Checked before the network round-trip below so an over-quota
    # request fails fast.
    quota_error = validate_camera_creation_quota(customer_id, owner_user_id)

    if quota_error:
        return None, quota_error

    rtsp_url = build_rtsp_url(brand, camera_ip, username, password, port, channel_number, custom_rtsp_url, stream_quality)
    encrypted_password = encrypt_password(password)
    # Security fix: Custom RTSP is the one brand whose connection URL
    # carries its own credentials with nowhere else to live — encrypted
    # here the same way the password above is, so the DB row never has
    # to hold it in plaintext (see Camera.rtsp_url's docstring in
    # auth/models.py).
    encrypted_custom_rtsp_url = encrypt_password(custom_rtsp_url) if brand == "custom" and custom_rtsp_url else None

    # Authoritative status/last_connected_time — a fresh camera is
    # verified for real at creation time rather than trusting whatever
    # the Add form's own (client-side, pre-save) Test Camera click
    # reported, since that's only ever a UX gate, never a guarantee the
    # backend can rely on.
    connected, _reason, _rtsp_url, _preview = test_camera_connection(
        brand, camera_ip, username, password, port, channel_number, custom_rtsp_url, stream_quality
    )
    status = "Online" if connected else DEFAULT_STATUS
    last_connected_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S") if connected else None

    with get_session() as session:
        camera = Camera(
            customer_id=customer_id,
            camera_name=camera_name,
            brand=brand,
            camera_ip=camera_ip,
            username=username,
            password_encrypted=encrypted_password,
            port=port,
            channel_number=channel_number,
            # Sanitized/credential-free — the real URL (`rtsp_url` local
            # var, still in memory below) is what the worker actually
            # connects with; only the safe display form is persisted.
            rtsp_url=sanitize_sensitive_url(rtsp_url),
            custom_rtsp_url_encrypted=encrypted_custom_rtsp_url,
            stream_quality=stream_quality,
            camera_location=camera_location,
            status=status,
            detection_enabled=1,
            last_connected_time=last_connected_time,
            created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            owner_user_id=owner_user_id,
            site_id=site_id,
        )
        session.add(camera)
        session.flush()
        new_id = camera.camera_id

    # Per-Camera Quality Selection: for Hikvision, "720p"/"1080p" share
    # the same RTSP URL (see BRAND_QUALITY_RTSP_TEMPLATES) — the camera's
    # own recording resolution for that channel is what actually
    # distinguishes them, set here via ISAPI. Best-effort/non-fatal (see
    # _apply_hikvision_stream_quality) — never blocks camera creation.
    if brand == "hikvision" and stream_quality in HIKVISION_ISAPI_RESOLUTION:
        _apply_hikvision_stream_quality(camera_ip, username, password, channel_number, stream_quality)

    # A newly added camera starts detecting immediately — no page needs
    # to be opened for the AI Detection Engine to pick it up.
    detection_service.start_camera_worker(new_id, customer_id, rtsp_url, owner_user_id=owner_user_id)

    return get_camera(new_id, customer_id), None


def update_camera(camera_id, customer_id, camera_name, camera_ip, username, password, port, channel_number, brand, custom_rtsp_url, camera_location, owner_user_id=_UNSET, stream_quality=_UNSET, site_id=_UNSET, restrict_to_owner_user_id=None):
    """Security fix — password (and, for brand == "custom", the RTSP URL)
    are now write-only fields from the Edit form's point of view: since
    _serialize() no longer returns the real secret for the form to
    prefill, a BLANK password/custom-RTSP-URL on this call means "leave
    the currently stored one alone", not "set it to empty". A non-blank
    value always means "change it". See existing_password/
    custom_rtsp_changed below."""

    camera_name = (camera_name or "").strip()
    camera_ip = (camera_ip or "").strip()
    username = (username or "").strip()
    password = password or ""
    custom_rtsp_url = (custom_rtsp_url or "").strip()
    camera_location = (camera_location or "").strip()
    brand = (brand or "").strip()

    if port in (None, ""):
        port = DEFAULT_PORT

    error = (
        _validate_camera_name(camera_name)
        or validate_camera_brand(brand)
        # require_password=False: a blank password here is valid on
        # Edit (see the function docstring above) — Add Camera still
        # requires one via add_camera's own default (True) call.
        or validate_connection_fields(camera_ip, username, password, port, channel_number, require_password=False)
        or _validate_location(camera_location)
    )

    if not error and owner_user_id is not _UNSET:
        error = _validate_owner_user_id(customer_id, owner_user_id)

    if not error and stream_quality is not _UNSET:
        error = validate_stream_quality(stream_quality)

    if not error and site_id is not _UNSET:
        error = _validate_site_id(customer_id, site_id)

    if not error and brand == "custom" and custom_rtsp_url:
        # Only validated when actually provided — a blank value here
        # means "keep the existing Custom RTSP URL" (see below), and
        # that existing (encrypted) value was already validated when it
        # was first saved.
        error = validate_custom_rtsp(custom_rtsp_url)

    if error:
        return None, error

    # _get_raw_camera (not get_camera/_serialize): this function needs
    # the real password_encrypted/custom_rtsp_url_encrypted to implement
    # "blank means keep existing" below — those are deliberately never
    # part of the public-facing dict get_camera() returns.
    existing = _get_raw_camera(camera_id, customer_id, restrict_to_owner_user_id=restrict_to_owner_user_id)

    if existing is None:
        return None, "Camera not found."

    # Camera Limit / Camera Quota Management — only relevant when this
    # edit actually MOVES the camera to a different, real User; assigning
    # to the SAME owner (a no-op) or unassigning (owner_user_id=None)
    # never needs a quota check. The Admin's own company-wide total is
    # unaffected by a reassignment within the same company (it's already
    # counted either way), so only the new owner's own quota matters here
    # — see validate_camera_reassignment_quota.
    if (
        owner_user_id is not _UNSET
        and owner_user_id is not None
        and owner_user_id != existing["owner_user_id"]
    ):
        quota_error = validate_camera_reassignment_quota(owner_user_id)

        if quota_error:
            return None, quota_error

    # Field omitted (e.g. the Super Admin's own Edit Camera form, which
    # has no Camera Quality control at all) -> keep this camera's current
    # quality exactly as-is, same "don't touch what wasn't sent" contract
    # owner_user_id already uses above.
    if stream_quality is _UNSET:
        stream_quality = existing["stream_quality"]

    port = int(port)
    channel_number = int(channel_number)

    if _duplicate_exists(customer_id, camera_ip, port, channel_number, exclude_camera_id=camera_id):
        return None, "A camera with this IP Address, Port, and Channel Number already exists for this customer."

    # --- Password: blank means "keep the currently stored one" ---
    existing_password = decrypt_password(existing["password_encrypted"]) if existing["password_encrypted"] else ""
    password_changed = bool(password) and password != existing_password
    effective_password = password if password else existing_password
    encrypted_password = encrypt_password(effective_password) if password else existing["password_encrypted"]

    # --- Custom RTSP URL: same write-only pattern as the password above
    # — the value the Edit form was prefilled with is only ever the
    # sanitized (credential-free) display string (existing["rtsp_url"]),
    # so comparing against THAT (not the decrypted real value) is how an
    # untouched field is told apart from a genuinely retyped URL. ---
    existing_custom_rtsp_url = (
        decrypt_password(existing["custom_rtsp_url_encrypted"])
        if existing.get("custom_rtsp_url_encrypted") else ""
    )
    custom_rtsp_changed = (
        brand == "custom"
        and bool(custom_rtsp_url)
        and custom_rtsp_url != (existing["rtsp_url"] or "").strip()
    )

    if brand == "custom":
        effective_custom_rtsp_url = custom_rtsp_url if custom_rtsp_changed else existing_custom_rtsp_url
        encrypted_custom_rtsp_url = (
            encrypt_password(effective_custom_rtsp_url) if custom_rtsp_changed
            else existing.get("custom_rtsp_url_encrypted")
        )
    else:
        effective_custom_rtsp_url = None
        encrypted_custom_rtsp_url = None

    rtsp_url = build_rtsp_url(brand, camera_ip, username, effective_password, port, channel_number, effective_custom_rtsp_url, stream_quality)

    # Only worth a real re-test when something the connection is actually
    # built from changed — a pure Camera Name/Location edit must never
    # cost several extra seconds re-verifying a connection that didn't
    # change, and must never overwrite a status/last_connected_time that
    # is still perfectly accurate. Compared field-by-field (not by
    # comparing the built rtsp_url strings) since rtsp_url itself is now
    # a sanitized display value, not the real connection string — a
    # string comparison there would always report "changed". stream_
    # quality is checked separately because Hikvision's 720p<->1080p
    # change reuses the SAME URL template (see
    # BRAND_QUALITY_RTSP_TEMPLATES) — without this, editing only the
    # quality between those two would look like nothing changed at all,
    # and neither the ISAPI resolution update below nor the worker
    # restart would happen.
    connection_unchanged = (
        existing["camera_ip"] == camera_ip
        and existing["username"] == username
        and not password_changed
        and existing["port"] == port
        and existing["channel_number"] == channel_number
        and existing["brand"] == brand
        and not custom_rtsp_changed
        and existing["stream_quality"] == stream_quality
    )
    quality_changed = existing["stream_quality"] != stream_quality

    if connection_unchanged:
        status = existing["status"]
        last_connected_time = existing["last_connected_time"]
    else:
        connected, _reason, _rtsp_url, _preview = test_camera_connection(
            brand, camera_ip, username, effective_password, port, channel_number, effective_custom_rtsp_url, stream_quality
        )
        status = "Online" if connected else "Offline"
        last_connected_time = (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S") if connected else existing["last_connected_time"]
        )

    with get_session() as session:
        query = select(Camera).where(Camera.camera_id == camera_id, Camera.customer_id == customer_id)
        query = apply_owner_scope(query, Camera.owner_user_id, restrict_to_owner_user_id)
        camera = session.scalar(query)
        camera.camera_name = camera_name
        camera.brand = brand
        camera.camera_ip = camera_ip
        camera.username = username
        camera.password_encrypted = encrypted_password
        camera.port = port
        camera.channel_number = channel_number
        # Sanitized/credential-free — see add_camera's identical comment.
        camera.rtsp_url = sanitize_sensitive_url(rtsp_url)
        camera.custom_rtsp_url_encrypted = encrypted_custom_rtsp_url
        camera.stream_quality = stream_quality
        camera.camera_location = camera_location
        camera.status = status
        camera.last_connected_time = last_connected_time

        if owner_user_id is not _UNSET:
            camera.owner_user_id = owner_user_id

        if site_id is not _UNSET:
            camera.site_id = site_id

        detection_currently_enabled = bool(camera.detection_enabled)
        effective_owner_user_id = camera.owner_user_id

    # Same best-effort Hikvision ISAPI reconfiguration as add_camera —
    # only when the quality actually changed on THIS edit (never on an
    # unrelated field-only save), so a plain Camera Name/Location edit
    # never triggers an extra camera-side write.
    if brand == "hikvision" and quality_changed and stream_quality in HIKVISION_ISAPI_RESOLUTION:
        _apply_hikvision_stream_quality(camera_ip, username, effective_password, channel_number, stream_quality)

    # The connection just changed underneath the AI Detection Engine's
    # already-running worker (if any) — restart it against the new URL
    # immediately, rather than leaving it running against a now-stale
    # connection until the backend next restarts. A disabled camera has
    # no worker to restart; update_camera never turns detection back on.
    # A pure owner_user_id reassignment (connection unchanged) still
    # needs the running worker's entry updated so notifications/future
    # attendance writes reflect the new owner — cheapest way to do that
    # is the same restart, which is otherwise a no-op cost-wise since it
    # only happens on an explicit Edit save, not per-frame. `rtsp_url`
    # here is the REAL, in-memory-only connection string built above —
    # never the sanitized one just written to the DB.
    #
    # Dispatched on a background thread, not called inline: restart_
    # camera_worker() now hot-swaps (see its own docstring) — it briefly
    # runs the new-resolution worker alongside the old one and waits for
    # the new one's first real frame before tearing the old one down, so
    # this Edit Camera save would otherwise block the HTTP response for
    # that same window (up to HOT_SWAP_FIRST_FRAME_TIMEOUT_SECONDS on a
    # slow/failed reconnect) for no benefit to the caller — the frontend
    # only needs the DB write confirmed, not the live worker swap. The
    # swap itself is unaffected either way: restart_camera_worker() still
    # runs to completion, still serialized per-camera by its own
    # _get_restart_lock, still fully exception-isolated internally.
    if detection_currently_enabled and (not connection_unchanged or owner_user_id is not _UNSET):
        def _restart_worker_in_background():
            try:
                detection_service.restart_camera_worker(camera_id, customer_id, rtsp_url, owner_user_id=effective_owner_user_id)
            except Exception as e:
                log_exception(e, f"camera worker hot-swap (camera={camera_id})")

        threading.Thread(target=_restart_worker_in_background, daemon=True).start()

    return get_camera(camera_id, customer_id), None


def delete_camera(camera_id, customer_id, restrict_to_owner_user_id=None):

    with get_session() as session:
        query = select(Camera).where(Camera.camera_id == camera_id, Camera.customer_id == customer_id)
        query = apply_owner_scope(query, Camera.owner_user_id, restrict_to_owner_user_id)
        camera = session.scalar(query)

        if camera is None:
            return False

        session.delete(camera)

    # Stop the AI Detection Engine's worker for this camera — a deleted
    # camera must never keep running in the background forever.
    detection_service.stop_camera_worker(camera_id)

    # --- Memory Cleanup Fix: release this camera's per-tracking_key AI
    # state on genuine deletion ---
    # stop_camera_worker() above only removes the camera/detection_
    # service.py worker registry entry — it never touches the SEPARATE
    # per-tracking_key caches in detection/detector.py (a full loaded
    # YOLO model instance), camera/frame_processor.py (detection-
    # persistence overlay + face-gate timestamp), or face/track_verifier.
    # py (active consensus tracks). A camera that's disabled or restarted
    # reuses the same tracking_key and correctly keeps all of this warm
    # — only a genuine delete should ever drop it, since a real camera's
    # own tracking_key IS its camera_id (see
    # camera/frame_processor.py's compute_tracking_key — camera_id is
    # never None here, this is never the local-webcam pseudo-camera),
    # and nothing can ever reach that tracking_key again once the row is
    # gone. Without this, every deleted-and-recreated camera (a new row
    # gets a new camera_id, i.e. a brand-new tracking_key) leaves its old
    # entries — including a full loaded YOLO model — resident in memory
    # for the lifetime of the process.
    detection_service.drop_camera_ai_state(camera_id)

    return True


def set_camera_detection_enabled(camera_id, customer_id, enabled, restrict_to_owner_user_id=None):
    """Company Admin's (or a User's own) on/off switch for the AI
    Detection Engine on one camera — starts or stops that camera's
    worker immediately, without touching its saved connection details or
    `status`. Returns the updated camera dict, or None if it doesn't
    belong to this customer (or, when restrict_to_owner_user_id is set,
    isn't owned by that User)."""

    with get_session() as session:
        query = select(Camera).where(Camera.camera_id == camera_id, Camera.customer_id == customer_id)
        query = apply_owner_scope(query, Camera.owner_user_id, restrict_to_owner_user_id)
        camera = session.scalar(query)

        if camera is None:
            return None

        camera.detection_enabled = 1 if enabled else 0
        owner_user_id = camera.owner_user_id
        # Security fix: camera.rtsp_url is now a sanitized display value,
        # not a working connection string — _resolve_connection_url()
        # rebuilds the real one in memory from the encrypted secret(s),
        # only when actually about to start a worker.
        rtsp_url = _resolve_connection_url(camera) if enabled else None

    if enabled:
        detection_service.start_camera_worker(camera_id, customer_id, rtsp_url, owner_user_id=owner_user_id)
    else:
        detection_service.stop_camera_worker(camera_id)

    return get_camera(camera_id, customer_id, restrict_to_owner_user_id=restrict_to_owner_user_id)


def record_connection_test_result(camera_id, customer_id, connected, restrict_to_owner_user_id=None):
    """Persists the outcome of an interactive Test Camera click against
    an already-saved camera (the Edit form) — status flips to Online/
    Offline immediately, and last_connected_time only ever advances on
    success, since a failed re-test must never erase how long ago the
    camera last definitely worked. Scoped by customer_id (and, when
    restrict_to_owner_user_id is set, by owner_user_id too), same as
    every other camera write."""

    existing = get_camera(camera_id, customer_id, restrict_to_owner_user_id=restrict_to_owner_user_id)

    if existing is None:
        return None

    status = "Online" if connected else "Offline"
    last_connected_time = (
        datetime.now().strftime("%Y-%m-%d %H:%M:%S") if connected else existing["last_connected_time"]
    )

    with get_session() as session:
        query = select(Camera).where(Camera.camera_id == camera_id, Camera.customer_id == customer_id)
        query = apply_owner_scope(query, Camera.owner_user_id, restrict_to_owner_user_id)
        camera = session.scalar(query)
        camera.status = status
        camera.last_connected_time = last_connected_time

    return get_camera(camera_id, customer_id, restrict_to_owner_user_id=restrict_to_owner_user_id)


# ==========================================
# Connection Test
# ==========================================
def _tcp_precheck(camera_ip, port):
    """Fast (few-second) reachability probe run before attempting a full
    RTSP handshake — lets a clearly-down device (wrong IP, powered off,
    blocked by firewall) fail fast with a specific, useful reason
    instead of waiting out the slower OpenCV/FFMPEG attempt just to get
    a generic "could not open" a few seconds later."""

    try:
        with socket.create_connection((camera_ip, int(port)), timeout=SOCKET_PRECHECK_TIMEOUT_SECONDS):
            return None
    except socket.timeout:
        return f"Connection to {camera_ip}:{port} timed out. Check the IP address and that the device is powered on and reachable."
    except (ConnectionRefusedError, OSError):
        return f"Connection to {camera_ip}:{port} was refused. Check the IP address, port, and network/firewall settings."


def test_camera_connection(brand, camera_ip, username, password, port, channel_number, custom_rtsp_url=None, stream_quality=DEFAULT_STREAM_QUALITY):
    """Builds the RTSP URL for `brand` (or uses `custom_rtsp_url` as-is
    when brand == "custom") and attempts a real connection + one-frame
    read, on a daemon thread with a hard timeout so an unreachable
    device can never hang the caller.

    Returns (connected, reason, rtsp_url, preview_data_uri):
      - reason is a human-readable explanation, always populated —
        distinguishing "device unreachable" (TCP precheck), "RTSP
        handshake failed" (wrong brand/credentials), and "no frame"
        (wrong channel/stream path) whenever possible, rather than one
        generic failure message.
      - preview_data_uri is a base64 JPEG data: URI of the first
        captured frame on success, otherwise None.

    Purely a reachability/frame check against whichever URL
    `stream_quality` currently resolves to — never writes anything to
    the camera itself (see _apply_hikvision_stream_quality, which is
    only ever called from add_camera/update_camera on an actual save).

    SSRF protection: both `camera_ip` (always required, every brand) and
    — for brand == "custom" — the real host embedded in the resulting
    RTSP URL are re-validated here, immediately before the TCP precheck
    and the actual cv2.VideoCapture connection, via the same central
    gate the save-time validators already ran (validate_camera_
    destination / validate_custom_rtsp). Re-checking here (not just
    trusting that earlier pass) is what closes the "validated once at
    form submit, connected to repeatedly for the camera's entire
    lifetime" gap — this function is called both by the one-shot Test
    Connection button and by add_camera/update_camera's own
    connectivity check."""

    rtsp_url = build_rtsp_url(brand, camera_ip, username, password, port, channel_number, custom_rtsp_url, stream_quality)

    if not _connection_target_allowed(camera_ip):
        return False, "Camera connection failed.", rtsp_url, None

    if brand == "custom":
        custom_host = _hostname_from_rtsp_url(rtsp_url)
        if not custom_host or not _connection_target_allowed(custom_host):
            return False, "Camera connection failed.", rtsp_url, None

    precheck_error = _tcp_precheck(camera_ip, port)

    if precheck_error:
        return False, precheck_error, rtsp_url, None

    result = {"connected": False, "reason": None, "frame": None}

    def _attempt():

        cap = cv2.VideoCapture()

        try:
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, CONNECTION_TEST_TIMEOUT_SECONDS * 1000)
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, CONNECTION_TEST_TIMEOUT_SECONDS * 1000)

            if not cap.open(rtsp_url, cv2.CAP_FFMPEG):
                result["reason"] = "Could not open the RTSP stream. Check the camera brand, username, and password."
                return

            ok, frame = cap.read()

            if not ok or frame is None:
                result["reason"] = "Connected, but no video frame was received. Check the channel number or stream path."
                return

            result["connected"] = True
            result["reason"] = "Camera Connected"
            result["frame"] = frame

        except Exception as e:
            # sanitize_sensitive_url: cv2/FFmpeg's own exception text can
            # embed the full rtsp://user:pass@... connection string —
            # this `reason` is server-side-only from here on (routes.py
            # never forwards it to the client, only logs it), but it's
            # sanitized at the source anyway rather than trusting every
            # future caller to remember to do it.
            result["reason"] = sanitize_sensitive_url(f"Connection attempt failed: {e}")
        finally:
            cap.release()

    thread = threading.Thread(target=_attempt, daemon=True)
    thread.start()
    thread.join(CONNECTION_TEST_TIMEOUT_SECONDS + 2)

    if thread.is_alive():
        # The OpenCV-level timeouts didn't take effect on this build —
        # the attempt is abandoned on its own daemon thread rather than
        # blocking the caller any further.
        return False, "Connection attempt timed out.", rtsp_url, None

    preview_data_uri = None

    if result["connected"] and result["frame"] is not None:
        ok, buffer = cv2.imencode(".jpg", result["frame"])
        if ok:
            preview_data_uri = "data:image/jpeg;base64," + base64.b64encode(buffer).decode("ascii")

    reason = result["reason"] or ("Camera Connected" if result["connected"] else "Unable to connect.")

    return result["connected"], reason, rtsp_url, preview_data_uri