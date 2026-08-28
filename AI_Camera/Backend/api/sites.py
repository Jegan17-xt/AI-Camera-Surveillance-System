"""Site / VPN Gateway Management.

A Site is a network/access grouping this app RECORDS — Office A's own
row here says "cameras behind this gateway live on this network" — it is
never the thing that actually establishes connectivity. The real
WireGuard tunnel between this backend's network and a Site's remote
camera network is configured and run entirely at infrastructure level
(the gateway device/host itself), completely outside this Flask process.
Nothing in this module opens, starts, stops, or embeds a WireGuard
server or client.

Because of that split, three things this module deliberately does NOT
do:
  - It never stores a WireGuard PRIVATE key — only the gateway's public
    key (vpn_public_key), which is safe to keep in plaintext. The Add/
    Edit Site form has no private-key field at all.
  - It never uses a Site's vpn_gateway_ip/camera_network to build or
    alter a camera's actual RTSP connection — see api/cameras.py's
    build_rtsp_url/_resolve_connection_url, both untouched by this
    feature. camera_network is informational/documentation metadata
    only.
  - "VPN Status" (check_site_status below) reads the WireGuard kernel
    interface's OWN real peer state on this server (`wg show <iface>
    dump` — the same data `wg show` prints at a shell) and reports
    Online only when the matching peer's latest handshake is recent.
    Nothing here opens a socket to the gateway, sends any packet, or
    performs a handshake itself — it only reads state WireGuard already
    maintains locally.
"""

import ipaddress
import os
import subprocess
import time
from datetime import datetime

from sqlalchemy import select, func, text

from db import get_session, engine
from auth.models import Site, SiteUser, Camera, to_dict
from auth.database import get_users_by_parent
from api.validators import validate_text_field
from api.cameras import validate_camera_destination, _is_valid_ipv4

SITE_NAME_MIN = 2
SITE_NAME_MAX = 120
CAMERA_NETWORK_MAX = 60
VPN_PUBLIC_KEY_MAX = 200

# WireGuard VPN Status — see check_site_status below. The interface name
# is env-configurable (never hardcoded) since it's a deployment detail,
# not something this app should assume; "wg0" matches this project's own
# gateway setup and is the near-universal default WireGuard convention.
WG_INTERFACE = os.environ.get("WG_INTERFACE", "wg0")

# A WireGuard peer normally re-handshakes every 120s (its own internal
# rekey timer) whenever there's active traffic, or via a configured
# PersistentKeepalive — 180s gives one missed cycle's worth of slack
# before a peer is reported Offline, rather than flapping on ordinary
# jitter.
WG_HANDSHAKE_STALE_SECONDS = 180

# `wg show ... dump` is a fast, local, read-only kernel query — this is
# just a safety ceiling in case the binary/kernel module ever hangs, not
# a realistic expected duration.
WG_COMMAND_TIMEOUT_SECONDS = 4


def init_sites_tables():
    """`sites` and `site_users` are brand-new tables — created directly by
    auth.database.init_db()'s Base.metadata.create_all(), same as every
    other brand-new model in this codebase (no migration needed for
    either). This only backfills Camera.site_id, a new column on the
    ALREADY-EXISTING `cameras` table — create_all() never adds columns to
    a table that's already there (same situation api/cameras.py's own
    init_cameras_table() already handles for detection_enabled/
    owner_user_id/stream_quality). NULL-able, no DEFAULT needed: every
    existing camera simply has no Site until a Company Admin explicitly
    assigns one via Camera Management — see this column's own docstring
    in auth/models.py.

    Must run after BOTH auth.database.init_db() (creates `sites`, which
    this FOREIGN KEY references) and api.cameras.init_cameras_table()
    (creates/backfills `cameras` itself)."""

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

        if "site_id" not in existing_columns:
            conn.execute(text("ALTER TABLE cameras ADD COLUMN site_id INTEGER NULL"))
            conn.execute(text("ALTER TABLE cameras ADD INDEX idx_cameras_site_id (site_id)"))
            conn.execute(text(
                "ALTER TABLE cameras ADD CONSTRAINT fk_cameras_site_id "
                "FOREIGN KEY (site_id) REFERENCES sites(site_id) ON DELETE SET NULL"
            ))
            conn.commit()


# ==========================================
# Validation
# ==========================================
def validate_site_name(site_name):

    return validate_text_field(site_name, "Site Name", min_len=SITE_NAME_MIN, max_len=SITE_NAME_MAX)


def validate_vpn_gateway_ip(vpn_gateway_ip):

    vpn_gateway_ip = (vpn_gateway_ip or "").strip()

    if not vpn_gateway_ip:
        return "VPN Gateway IP is required."

    if not _is_valid_ipv4(vpn_gateway_ip):
        return "VPN Gateway IP must be a valid IPv4 address."

    # Same SSRF-style destination gate every camera connection goes
    # through (api/cameras.py's validate_camera_destination) — a Site's
    # gateway is only ever probed by check_site_status() below (a plain
    # ICMP reachability check), never used to build a credential-bearing
    # connection, but loopback/link-local/multicast/reserved addresses
    # must stay off-limits here too. Private ranges (10.x, 172.16-31.x,
    # 192.168.x) are always allowed — real gateways live on exactly this
    # kind of address.
    return validate_camera_destination(vpn_gateway_ip)


def validate_camera_network(camera_network):
    """Optional — purely informational/documentation metadata (e.g.
    "192.168.1.0/24"), never enforced against any camera's own
    camera_ip at connection time."""

    camera_network = (camera_network or "").strip()

    if not camera_network:
        return None

    if len(camera_network) > CAMERA_NETWORK_MAX:
        return f"Camera Network must be {CAMERA_NETWORK_MAX} characters or fewer."

    try:
        ipaddress.ip_network(camera_network, strict=False)
    except ValueError:
        return "Camera Network must be a valid CIDR, e.g. 192.168.1.0/24."

    return None


def validate_vpn_public_key(vpn_public_key):
    """Optional. Deliberately permissive about format — WireGuard key
    material is opaque base64 to this app, and different tooling can
    present it slightly differently — just a length cap so this can
    never smuggle something unbounded into the database. This is a
    PUBLIC key field only: the Add/Edit Site form has no private-key
    input at all, and no route in this module ever accepts one — that
    omission (never a content check, which can't reliably tell a public
    key from a private one) is the real control. See this module's own
    docstring."""

    vpn_public_key = (vpn_public_key or "").strip()

    if not vpn_public_key:
        return None

    if len(vpn_public_key) > VPN_PUBLIC_KEY_MAX:
        return f"VPN Public Key must be {VPN_PUBLIC_KEY_MAX} characters or fewer."

    return None


# ==========================================
# Serialization
# ==========================================
def _serialize(row, camera_count=0):

    return {
        "site_id": row["site_id"],
        "customer_id": row["customer_id"],
        "site_name": row["site_name"],
        "vpn_gateway_ip": row["vpn_gateway_ip"],
        "camera_network": row["camera_network"] or "",
        "vpn_public_key": row["vpn_public_key"] or "",
        "vpn_status": row["vpn_status"] or "unknown",
        "vpn_last_checked": row["vpn_last_checked"],
        "status": row["status"],
        "created_at": row["created_at"],
        "camera_count": camera_count,
    }


def _camera_counts_by_site(customer_id):
    """{site_id: count} for every Site with at least one camera assigned
    — one grouped query, not one query per Site, same pattern as
    api/cameras.py's get_camera_counts_by_owner."""

    with get_session() as session:
        rows = session.execute(
            select(Camera.site_id, func.count())
            .where(Camera.customer_id == customer_id, Camera.site_id.isnot(None))
            .group_by(Camera.site_id)
        ).all()

    return {site_id: count for site_id, count in rows}


# ==========================================
# CRUD
# ==========================================
def get_sites_for_customer(customer_id, user_id=None):
    """Every Site belonging to this company (Company Admin's Site
    Management page — every status, `user_id=None`), or — when `user_id`
    is given — only the Sites that specific User has been explicitly
    granted access to (see SiteUser). The Camera Management "Site /
    Office" picker uses this same function for both roles: a Company
    Admin caller passes user_id=None (all company Sites), a User caller
    always passes their own id."""

    with get_session() as session:
        query = select(Site).where(Site.customer_id == customer_id)

        if user_id is not None:
            query = query.join(SiteUser, SiteUser.site_id == Site.site_id).where(SiteUser.user_id == user_id)

        query = query.order_by(Site.created_at.desc())
        rows = session.scalars(query).all()

    counts = _camera_counts_by_site(customer_id)

    return [_serialize(to_dict(r), camera_count=counts.get(r.site_id, 0)) for r in rows]


def get_site(site_id, customer_id):
    """Scoped to customer_id — a Site can only ever be read/edited/
    deleted through the company it actually belongs to, never by
    site_id alone (tenant isolation, same pattern as api/cameras.py's
    get_camera)."""

    with get_session() as session:
        row = session.scalar(select(Site).where(Site.site_id == site_id, Site.customer_id == customer_id))

        if row is None:
            return None

        row_dict = to_dict(row)

    counts = _camera_counts_by_site(customer_id)

    return _serialize(row_dict, camera_count=counts.get(site_id, 0))


def create_site(customer_id, site_name, vpn_gateway_ip, camera_network, vpn_public_key):

    site_name = (site_name or "").strip()
    vpn_gateway_ip = (vpn_gateway_ip or "").strip()
    camera_network = (camera_network or "").strip()
    vpn_public_key = (vpn_public_key or "").strip()

    error = (
        validate_site_name(site_name)
        or validate_vpn_gateway_ip(vpn_gateway_ip)
        or validate_camera_network(camera_network)
        or validate_vpn_public_key(vpn_public_key)
    )

    if error:
        return None, error

    with get_session() as session:
        site = Site(
            customer_id=customer_id,
            site_name=site_name,
            vpn_gateway_ip=vpn_gateway_ip,
            camera_network=camera_network or None,
            vpn_public_key=vpn_public_key or None,
            vpn_status="unknown",
            status="Active",
            created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )
        session.add(site)
        session.flush()
        new_id = site.site_id

    return get_site(new_id, customer_id), None


def update_site(site_id, customer_id, site_name, vpn_gateway_ip, camera_network, vpn_public_key):

    site_name = (site_name or "").strip()
    vpn_gateway_ip = (vpn_gateway_ip or "").strip()
    camera_network = (camera_network or "").strip()
    vpn_public_key = (vpn_public_key or "").strip()

    error = (
        validate_site_name(site_name)
        or validate_vpn_gateway_ip(vpn_gateway_ip)
        or validate_camera_network(camera_network)
        or validate_vpn_public_key(vpn_public_key)
    )

    if error:
        return None, error

    with get_session() as session:
        site = session.scalar(select(Site).where(Site.site_id == site_id, Site.customer_id == customer_id))

        if site is None:
            return None, "Site not found."

        site.site_name = site_name
        site.vpn_gateway_ip = vpn_gateway_ip
        site.camera_network = camera_network or None
        site.vpn_public_key = vpn_public_key or None

    return get_site(site_id, customer_id), None


def delete_site(site_id, customer_id):
    """Cameras currently assigned to this Site are NOT deleted or
    disconnected — Camera.site_id is ON DELETE SET NULL, so they simply
    fall back to "No Site", exactly like an unassigned camera today.
    Never touches a camera's own connection details/RTSP flow."""

    with get_session() as session:
        site = session.scalar(select(Site).where(Site.site_id == site_id, Site.customer_id == customer_id))

        if site is None:
            return False

        session.delete(site)
        return True


def set_site_status(site_id, customer_id, status):
    """Deactivation, not deletion — an Inactive Site (and its
    vpn_gateway_ip/camera_network) stays fully intact; a Company Admin
    can reactivate it later. Cameras already assigned to it are
    untouched (still connect exactly as before) — deactivating a Site
    only removes it from the Active-only picker Camera Management shows
    when adding/editing a camera."""

    if status not in ("Active", "Inactive"):
        return None, "Status must be Active or Inactive."

    with get_session() as session:
        site = session.scalar(select(Site).where(Site.site_id == site_id, Site.customer_id == customer_id))

        if site is None:
            return None, "Site not found."

        site.status = status

    return get_site(site_id, customer_id), None


# ==========================================
# User Access Management
# ==========================================
def get_site_access(site_id, customer_id):
    """Every User under this company, each tagged with whether they
    currently have access to this Site — the Manage Access modal's own
    shape, so the frontend never has to cross-reference two separate
    lists itself."""

    if get_site(site_id, customer_id) is None:
        return None, "Site not found."

    company_users = get_users_by_parent(customer_id)

    with get_session() as session:
        granted_user_ids = set(session.scalars(select(SiteUser.user_id).where(SiteUser.site_id == site_id)))

    users = [
        {"id": u["id"], "name": u["name"], "email": u["email"], "has_access": u["id"] in granted_user_ids}
        for u in company_users
    ]

    return {"site_id": site_id, "users": users}, None


def set_site_access(site_id, customer_id, user_ids):
    """Replaces this Site's full access list with exactly `user_ids` —
    same "replace, not merge" contract as auth.database.
    set_user_permissions. Every id is validated against THIS company's
    own Users first (never trusted blind — same reasoning as
    api/cameras.py's _validate_owner_user_id), so a tampered request can
    never grant a different company's User access to this Site."""

    if get_site(site_id, customer_id) is None:
        return None, "Site not found."

    if not isinstance(user_ids, list):
        return None, "User access must be provided as a list."

    company_user_ids = {u["id"] for u in get_users_by_parent(customer_id)}
    clean_ids = {uid for uid in user_ids if uid in company_user_ids}

    with get_session() as session:
        session.query(SiteUser).filter(SiteUser.site_id == site_id).delete()

        for user_id in clean_ids:
            session.add(SiteUser(
                site_id=site_id,
                user_id=user_id,
                created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            ))

    return get_site_access(site_id, customer_id)


def user_has_site_access(user_id, site_id):
    """Whether this User has been explicitly granted access to this
    Site (a SiteUser row exists) — the check a User's own camera create/
    update must pass for a submitted site_id before api/cameras.py's
    add_camera/update_camera ever sees it, so a User can never assign a
    camera to a Site they were never granted, even by guessing/
    incrementing a site_id."""

    with get_session() as session:
        return session.scalar(
            select(SiteUser.id).where(SiteUser.site_id == site_id, SiteUser.user_id == user_id)
        ) is not None


# ==========================================
# VPN / Gateway Reachability (WireGuard peer state)
# ==========================================
def _get_wireguard_peers(interface):
    """Every peer currently configured on this server's own WireGuard
    interface, via `sudo /usr/bin/wg show <interface> dump` — the same
    real, local kernel state `wg show` prints at a shell. `sudo` is
    required here because the Gunicorn service runs as the unprivileged
    `ubuntu` user, while reading WireGuard peer state needs root (the
    `wg` binary is invoked by its full, unambiguous path — never a bare
    `wg` — precisely so `sudo` can't be tricked by a malicious `wg`
    earlier on some future, differently-configured PATH). Returns a
    list of {"allowed_ips": [ipaddress network, ...], "latest_handshake":
    int} (unix timestamp, 0 = never handshaked). Never raises and never
    hangs the caller: a missing `wg`/`sudo` binary, a nonexistent
    interface, a sudoers rule that isn't configured, or a command that
    doesn't return within WG_COMMAND_TIMEOUT_SECONDS all resolve to an
    empty list, exactly like "no peer info available" — the caller then
    reports Offline rather than the request failing."""

    try:
        result = subprocess.run(
            ["sudo", "/usr/bin/wg", "show", interface, "dump"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=WG_COMMAND_TIMEOUT_SECONDS,
            text=True,
        )
    except Exception:
        return []

    if result.returncode != 0 or not result.stdout:
        return []

    # `wg show <iface> dump` output: the FIRST line describes the
    # interface itself (private-key, public-key, listen-port, fwmark) —
    # skipped here, this module never touches key material. Every line
    # after that is one peer, tab-separated: public-key, preshared-key,
    # endpoint, allowed-ips (comma-separated CIDRs), latest-handshake,
    # transfer-rx, transfer-tx, persistent-keepalive.
    peers = []

    for line in result.stdout.strip().splitlines()[1:]:
        fields = line.split("\t")

        if len(fields) < 5:
            continue

        try:
            latest_handshake = int(fields[4])
        except (TypeError, ValueError):
            latest_handshake = 0

        allowed_networks = []
        for cidr in fields[3].split(","):
            cidr = cidr.strip()
            if not cidr or cidr == "(none)":
                continue
            try:
                allowed_networks.append(ipaddress.ip_network(cidr, strict=False))
            except ValueError:
                continue

        peers.append({"allowed_ips": allowed_networks, "latest_handshake": latest_handshake})

    return peers


def _find_peer_for_site(peers, vpn_gateway_ip, camera_network):
    """The WireGuard peer that corresponds to this Site, matched by
    whether the Site's own vpn_gateway_ip (or, failing that,
    camera_network) falls inside one of that peer's configured
    AllowedIPs — the standard way a WireGuard peer's traffic scope is
    described, and the only link between "a Site row in this database"
    and "a peer entry in the kernel" this app has, since it never
    manages the tunnel config itself. Returns None if no configured
    peer matches (unmapped Site, wrong interface, or the gateway simply
    isn't a peer here)."""

    try:
        gateway_addr = ipaddress.ip_address((vpn_gateway_ip or "").strip())
    except ValueError:
        gateway_addr = None

    camera_net = None
    if camera_network:
        try:
            camera_net = ipaddress.ip_network(camera_network.strip(), strict=False)
        except ValueError:
            camera_net = None

    for peer in peers:
        for network in peer["allowed_ips"]:
            if gateway_addr is not None and gateway_addr in network:
                return peer
            if camera_net is not None and (network == camera_net or camera_net.overlaps(network)):
                return peer

    return None


def check_site_status(site_id, customer_id):
    """Refreshes vpn_status/vpn_last_checked for one Site from this
    server's own WireGuard peer state (see _get_wireguard_peers/
    _find_peer_for_site above) — "gateway/network reachability" derived
    from the tunnel's real handshake activity, not a synthetic probe.
    Online only when a matching peer exists AND its latest handshake is
    within WG_HANDSHAKE_STALE_SECONDS; a missing peer, a peer that has
    never handshaked (latest_handshake == 0), a stale handshake, or any
    failure reading `wg show` at all (see _get_wireguard_peers) all
    resolve to Offline — this function never raises, so a bad/absent
    WireGuard setup on this host degrades to "Offline" rather than
    breaking the Check Status action."""

    with get_session() as session:
        site = session.scalar(select(Site).where(Site.site_id == site_id, Site.customer_id == customer_id))

        if site is None:
            return None, "Site not found."

        gateway_ip = site.vpn_gateway_ip
        camera_network = site.camera_network

    reachable = False

    try:
        peers = _get_wireguard_peers(WG_INTERFACE)
        peer = _find_peer_for_site(peers, gateway_ip, camera_network)

        if peer is not None and peer["latest_handshake"] > 0:
            handshake_age_seconds = time.time() - peer["latest_handshake"]
            reachable = 0 <= handshake_age_seconds <= WG_HANDSHAKE_STALE_SECONDS
    except Exception:
        reachable = False

    with get_session() as session:
        site = session.scalar(select(Site).where(Site.site_id == site_id, Site.customer_id == customer_id))
        site.vpn_status = "online" if reachable else "offline"
        site.vpn_last_checked = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    return get_site(site_id, customer_id), None
