from sqlalchemy import (
    Column,
    Integer,
    Float,
    String,
    Text,
    ForeignKey,
    UniqueConstraint,
    Index,
    LargeBinary,
    Date,
    DateTime,
)
from sqlalchemy.orm import relationship
from db import Base

# Dates are stored as the same "%Y-%m-%d %H:%M:%S" strings the app has
# always produced/consumed (formatted in Python before insert, via
# datetime.now().strftime(...) at each call site) rather than native
# DATETIME columns — existing callers and the frontend already expect
# that exact string shape from every API response, and switching to a
# native type would silently change what gets serialized by jsonify().


def to_dict(obj):
    """Every query function returns plain dicts, not ORM instances —
    matches the exact `dict(sqlite3.Row)` shape every existing caller
    (api/*.py, the frontend via jsonify) already expects."""

    if obj is None:
        return None

    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    email = Column(String(255), nullable=False, unique=True)
    password = Column(String(255), nullable=False)
    role = Column(String(30), nullable=False, default="User")
    status = Column(String(20), nullable=False, default="Active")
    created_at = Column(String(30), nullable=False)
    username = Column(String(100), unique=True, nullable=True)
    avatar_path = Column(String(255), nullable=True)
    phone_number = Column(String(30), nullable=True)

    # NULL for Super Admin and Company Admin rows; set to the owning
    # Company Admin's own id for a User row. See auth.auth.get_tenant_id
    # — this is the real hierarchy link "Super Admin -> Company Admin ->
    # Users" is built on, replacing the old single-login-per-company model.
    parent_admin_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)

    # Server-side session revocation (Phase 2 security hardening). Bumped
    # whenever a stolen/old session cookie must stop working immediately —
    # password changed/reset, account disabled, or an explicit "log out of
    # all other sessions" — without waiting for the cookie's own 7-day
    # PERMANENT_SESSION_LIFETIME to expire. The session cookie carries the
    # version it was issued with (see auth.auth.get_current_user); any
    # mismatch against this column means that cookie is stale and is
    # treated as logged out. See auth.database.bump_session_version.
    session_version = Column(Integer, nullable=False, default=1)

    # Camera Limit / Camera Quota Management. One column, two hierarchy
    # levels, reused rather than duplicated (see api/camera_quota.py):
    #   - On a Company Admin's own row: the Super Admin's cap on that
    #     company's TOTAL cameras (api/admin_overview.py's Admin Camera
    #     Limit).
    #   - On a User row: that User's own Company Admin's cap on how many
    #     of the company's cameras this one User may own
    #     (api/company_users.py's Per-User Camera Limit) — constrained to
    #     never let the SUM of all User limits under one Company Admin
    #     exceed that Admin's own camera_limit (see
    #     api/camera_quota.py's validate_user_camera_limit).
    # Meaningless on a Super Admin row (never read/written for one).
    # NULL = unlimited — same "absent means no enforcement" convention as
    # Subscription.storage_limit_gb, so no existing Admin/User is
    # suddenly capped until someone explicitly sets a number. Actual
    # usage is NEVER stored here or anywhere else — always computed live
    # from real Camera rows (api/cameras.py's get_camera_counts), so a
    # deleted/reassigned camera is instantly reflected with nothing to
    # keep in sync.
    camera_limit = Column(Integer, nullable=True)


class Permission(Base):
    __tablename__ = "permissions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    module_key = Column(String(60), nullable=False, unique=True)
    module_label = Column(String(120), nullable=False)


class UserPermission(Base):
    __tablename__ = "user_permissions"
    __table_args__ = (UniqueConstraint("user_id", "permission_id"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    permission_id = Column(Integer, ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False)


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=True)
    user_name = Column(String(100), nullable=False)
    action = Column(String(120), nullable=False)
    details = Column(Text, nullable=True)
    created_at = Column(String(30), nullable=False)
    # Phase 2 security audit trail — additive columns on the SAME table
    # every existing log_activity() call site already writes to, rather
    # than a parallel table. All nullable so every pre-existing row (and
    # every existing log_activity() caller that doesn't pass these) stays
    # valid untouched — see auth.database.log_activity's new optional
    # kwargs and log_security_event. Never populated with a secret,
    # token, password, RTSP URL, or biometric value — see
    # error_logging.sanitize_sensitive_url, used wherever a `details`
    # value could conceivably contain one.
    target_type = Column(String(40), nullable=True)  # e.g. "user" | "camera" | "registered_person"
    target_id = Column(Integer, nullable=True)
    success = Column(Integer, nullable=False, default=1)  # 1 = success, 0 = failure/denied
    ip_address = Column(String(64), nullable=True)
    company_id = Column(Integer, nullable=True)  # tenant id (get_tenant_id) when applicable


class Camera(Base):
    __tablename__ = "cameras"

    camera_id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    camera_name = Column(String(120), nullable=False)
    camera_ip = Column(String(60), nullable=False)
    # Security fix: this column USED TO hold the full, credential-bearing
    # RTSP connection string (rtsp://user:pass@ip:port/path) in plaintext
    # — right next to password_encrypted below, which defeated that
    # column's own encryption for anyone with DB/backup read access. It
    # now stores only a SANITIZED, credential-free display string (see
    # error_logging.sanitize_sensitive_url) — informational only, never
    # used to actually connect. The real, authenticated URL is rebuilt in
    # memory only, at the moment a connection is actually needed, from
    # camera_ip/username/password_encrypted/port/channel_number/brand/
    # stream_quality (or custom_rtsp_url_encrypted below for brand=
    # "custom") — see api/cameras.py's _resolve_connection_url().
    rtsp_url = Column(Text, nullable=False)
    # Security fix, same reasoning as rtsp_url above: Custom RTSP is the
    # one brand whose connection URL isn't derivable from the other
    # columns (camera_ip/username/password/port/channel/stream_quality
    # are still collected for it, but build_rtsp_url() ignores them and
    # returns this URL as typed) — so unlike every other brand, the
    # credential-bearing value here has nowhere else to live. Encrypted
    # the same way password_encrypted is (api/camera_crypto.py, Fernet),
    # NULL for every brand other than "custom".
    custom_rtsp_url_encrypted = Column(Text, nullable=True)
    camera_location = Column(String(120), nullable=True)
    status = Column(String(20), nullable=False, default="Offline")
    created_at = Column(String(30), nullable=False)
    username = Column(String(100), nullable=True)
    password_encrypted = Column(Text, nullable=True)
    channel_number = Column(Integer, nullable=True)
    brand = Column(String(60), nullable=True)
    port = Column(Integer, nullable=True)
    last_connected_time = Column(String(30), nullable=True)
    # Company Admin's own on/off switch for the 24/7 AI Detection Engine
    # (see camera/detection_service.py) — independent of `status`, which
    # is a live CONNECTIVITY reading (Online/Offline), not something a
    # user sets directly. A camera can be reachable (status=Online) but
    # have detection deliberately paused, or briefly unreachable
    # (status=Offline) while still enabled and auto-retrying.
    detection_enabled = Column(Integer, nullable=False, default=1)
    # Per-User Data Isolation: which User (role=ROLE_USER, under this
    # same Company Admin) this camera is assigned to. NULL = unassigned,
    # visible only to the Company Admin (never to any User) until
    # explicitly assigned via Camera Management. SET NULL (not CASCADE)
    # — deleting a User must orphan their cameras back to "Unassigned",
    # never delete the camera or its attendance/unknown-person history.
    # Attendance/UnknownPerson rows captured by this camera inherit this
    # same owner_user_id at the moment they're written (see
    # attendance/attendance.py, face/unknown_manager.py) — this is the
    # single source of truth every other per-User ownership derives from.
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    # Per-Camera Quality Selection: which of the camera's own stream
    # profiles to pull ("480p"/"720p"/"1080p") — see api/cameras.py's
    # build_rtsp_url() for how this maps to an actual RTSP URL (brand-
    # dependent: distinct main/sub endpoints for some brands, a same-URL
    # + camera-side ISAPI resolution change for Hikvision's 720p/1080p,
    # since that brand only exposes two distinct RTSP endpoints).
    # Default "1080p" matches every existing camera's pre-this-feature
    # behavior exactly (always the main/full-resolution stream).
    stream_quality = Column(String(10), nullable=False, default="1080p")
    # Site / VPN Gateway Management: which Site (network/access grouping
    # — see Site below) this camera belongs to. NULL = no Site assigned
    # (every camera created before this feature, or a company that never
    # uses Sites at all) — the RTSP connection flow never reads this
    # column, so a NULL value changes nothing about how a camera
    # actually connects (see api/cameras.py's _resolve_connection_url,
    # untouched by this feature). SET NULL (not CASCADE) — deleting a
    # Site must orphan its cameras back to "No Site", never delete the
    # camera itself.
    site_id = Column(Integer, ForeignKey("sites.site_id", ondelete="SET NULL"), nullable=True, index=True)


class Site(Base):
    """Site / VPN Gateway Management. A Site is purely a network/access
    grouping this app records — the real WireGuard tunnel between this
    backend's network and the Site's remote camera network runs entirely
    at infrastructure level (see the module's own docstring in
    api/sites.py); nothing here opens, configures, or manages a tunnel.
    `vpn_gateway_ip`/`camera_network` are informational metadata a
    Company Admin fills in to describe an already-working VPN link, not
    values this app dials out to establish. Never stores a WireGuard
    PRIVATE key — see vpn_public_key's own comment below."""

    __tablename__ = "sites"

    site_id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    site_name = Column(String(120), nullable=False)
    # The WireGuard gateway's tunnel-side address (e.g. "10.50.0.2") —
    # informational only; nothing in this app connects to this address.
    vpn_gateway_ip = Column(String(60), nullable=False)
    # Optional CIDR describing the Site's remote camera subnet (e.g.
    # "192.168.1.0/24") — display/documentation only, never enforced
    # against a camera's own camera_ip at connection time.
    camera_network = Column(String(60), nullable=True)
    # The WireGuard gateway's PUBLIC key — safe to store in plaintext,
    # unlike a private key (which this app must NEVER be asked for, see
    # api/sites.py's validation). Optional: a Site can be recorded before
    # the gateway's own key material is known.
    vpn_public_key = Column(Text, nullable=True)
    # "unknown" | "online" | "offline" — last-known reachability of
    # vpn_gateway_ip, refreshed only when a Company Admin explicitly
    # clicks "Check Status" (api/sites.py's check_site_status). Never
    # updated by a background job and never affects the camera RTSP
    # connection flow.
    vpn_status = Column(String(20), nullable=False, default="unknown")
    vpn_last_checked = Column(String(30), nullable=True)
    # "Active" | "Inactive" — a Company Admin's own on/off switch for the
    # Site (deactivation, not deletion). Same string-based convention as
    # Camera.status/User.status elsewhere in this file.
    status = Column(String(20), nullable=False, default="Active")
    created_at = Column(String(30), nullable=False)


class SiteUser(Base):
    """Which Users (role=ROLE_USER) may access one Site — a plain
    many-to-many association, same shape/purpose as UserPermission above
    but for Site access instead of module access. A User with no row
    here for a given site_id simply never sees that Site (see
    api/sites.py's get_sites_for_customer)."""

    __tablename__ = "site_users"
    __table_args__ = (UniqueConstraint("site_id", "user_id"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    site_id = Column(Integer, ForeignKey("sites.site_id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(String(30), nullable=False)


class NormalCamera(Base):
    """The "Normal Camera" page's own record — a plain metadata registry
    entry (name/location/assigned User/description), deliberately NOT
    the same table as Camera above. It has no camera_ip, rtsp_url,
    brand, credentials, status, or detection_enabled, and no worker
    thread in camera/detection_service.py is ever started for one — no
    RTSP connection, no live preview, no AI detection, exactly per that
    page's spec. Same per-company/per-User shape as Camera for
    consistency (customer_id = the owning company, owner_user_id = the
    optionally-assigned User), but otherwise fully independent."""

    __tablename__ = "normal_cameras"

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    camera_name = Column(String(120), nullable=False)
    camera_location = Column(String(120), nullable=False)
    description = Column(Text, nullable=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(String(30), nullable=False)


class AppSetting(Base):
    __tablename__ = "app_settings"

    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=False)


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=True)


class CustomerAiSetting(Base):
    __tablename__ = "customer_ai_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    face_recognition_enabled = Column(Integer, nullable=False, default=1)
    registered_detection_enabled = Column(Integer, nullable=False, default=1)
    unknown_detection_enabled = Column(Integer, nullable=False, default=1)
    save_unknown_persons = Column(Integer, nullable=False, default=1)
    attendance_enabled = Column(Integer, nullable=False, default=1)
    unknown_alerts_enabled = Column(Integer, nullable=False, default=1)
    # Company Admin -> AI Settings (Final Production Readiness). Every
    # value below was previously a hardcoded module constant in
    # face/recognizer.py, face/quality.py, attendance/attendance.py, and
    # face/unknown_manager.py — now per-company, DB-backed, and editable
    # without a code change. face_quality_enabled/tracking_enabled are
    # additional toggles alongside the pipeline-stage ones above.
    recognition_threshold = Column(Float, nullable=False, default=0.50)
    min_face_size = Column(Integer, nullable=False, default=32)
    blur_threshold = Column(Float, nullable=False, default=25.0)
    brightness_min = Column(Float, nullable=False, default=25.0)
    brightness_max = Column(Float, nullable=False, default=235.0)
    max_yaw = Column(Float, nullable=False, default=60.0)
    max_roll = Column(Float, nullable=False, default=45.0)
    attendance_cooldown_seconds = Column(Integer, nullable=False, default=5)
    unknown_duplicate_threshold = Column(Float, nullable=False, default=0.50)
    face_quality_enabled = Column(Integer, nullable=False, default=1)
    tracking_enabled = Column(Integer, nullable=False, default=1)
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=False)


class Subscription(Base):
    __tablename__ = "subscriptions"

    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    plan_name = Column(String(60), nullable=False, default="Free")
    status = Column(String(20), nullable=False, default="Trial")
    amount = Column(Float, nullable=False, default=0)
    billing_cycle = Column(String(20), nullable=False, default="Monthly")
    next_due_date = Column(String(30), nullable=True)
    notes = Column(Text, nullable=True)
    # Admin & User Overview: Super-Admin-set cap on this company's real,
    # measured storage (api/billing.py's get_storage_usage_gb). NULL =
    # unlimited — no company has a limit until a Super Admin explicitly
    # sets one here, same "absent means no enforcement" default as
    # BillableItem's Storage catalog line (which stays a purely
    # record_only billed item, unaffected by this).
    storage_limit_gb = Column(Float, nullable=True)
    updated_at = Column(String(30), nullable=False)


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    amount = Column(Float, nullable=False)
    method = Column(String(60), nullable=True)
    note = Column(Text, nullable=True)
    paid_on = Column(String(30), nullable=False)
    created_at = Column(String(30), nullable=False)
    # Added for the checkout flow (api/billing.py) — nullable so every
    # pre-existing, manually-logged Payment row (Super Admin's Log
    # Payment modal, api/subscriptions.py:add_payment) stays valid
    # untouched; only checkout()-created rows populate these.
    billing_cycle = Column(String(20), nullable=True)
    status = Column(String(20), nullable=False, default="Success")
    transaction_id = Column(String(64), nullable=True, unique=True)
    # subtotal + tax_amount == amount for a checkout()-created payment;
    # both NULL on a manual Super Admin entry (no tax concept there).
    subtotal = Column(Float, nullable=True)
    tax_amount = Column(Float, nullable=True)


class BillableItem(Base):
    """The Super-Admin-owned billing catalog — every line a Company
    Admin can buy on the checkout page. Deliberately general (not
    module-specific) so Super Admin has real CRUD over categories
    beyond the original module catalog (Camera/Hardware, Storage,
    Hosting, Notifications) per the project-wide billing requirement —
    but `activation_type`/`activation_ref` tie each item back to a REAL
    mechanism already in this codebase (module grant, a real
    NotificationSettings toggle, or nothing at all for a pure
    usage/flat line) rather than inventing new enforcement."""

    __tablename__ = "billable_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    item_key = Column(String(80), nullable=False, unique=True)
    category = Column(String(60), nullable=False)
    name = Column(String(120), nullable=False)
    description = Column(Text, nullable=True)
    # "flat" (one price regardless of usage) | "per_camera" | "per_gb" —
    # the latter two are billed against this company's REAL, live-
    # measured usage (api/billing.py's get_storage_usage_gb / the
    # existing get_camera_counts_by_customer), never a client-supplied
    # quantity.
    unit_type = Column(String(20), nullable=False, default="flat")
    monthly_price = Column(Float, nullable=False, default=0)
    yearly_price = Column(Float, nullable=False, default=0)
    # Display-only hint for the Super Admin's own pricing page (e.g.
    # "this yearly price is a 20% discount vs. 12x monthly") — yearly_price
    # itself is still what's actually charged; this is never computed from.
    yearly_discount_percent = Column(Float, nullable=True)
    enabled = Column(Integer, nullable=False, default=1)
    display_order = Column(Integer, nullable=False, default=0)
    # What buying this item actually does — see api/billing.py:checkout().
    # "module": activation_ref is a module_key -> grants access via the
    #   existing auth.database.set_user_permissions.
    # "setting_flag": activation_ref is a NotificationSettings boolean
    #   column name -> flips it via the existing
    #   update_unknown_alert_settings/update_daily_report_settings.
    # "record_only": nothing to activate — an honest billed line with no
    #   corresponding enforcement anywhere in the product (Camera/
    #   Hardware, Storage, Hosting — none of these have a real limit to
    #   unlock today).
    activation_type = Column(String(20), nullable=False, default="record_only")
    activation_ref = Column(String(80), nullable=True)
    updated_at = Column(String(30), nullable=False)


class BillingConfig(Base):
    """Singleton row (id is always 1) — platform-wide optional tax/
    charges percentage, Super-Admin-configured. Absent/0 means no tax
    line is ever shown or charged."""

    __tablename__ = "billing_config"

    id = Column(Integer, primary_key=True)
    tax_percent = Column(Float, nullable=False, default=0)
    updated_at = Column(String(30), nullable=False)


class BillableItemPriceOverride(Base):
    """One company's custom Monthly/Yearly price for one billable item —
    an override on top of BillableItem's own global price, never a
    replacement for it. No row here for a given (customer_id, item_key)
    means that company simply pays the global price, exactly like
    before this table existed; a row here affects ONLY that one
    company (api/billing.py's effective-price resolution always looks
    up by this exact customer_id, never leaks into any other
    company's checkout). The catalog item itself (name, category,
    description, unit type, enabled/disabled) stays global — only
    price is ever company-specific."""

    __tablename__ = "billable_item_price_overrides"
    __table_args__ = (UniqueConstraint("customer_id", "item_key"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_key = Column(String(80), nullable=False)
    monthly_price = Column(Float, nullable=False)
    yearly_price = Column(Float, nullable=False)
    yearly_discount_percent = Column(Float, nullable=True)
    updated_at = Column(String(30), nullable=False)


class BillableItemAccess(Base):
    """Super Admin's per-company ON/OFF lock for one non-module billable
    item (Additional Camera, Platform Hosting, WhatsApp Daily Report,
    WhatsApp Unknown Person Alerts, Cloud Storage, or any future
    non-module catalog item) — mirrors module grant/lock semantics
    (auth.database's user_permissions) for the five items that have no
    permission-grant mechanism of their own. No row for a given
    (customer_id, item_key) means ON/unlocked — every existing
    company's behavior is unaffected until a Super Admin explicitly
    locks one. See api/billing.py's set_item_access()."""

    __tablename__ = "billable_item_access"
    __table_args__ = (UniqueConstraint("customer_id", "item_key"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_key = Column(String(80), nullable=False)
    enabled = Column(Integer, nullable=False, default=1)
    updated_at = Column(String(30), nullable=False)


class SubscriptionItem(Base):
    """This company's currently-purchased item set — the billing truth
    the checkout page pre-populates from, separate from UserPermission/
    NotificationSettings (the actual activation, which checkout() also
    writes to). `unit_price`/`price` are frozen at purchase time so a
    later Super Admin price change never rewrites what this company
    already agreed to pay."""

    __tablename__ = "subscription_items"
    __table_args__ = (UniqueConstraint("customer_id", "item_key"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_key = Column(String(80), nullable=False)
    quantity = Column(Float, nullable=False, default=1)
    unit_price = Column(Float, nullable=False)
    price = Column(Float, nullable=False)
    billing_cycle = Column(String(20), nullable=False)


class PaymentItem(Base):
    """Line-item breakdown for one Payment row — item_name is
    duplicated (not re-joined from billable_items) so payment history
    stays accurate even if an item is ever renamed or deleted later."""

    __tablename__ = "payment_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    payment_id = Column(Integer, ForeignKey("payments.id", ondelete="CASCADE"), nullable=False)
    item_key = Column(String(80), nullable=False)
    item_name = Column(String(120), nullable=False)
    quantity = Column(Float, nullable=False, default=1)
    unit_price = Column(Float, nullable=False)
    price = Column(Float, nullable=False)


# ==============================================================
# Registered Persons / Attendance / Unknown Persons / Reports
# ==============================================================
# Face images and report CSV files stay on the filesystem exactly where
# they always have (dataset/customers/<id>/..., attendance/customers/<id>/...)
# — only structured metadata and embeddings live here. Embeddings are raw
# float32 bytes (see face/embedding_codec.py), never pickle.
#
# customer_id vs admin_id: this app currently has exactly one Company
# Admin per company (no multi-admin-per-company model), so admin_id is
# always the same value as customer_id today — both resolve from the
# same auth.auth.get_tenant_id(current_user) call. The column exists so
# a future multi-admin-per-company model doesn't need another migration.


class RegisteredPerson(Base):
    __tablename__ = "registered_persons"
    __table_args__ = (UniqueConstraint("customer_id", "person_name", name="uq_registered_person_per_customer"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    admin_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    person_name = Column(String(100), nullable=False)
    employee_id = Column(String(30), nullable=True, index=True)
    # department/phone_number/email are real columns per spec, but the
    # existing Add/Edit Person form doesn't collect them yet and isn't
    # being touched here — they stay NULL until a future frontend change
    # populates them.
    department = Column(String(100), nullable=True)
    phone_number = Column(String(30), nullable=True)
    email = Column(String(255), nullable=True, index=True)
    # All of this person's quality-passing embeddings, flattened into one
    # (N, 512) float32 blob — see face/embedding_codec.py.
    face_embedding = Column(LargeBinary, nullable=True)
    face_image_path = Column(String(255), nullable=True)
    status = Column(String(20), nullable=False, default="Incomplete")
    created_at = Column(String(30), nullable=False, index=True)
    updated_at = Column(String(30), nullable=False)
    # Per-User Data Isolation — see Camera.owner_user_id above for the
    # full rationale. Registered Faces aren't captured by a camera event
    # (uploaded independently), so this is explicitly assigned by the
    # Company Admin at registration time (optional, NULL = unassigned)
    # rather than derived. Distinct from `admin_id` above, which is a
    # dead placeholder reserved for a different, still-hypothetical
    # multi-admin-per-company model — do not conflate the two.
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    attendance_records = relationship("Attendance", back_populates="person", cascade="all, delete-orphan")


class Attendance(Base):
    __tablename__ = "attendance"
    # Composite index matching the actual hot-path predicate: every
    # attendance/report query (api/attendance.py's _attendance_rows_matching,
    # api/reports.py's get_reports) filters WHERE customer_id = ? AND
    # attendance_date [= or range] — the single-column indexes below on
    # customer_id and attendance_date individually only let MySQL/InnoDB
    # use ONE of them per lookup (or an index merge), not a true seek on
    # both together. Additive only — every existing single-column index
    # stays exactly as it was; this is a new index alongside them, not a
    # replacement.
    __table_args__ = (Index("ix_attendance_customer_date", "customer_id", "attendance_date"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    admin_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    person_id = Column(Integer, ForeignKey("registered_persons.id", ondelete="CASCADE"), nullable=False, index=True)
    camera_id = Column(Integer, ForeignKey("cameras.camera_id", ondelete="SET NULL"), nullable=True, index=True)
    attendance_date = Column(Date, nullable=False, index=True)
    check_in = Column(DateTime, nullable=True)
    check_out = Column(DateTime, nullable=True)
    working_hours = Column(Float, nullable=True)
    attendance_status = Column(String(20), nullable=False, default="Present")
    created_at = Column(String(30), nullable=False, index=True)
    # Per-User Data Isolation — auto-derived from Camera.owner_user_id at
    # the moment this row is created (see attendance/attendance.py's
    # mark_attendance); never recomputed afterward, even if the camera's
    # assignment changes later. NULL when camera_id is NULL/unassigned.
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    person = relationship("RegisteredPerson", back_populates="attendance_records")


class UnknownPerson(Base):
    __tablename__ = "unknown_persons"
    # Same reasoning as Attendance.__table_args__ above — every unknown-
    # person analytics query (api/unknown_analytics.py's
    # _unique_days_seen) filters WHERE customer_id = ? AND detected_time
    # [range]. Additive only — existing single-column indexes unchanged.
    __table_args__ = (Index("ix_unknown_persons_customer_detected", "customer_id", "detected_time"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    camera_id = Column(Integer, ForeignKey("cameras.camera_id", ondelete="SET NULL"), nullable=True, index=True)
    image_path = Column(String(255), nullable=True)
    # frame_image_path/last_seen/detection_count are additions beyond the
    # literal spec — required because the existing GET /unknown-persons
    # response already returns frame_image/last_seen/detection_count and
    # the frontend consumes them; dropping them would break "frontend
    # requires zero modifications".
    frame_image_path = Column(String(255), nullable=True)
    embedding = Column(LargeBinary, nullable=True)
    detected_time = Column(String(30), nullable=False, index=True)
    last_seen = Column(String(30), nullable=False)
    detection_count = Column(Integer, nullable=False, default=1)
    location = Column(String(120), nullable=True)
    confidence = Column(Float, nullable=True)
    created_at = Column(String(30), nullable=False, index=True)
    # Per-User Data Isolation — same derivation rule as Attendance.owner_user_id above.
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (UniqueConstraint("customer_id", "file_path", name="uq_report_per_customer_file"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    report_type = Column(String(50), nullable=False, default="daily_attendance")
    report_name = Column(String(200), nullable=False)
    generated_by = Column(String(100), nullable=False, default="System")
    generated_at = Column(String(30), nullable=False, index=True)
    file_path = Column(String(255), nullable=True)
    status = Column(String(20), nullable=False, default="Generated")
    # Report rows deliberately stay company-wide (no owner_user_id) —
    # the daily snapshot itself isn't split per User; only the live
    # present/absent numbers rendered from it (api/reports.py) are
    # scope-filtered on read.


# ==============================================================
# Notifications (Per-User Data Isolation)
# ==============================================================
# Brand new table — no ALTER TABLE migration needed, Base.metadata.
# create_all() (called from auth.database.init_db()) creates it the
# first time the app boots against a DB that doesn't have it yet, same
# as every other model here.
class Notification(Base):
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # NULL = belongs to the company's "Unassigned" bucket (e.g. an
    # offline alert from a camera nobody's been assigned yet) — visible
    # to the Company Admin only, same rule as every other table above.
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    camera_id = Column(Integer, ForeignKey("cameras.camera_id", ondelete="SET NULL"), nullable=True, index=True)
    type = Column(String(40), nullable=False)  # "unknown_person" | "camera_offline"
    message = Column(Text, nullable=False)
    is_read = Column(Integer, nullable=False, default=0)
    created_at = Column(String(30), nullable=False, index=True)


# ==============================================================
# Admin-Controlled Notification & Reporting Layer
# ==============================================================
# Entirely independent of the AI detection pipeline above — nothing in
# unknown_persons/attendance/cameras is read or written by this section
# except by reference (related_unknown_id/related_camera_id below are
# informational FKs, never joined back into detection logic). See
# notifications/ and reports/ (new top-level packages, sibling to api/
# auth/camera/face/attendance) for the actual business logic that reads
# and writes these tables.


class NotificationSettings(Base):
    """One row per company (Company Admin's own customer_id) — the
    Admin Settings > Notifications & Reports page this whole feature
    adds. Lazily provisioned with defaults the first time it's read,
    same pattern as CustomerAiSetting._fetch_or_create."""

    __tablename__ = "notification_settings"

    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)

    # --- Unknown Person Alerts ---
    unknown_alert_enabled = Column(Integer, nullable=False, default=0)
    unknown_alert_recipient = Column(String(30), nullable=True)
    unknown_alert_template = Column(Text, nullable=True)  # NULL = use the built-in approved template
    unknown_alert_send_image = Column(Integer, nullable=False, default=1)
    unknown_alert_min_confidence = Column(Float, nullable=False, default=0.0)
    unknown_alert_cooldown_minutes = Column(Integer, nullable=False, default=5)
    unknown_alert_dedup_enabled = Column(Integer, nullable=False, default=1)

    # --- Daily Report ---
    daily_report_enabled = Column(Integer, nullable=False, default=0)
    daily_report_time = Column(String(5), nullable=False, default="18:30")  # 24h "HH:MM"
    daily_report_recipient = Column(String(30), nullable=True)
    daily_report_format = Column(String(20), nullable=False, default="pdf")
    daily_report_include_pdf = Column(Integer, nullable=False, default=1)
    daily_report_include_attendance_summary = Column(Integer, nullable=False, default=1)
    daily_report_include_person_wise = Column(Integer, nullable=False, default=1)
    daily_report_include_entry_exit = Column(Integer, nullable=False, default=1)
    daily_report_include_unknown_events = Column(Integer, nullable=False, default=1)
    daily_report_include_camera_status = Column(Integer, nullable=False, default=1)
    daily_report_include_detection_stats = Column(Integer, nullable=False, default=1)

    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=False)


class RetentionSettings(Base):
    """One row per company (Company Admin's own customer_id) —
    Super-Admin-only Data Retention policy (Admin & User Overview page).
    Governs how long CAPTURED/GENERATED data is kept before
    retention/scheduler.py's daily sweep deletes it: Unknown Person
    detections (row + face/frame images), generated Daily Report PDFs
    (ReportLog + file), and generated Attendance CSV exports (Report +
    file). Deliberately never covers Registered Person enrollment faces,
    the Attendance check-in/check-out table itself, User/permission/
    module/billing data, or the Company Admin account — those are never
    touched by this policy regardless of the setting.

    "permanent" (this table's default AND the default for a company
    with no row at all, via api/retention_settings.py's lazy
    provisioning) disables automatic deletion entirely — same
    "absent/default means no enforcement" convention as Subscription.
    storage_limit_gb, deliberately chosen so no existing company's data
    is ever auto-deleted until a Super Admin explicitly opts them in."""

    __tablename__ = "retention_settings"

    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    # "permanent" | "7_days" | "1_month" — see api/retention_settings.py's
    # VALID_POLICIES/RETENTION_DAYS.
    policy = Column(String(20), nullable=False, default="permanent")
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=False)


class NotificationLog(Base):
    """One row per attempted notification send (currently: Unknown
    Person Alerts only — Daily Report delivery has its own ReportLog
    below, since it's a report artifact first and a notification
    second). Written exclusively by notifications/service.py, never by
    the detection pipeline directly."""

    __tablename__ = "notification_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    type = Column(String(40), nullable=False)  # "unknown_person_alert"
    recipient = Column(String(30), nullable=True)
    template_name = Column(String(80), nullable=True)
    related_unknown_id = Column(Integer, ForeignKey("unknown_persons.id", ondelete="SET NULL"), nullable=True, index=True)
    related_camera_id = Column(Integer, ForeignKey("cameras.camera_id", ondelete="SET NULL"), nullable=True, index=True)
    # NULL = sent to the company-level fallback recipient (Admin
    # Settings > Notifications & Reports); set = routed to this specific
    # User's own WhatsApp number (User Management > WhatsApp & Reports).
    # See notifications/service.py's recipient-resolution rule.
    related_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    status = Column(String(20), nullable=False, default="Pending")  # Pending | Sent | Failed
    provider = Column(String(40), nullable=False, default="whatsapp")
    error_message = Column(Text, nullable=True)
    created_at = Column(String(30), nullable=False, index=True)
    sent_at = Column(String(30), nullable=True)


class ReportLog(Base):
    """One row per generated Daily Report — created the moment the PDF
    is written, then updated in place once WhatsApp delivery (if
    enabled) succeeds or fails. Presence of a row for (customer_id,
    user_id, report_date) is also the scheduler's own
    duplicate-generation guard (see reports/daily_report.py)."""

    __tablename__ = "report_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # NULL = the company-wide report (all Users pooled, sent to the
    # company-level recipient) — unchanged from this feature's first
    # version. Set = a personalized report scoped to exactly this User's
    # own data (owner_user_id), sent to their own WhatsApp number (User
    # Management > WhatsApp & Reports).
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    report_date = Column(String(10), nullable=False, index=True)  # "DD-MM-YYYY"
    file_path = Column(String(255), nullable=True)
    recipient = Column(String(30), nullable=True)
    status = Column(String(20), nullable=False, default="Pending")  # Pending | Generated | Sent | Failed | Skipped
    error_message = Column(Text, nullable=True)
    created_at = Column(String(30), nullable=False, index=True)
    sent_at = Column(String(30), nullable=True)


class UserNotificationSettings(Base):
    """Per-User WhatsApp & Reports — User Management > Add/Edit User.
    One row per User (role=User), entirely independent of both
    NotificationSettings above (the company-wide defaults/fallback) and
    every other User's row: editing one User's WhatsApp number/toggles
    can never affect another's, since every read/write here is scoped by
    this exact user_id.

    Only ever created/edited by that User's own Company Admin, through
    api/company_users.py's ownership-checked routes — never a
    freestanding account of its own, per this feature's explicit "do not
    create a separate user system" instruction."""

    __tablename__ = "user_notification_settings"

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    whatsapp_number = Column(String(30), nullable=True)
    unknown_alert_enabled = Column(Integer, nullable=False, default=0)
    send_unknown_image = Column(Integer, nullable=False, default=1)
    # Daily Unknown Person Count — fully independent of
    # unknown_alert_enabled above (a per-detection alert) and of
    # daily_report_enabled below (the full PDF report): just a WhatsApp
    # text message with that day's confirmed/saved unknown-person count
    # for this User, scheduled at this same row's daily_report_time (no
    # time field of its own — see reports/daily_report.py's
    # send_daily_unknown_count).
    daily_unknown_count_enabled = Column(Integer, nullable=False, default=0)
    daily_report_enabled = Column(Integer, nullable=False, default=0)
    daily_report_time = Column(String(5), nullable=False, default="18:30")  # 24h "HH:MM"
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=False)
