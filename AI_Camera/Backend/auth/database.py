import os
import secrets
from datetime import datetime

from flask import has_request_context, request
from sqlalchemy import select, func, text
from sqlalchemy.exc import IntegrityError
from werkzeug.security import generate_password_hash

from db import Base, engine, get_session
from auth.models import User, Permission, UserPermission, ActivityLog, to_dict

# ==============================
# Paths
# ==============================
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUTH_FOLDER = os.path.join(BASE_DIR, "auth")

# Retained only as the SQLite source path for scripts/migrate_sqlite_to_mysql.py
# — the app itself no longer reads or writes this file.
DB_FILE = os.path.join(AUTH_FOLDER, "users.db")
SECRET_KEY_FILE = os.path.join(AUTH_FOLDER, "secret.key")

# Where a freshly generated seed account's one-time password is written
# (see _generate_seed_password/_record_seed_credential below) — never
# printed to stdout/logs, and never served by any Flask route (this
# folder is not under dataset/ or any other static-file path). Delete
# this file once the printed accounts have been logged into and their
# passwords rotated.
INITIAL_CREDENTIALS_FILE = os.path.join(AUTH_FOLDER, "initial_credentials.txt")

ROLE_SUPER_ADMIN = "Super Admin"
ROLE_COMPANY_ADMIN = "Company Admin"
ROLE_USER = "User"

# Seeded automatically whenever no user with this email exists yet. The
# password itself is never hardcoded (see _generate_seed_password) — a
# fixed, well-known default across every install is a standing account-
# takeover risk, so each fresh deployment gets its own random one-time
# password instead.
DEFAULT_ADMIN_NAME = "Super Admin"
DEFAULT_ADMIN_EMAIL = "admin@aicamera.com"

# Default Company Admin + one User under it — seeded the same
# idempotent way (only if DEFAULT_COMPANY_ADMIN_EMAIL doesn't already
# exist), so every fresh MySQL database has one working example of the
# full Super Admin -> Company Admin -> User hierarchy immediately.
DEFAULT_COMPANY_ADMIN_NAME = "Default Company"
DEFAULT_COMPANY_ADMIN_EMAIL = "admin@company.com"
DEFAULT_COMPANY_ADMIN_USERNAME = "companyadmin"

DEFAULT_USER_NAME = "Default User"
DEFAULT_USER_EMAIL = "user@company.com"
DEFAULT_USER_USERNAME = "defaultuser"
# The 4 modules a User is allowed at all — mirrors
# api.company_users.GRANTABLE_USER_MODULE_KEYS exactly.
DEFAULT_USER_MODULE_KEYS = ("dashboard", "live_camera", "attendance", "reports")


def _generate_seed_password():
    """A cryptographically random one-time password for a freshly seeded
    account (32 hex chars, generated via secrets.token_hex, standard
    library CSPRNG). Replaces a fixed, hardcoded default that would
    otherwise be identical — and guessable — across every fresh
    deployment of this project."""

    return secrets.token_hex(16)


def _record_seed_credential(label, email, password):
    """Writes a freshly generated seed account's one-time password to
    INITIAL_CREDENTIALS_FILE — local disk only, never stdout/any log
    sink. Appends rather than overwrites, so a single fresh-install run
    that seeds all three default accounts keeps every one of them."""

    os.makedirs(AUTH_FOLDER, exist_ok=True)

    with open(INITIAL_CREDENTIALS_FILE, "a", encoding="utf-8") as file:
        file.write(
            f"{label}\n"
            f"Email: {email}\n"
            f"Password: {password}\n"
            f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            "Change this password after first login, then delete this file.\n\n"
        )

    restrict_file_permissions(INITIAL_CREDENTIALS_FILE)

# Assignable modules — one entry per Company Admin sidebar page (11
# pages), plus the pre-existing "Registered Persons — View Only" tier
# (an alternate, read-only grant for the same Registered Persons page,
# not a distinct page of its own). Super Admin always has every one of
# these implicitly (see auth.auth.get_effective_modules). A Company
# Admin's OWN access to each of these is now driven by this same stored
# grant too — see get_effective_modules — so every one of these must
# have a real checkbox on the Super Admin's permission page.
MODULES = [
    ("dashboard", "Dashboard"),
    ("unknown_person_analytics", "Unknown Person Analytics"),
    ("camera_management", "Camera Management"),
    ("normal_camera", "Normal Camera"),
    ("user_management", "User Management"),
    ("subscription_payment", "Subscription & Payment"),
    ("live_camera", "Live Camera"),
    ("registered_persons", "Registered Persons"),
    ("registered_persons_view", "Registered Persons — View Only"),
    ("unknown_persons", "Unknown Persons"),
    ("attendance", "Attendance"),
    ("reports", "Reports"),
    ("settings", "Settings"),
    ("site_management", "Sites / VPN Management"),
]

# Dashboard and Subscription & Payment — a Company Admin's only way
# back into the product and their only way to view+pay for module
# access, so these two are never removable via the module-permission
# system. Shared by api/permissions.py (Super Admin's grant editor)
# and api/billing.py (self-lockout guard, checkout's free/always
# included catalog items).
ALWAYS_ACTIVE_MODULE_KEYS = {"dashboard", "subscription_payment"}


# Every module key added to MODULES after the original 8-module
# baseline — a Company Admin couldn't possibly have had an opinion on
# any of these before now, since the pages didn't exist yet.
_NEWLY_ADDED_COMPANY_ADMIN_MODULE_KEYS = (
    "camera_management",
    "user_management",
    "subscription_payment",
    "unknown_person_analytics",
    "normal_camera",
    "site_management",
)


def _backfill_company_admin_permissions(session):
    """One-time, idempotent migration: before this fix, a Company Admin's
    module access was hardcoded to "every module, always" regardless of
    any stored permission grant (see auth.auth.get_effective_modules), so
    the Super Admin's checkbox UI had no runtime effect for this role —
    nobody had a real reason to restrict one via it. Now that a Company
    Admin's effective modules come from their stored grant just like a
    User's, this backfill covers two cases so flipping that switch can't
    silently take anything away from an existing company:

    1. A Company Admin with ZERO stored rows never had a chance to be
       restricted at all -> grant every module, preserving their current
       "sees everything" access exactly.
    2. A Company Admin who DOES already have some stored rows (from a
       prior, previously-inert checkbox save) couldn't have had an
       opinion about the 3 modules this fix just added — grant only
       those specific new ones, leaving every other module exactly as
       the Super Admin last saved it."""

    permission_id_by_key = dict(session.execute(select(Permission.module_key, Permission.id)).all())

    if not permission_id_by_key:
        return

    company_admin_ids = session.scalars(select(User.id).where(User.role == ROLE_COMPANY_ADMIN)).all()

    if not company_admin_ids:
        return

    already_granted_ids = set(
        session.scalars(
            select(UserPermission.user_id.distinct()).where(UserPermission.user_id.in_(company_admin_ids))
        )
    )

    # Case 1: zero rows yet -> full grant.
    for user_id in company_admin_ids:
        if user_id in already_granted_ids:
            continue
        for permission_id in permission_id_by_key.values():
            session.add(UserPermission(user_id=user_id, permission_id=permission_id))

    # Case 2: some rows already saved -> top up only the brand-new keys.
    new_permission_ids = {
        permission_id_by_key[key] for key in _NEWLY_ADDED_COMPANY_ADMIN_MODULE_KEYS if key in permission_id_by_key
    }

    if new_permission_ids and already_granted_ids:

        already_has_new = set(
            session.execute(
                select(UserPermission.user_id, UserPermission.permission_id).where(
                    UserPermission.user_id.in_(already_granted_ids),
                    UserPermission.permission_id.in_(new_permission_ids),
                )
            )
        )

        for user_id in already_granted_ids:
            for permission_id in new_permission_ids:
                if (user_id, permission_id) not in already_has_new:
                    session.add(UserPermission(user_id=user_id, permission_id=permission_id))


def init_db():
    """Create every table (via the SQLAlchemy models — see auth/models.py
    and the other api/*.py init_*_table() functions, all of which import
    the same Base/engine) if it doesn't already exist, seed the module
    permission catalog, backfill existing Company Admins' permissions
    (see _backfill_company_admin_permissions), and seed the default
    Super Admin account."""

    Base.metadata.create_all(bind=engine)

    # Camera Limit / Camera Quota Management - camera_limit was added to
    # `users` after it already existed in deployed databases.
    # create_all() only creates missing TABLES, never adds columns to one
    # that's already there (same situation api/cameras.py's
    # init_cameras_table() already handles for detection_enabled/
    # owner_user_id/stream_quality - see that function's docstring).
    # NULL-able, no DEFAULT needed: every existing Admin/User simply
    # starts unlimited until a Super Admin/Admin explicitly sets a cap.
    with engine.connect() as conn:
        existing_user_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
                )
            )
        }

        if "camera_limit" not in existing_user_columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN camera_limit INTEGER NULL"))
            conn.commit()

        # Server-side session revocation (Phase 2) — same
        # added-after-the-table-already-existed situation as camera_limit
        # above. DEFAULT 1 gives every existing row a starting value; a
        # session cookie already in the wild (issued before this column
        # existed) has no session_version in it at all, not a stale one —
        # auth.auth.get_current_user() backfills that case from the DB
        # value on first use instead of treating "absent" as "stale", so
        # this migration never mass-logs-out every existing session.
        if "session_version" not in existing_user_columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1"))
            conn.commit()

        # Security audit trail (Phase 2) — same added-after-the-table-
        # already-existed situation, this time for activity_logs. All
        # nullable/defaulted so every existing row stays valid as-is.
        existing_activity_log_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activity_logs'"
                )
            )
        }

        _activity_log_migrations = {
            "target_type": "ALTER TABLE activity_logs ADD COLUMN target_type VARCHAR(40) NULL",
            "target_id": "ALTER TABLE activity_logs ADD COLUMN target_id INTEGER NULL",
            "success": "ALTER TABLE activity_logs ADD COLUMN success INTEGER NOT NULL DEFAULT 1",
            "ip_address": "ALTER TABLE activity_logs ADD COLUMN ip_address VARCHAR(64) NULL",
            "company_id": "ALTER TABLE activity_logs ADD COLUMN company_id INTEGER NULL",
        }

        for column_name, ddl in _activity_log_migrations.items():
            if column_name not in existing_activity_log_columns:
                conn.execute(text(ddl))
                conn.commit()

    with get_session() as session:

        # Idempotent: seeds any modules missing from the catalog,
        # including ones added to MODULES after the table already existed.
        existing_modules = {row[0] for row in session.execute(select(Permission.module_key))}

        for key, label in MODULES:
            if key not in existing_modules:
                session.add(Permission(module_key=key, module_label=label))

        session.flush()  # so the select below in _backfill_company_admin_permissions sees any just-added Permission rows

        _backfill_company_admin_permissions(session)

        default_admin_exists = session.scalar(
            select(User).where(User.email == DEFAULT_ADMIN_EMAIL)
        )

        if default_admin_exists is None:
            admin_password = _generate_seed_password()
            session.add(
                User(
                    name=DEFAULT_ADMIN_NAME,
                    email=DEFAULT_ADMIN_EMAIL,
                    username=DEFAULT_ADMIN_EMAIL.split("@")[0],
                    password=generate_password_hash(admin_password),
                    role=ROLE_SUPER_ADMIN,
                    status="Active",
                    created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                )
            )
            _record_seed_credential("Default Super Admin account", DEFAULT_ADMIN_EMAIL, admin_password)

            print("=" * 50)
            print("Default Super Admin account created — email:", DEFAULT_ADMIN_EMAIL)
            print(f"One-time password written to: {INITIAL_CREDENTIALS_FILE}")
            print("Log in, change the password, then delete that file.")
            print("=" * 50)

        # Default Company Admin + one User under it — a working example
        # of the full Super Admin -> Company Admin -> User hierarchy,
        # ready immediately after the app first starts.
        default_company_admin = session.scalar(
            select(User).where(User.email == DEFAULT_COMPANY_ADMIN_EMAIL)
        )

        if default_company_admin is None:
            company_admin_password = _generate_seed_password()
            default_company_admin = User(
                name=DEFAULT_COMPANY_ADMIN_NAME,
                email=DEFAULT_COMPANY_ADMIN_EMAIL,
                username=DEFAULT_COMPANY_ADMIN_USERNAME,
                password=generate_password_hash(company_admin_password),
                role=ROLE_COMPANY_ADMIN,
                status="Active",
                created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            )
            session.add(default_company_admin)
            session.flush()  # populates default_company_admin.id for the User below
            _record_seed_credential(
                "Default Company Admin account", DEFAULT_COMPANY_ADMIN_EMAIL, company_admin_password
            )

            print("=" * 50)
            print("Default Company Admin account created — email:", DEFAULT_COMPANY_ADMIN_EMAIL)
            print(f"One-time password written to: {INITIAL_CREDENTIALS_FILE}")
            print("=" * 50)

        default_user_exists = session.scalar(select(User).where(User.email == DEFAULT_USER_EMAIL))

        if default_user_exists is None:
            user_password = _generate_seed_password()
            default_user = User(
                name=DEFAULT_USER_NAME,
                email=DEFAULT_USER_EMAIL,
                username=DEFAULT_USER_USERNAME,
                password=generate_password_hash(user_password),
                role=ROLE_USER,
                status="Active",
                parent_admin_id=default_company_admin.id,
                created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            )
            session.add(default_user)
            session.flush()  # populates default_user.id for the grants below

            granted_permissions = session.scalars(
                select(Permission).where(Permission.module_key.in_(DEFAULT_USER_MODULE_KEYS))
            ).all()

            for permission in granted_permissions:
                session.add(UserPermission(user_id=default_user.id, permission_id=permission.id))

            _record_seed_credential("Default User account", DEFAULT_USER_EMAIL, user_password)

            print("=" * 50)
            print("Default User account created — email:", DEFAULT_USER_EMAIL)
            print(f"One-time password written to: {INITIAL_CREDENTIALS_FILE}")
            print("=" * 50)


def restrict_file_permissions(path):
    """Best-effort owner-only file permissions (Phase 2 secret hardening)
    for a just-written secret/credential file (session secret key, camera
    Fernet key, the one-time seed-credentials file). `chmod` has no
    meaningful equivalent on Windows dev machines — `os.name != "nt"`
    makes this a silent no-op there, so local Windows development is
    completely unaffected. On Linux (the real EC2 production target)
    this actually restricts the file to owner read/write, matching the
    "restrictive permissions" requirement without needing any deploy-time
    script to remember to do it."""

    if os.name == "nt":
        return

    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # Never let a permissions best-effort block the app from starting.


def get_or_create_secret_key():
    """Flask's session cookie is signed with this key. It must stay
    stable across restarts (the dev server reloader in particular),
    otherwise every existing session is invalidated on each restart."""

    os.makedirs(AUTH_FOLDER, exist_ok=True)

    if os.path.exists(SECRET_KEY_FILE):

        with open(SECRET_KEY_FILE, "r") as file:
            key = file.read().strip()

        if key:
            return key

    key = secrets.token_hex(32)

    with open(SECRET_KEY_FILE, "w") as file:
        file.write(key)

    restrict_file_permissions(SECRET_KEY_FILE)

    return key


def get_user_by_email(email):

    with get_session() as session:
        user = session.scalar(select(User).where(User.email == email))
        return to_dict(user)


def get_user_by_id(user_id):

    with get_session() as session:
        user = session.get(User, user_id)
        return to_dict(user)


def get_all_users():

    with get_session() as session:
        rows = session.scalars(select(User).order_by(User.created_at.desc())).all()
        return [to_dict(u) for u in rows]


def get_users_by_parent(parent_admin_id):
    """Every User row belonging to one Company Admin — the "Manage my
    company's Users" list. See api/company_users.py."""

    with get_session() as session:
        rows = session.scalars(
            select(User).where(User.parent_admin_id == parent_admin_id).order_by(User.created_at.desc())
        ).all()
        return [to_dict(u) for u in rows]


def _duplicate_field_error(session, email, username, exclude_id=None):
    """Proactive uniqueness check so the error message can name exactly
    which field collided — portable across DB engines, unlike parsing a
    driver-specific IntegrityError message string."""

    email_query = select(User).where(User.email == email)
    username_query = select(User).where(User.username == username)

    if exclude_id is not None:
        email_query = email_query.where(User.id != exclude_id)
        username_query = username_query.where(User.id != exclude_id)

    if session.scalar(email_query) is not None:
        return f'A user with the email "{email}" already exists.'

    if session.scalar(username_query) is not None:
        return f'A user with the username "{username}" already exists.'

    return None


def create_user(name, email, username, password, role, status, phone_number=None, parent_admin_id=None):

    # IntegrityError from flush() must propagate all the way out of the
    # `with` block so get_session()'s own except/rollback handles it —
    # catching it *inside* the block and returning early would leave the
    # session in a failed-flush state that then breaks get_session()'s
    # own commit() on exit.
    try:
        with get_session() as session:

            error = _duplicate_field_error(session, email, username)

            if error:
                return None, error

            user = User(
                name=name,
                email=email,
                username=username,
                password=generate_password_hash(password),
                role=role,
                status=status,
                phone_number=phone_number,
                parent_admin_id=parent_admin_id,
                created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            )
            session.add(user)
            session.flush()
            new_id = user.id
    except IntegrityError:
        return None, "A user with this email or username already exists."

    return new_id, None


def update_user(user_id, name, email, username, role, phone_number=None):

    try:
        with get_session() as session:

            error = _duplicate_field_error(session, email, username, exclude_id=user_id)

            if error:
                return False, error

            user = session.get(User, user_id)

            if user is None:
                return False, None

            user.name = name
            user.email = email
            user.username = username
            user.role = role
            user.phone_number = phone_number
            session.flush()
    except IntegrityError:
        return False, "A user with this email or username already exists."

    return True, None


def delete_user(user_id):

    with get_session() as session:
        user = session.get(User, user_id)

        if user is None:
            return False

        session.delete(user)
        return True


def set_user_avatar(user_id, avatar_path):
    """avatar_path is the stored filename under Backend/dataset/avatars,
    or None to clear it (Remove Photo)."""

    with get_session() as session:
        user = session.get(User, user_id)

        if user is not None:
            user.avatar_path = avatar_path


def update_user_status(user_id, status):

    with get_session() as session:
        user = session.get(User, user_id)

        if user is None:
            return False

        user.status = status

        # Session revocation (Phase 2): disabling an account must also
        # kill any session already open for it — otherwise a session
        # opened before the disable keeps working (auth.auth.
        # get_current_user only checks status via this same row on each
        # request, but a stale cached session pre-dating this feature
        # would have no version at all — the bump forces every browser
        # tab, everywhere, off on its very next request). Re-enabling
        # doesn't need this: there is no live session to invalidate.
        if status != "Active":
            user.session_version = (user.session_version or 1) + 1

        return True


def reset_user_password(user_id, new_password):
    """Returns the account's new session_version on success (always >= 2,
    so it stays truthy for every existing `if not reset_user_password(...)`
    caller), or None if the user doesn't exist. Every password
    change/reset in the app — self-service, Super Admin resetting a
    Company Admin, Company Admin resetting a User — goes through this one
    function, so bumping session_version here (Phase 2 session
    revocation) covers all of them: any session opened with the OLD
    password stops being accepted on its next request. See
    auth.auth.get_current_user for the check, and routes.py's
    change_password handler for how the acting user's OWN current session
    is immediately re-synced afterward so they aren't logged out by their
    own password change."""

    with get_session() as session:
        user = session.get(User, user_id)

        if user is None:
            return None

        user.password = generate_password_hash(new_password)
        user.session_version = (user.session_version or 1) + 1
        session.flush()

        return user.session_version


def bump_session_version(user_id):
    """Session revocation (Phase 2): invalidate every OTHER session open
    for this user right now, without touching their password or status —
    used by the self-service "Log out of all other devices" action
    (POST /account/sessions/revoke-all). Returns the new version, or None
    if the user doesn't exist. The caller is expected to immediately
    write this same value back into their own current session (see
    routes.py) so this action logs out every OTHER session while leaving
    the one that requested it untouched."""

    with get_session() as session:
        user = session.get(User, user_id)

        if user is None:
            return None

        user.session_version = (user.session_version or 1) + 1
        session.flush()

        return user.session_version


def set_user_camera_limit(user_id, camera_limit):
    """Raw write, no validation — see api/camera_quota.py for the actual
    allocation-budget/quota rules callers must apply before reaching
    this. `camera_limit` is a Company Admin's own Super-Admin-set cap, or
    a User's own Company-Admin-set cap, depending on that row's role
    (see User.camera_limit's comment in auth/models.py). None = clear to
    unlimited."""

    with get_session() as session:
        user = session.get(User, user_id)

        if user is None:
            return False

        user.camera_limit = camera_limit
        return True


def get_all_permissions():

    with get_session() as session:
        rows = session.scalars(select(Permission).order_by(Permission.id)).all()
        return [to_dict(p) for p in rows]


def get_user_module_keys(user_id):
    """The set of module_keys explicitly granted to this user. Meaningless
    for a Super Admin — use auth.auth.get_effective_modules for the
    actual access list, which always returns every module for them."""

    with get_session() as session:
        rows = session.scalars(
            select(Permission.module_key)
            .join(UserPermission, UserPermission.permission_id == Permission.id)
            .where(UserPermission.user_id == user_id)
        ).all()
        return list(rows)


def set_user_permissions(user_id, module_keys):
    """Replace this user's full permission set with exactly module_keys."""

    with get_session() as session:

        permission_ids = session.scalars(
            select(Permission.id).where(Permission.module_key.in_(module_keys))
        ).all()

        session.query(UserPermission).filter(UserPermission.user_id == user_id).delete()

        for permission_id in permission_ids:
            session.add(UserPermission(user_id=user_id, permission_id=permission_id))


def log_activity(
    user_name,
    action,
    details="",
    user_id=None,
    target_type=None,
    target_id=None,
    success=True,
    ip_address=None,
    company_id=None,
):
    """Every existing call site (Login/Logout/user & camera CRUD/
    permission changes/...) keeps working unchanged — the Phase 2 audit
    columns below are all optional kwargs with the same defaults the
    table itself falls back to. See log_security_event for a thin
    wrapper that auto-fills ip_address from the current request when
    there's no convenient current_user (failed login, CSRF rejection,
    rate-limit lockout)."""

    with get_session() as session:
        session.add(
            ActivityLog(
                user_id=user_id,
                user_name=user_name,
                action=action,
                details=details,
                created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                target_type=target_type,
                target_id=target_id,
                success=1 if success else 0,
                ip_address=ip_address,
                company_id=company_id,
            )
        )


def log_security_event(action, user=None, target_type=None, target_id=None, success=True, details="", company_id=None):
    """Security audit trail (Phase 2) for events that don't already have
    a natural log_activity() call site with a guaranteed current_user —
    failed login attempts, CSRF rejections, rate-limit lockouts, session
    revocation. Auto-fills ip_address from the current Flask request.

    NEVER pass a password, session/CSRF token, cookie, RTSP URL, or
    biometric value in `details` — callers should route anything that
    could contain one through error_logging.sanitize_sensitive_url first,
    same as every other log call in this codebase."""

    ip_address = None
    if has_request_context():
        ip_address = request.remote_addr

    log_activity(
        user["name"] if user else "Unknown",
        action,
        details=details,
        user_id=user["id"] if user else None,
        target_type=target_type,
        target_id=target_id,
        success=success,
        ip_address=ip_address,
        company_id=company_id,
    )


def get_activity_logs(limit=200):

    with get_session() as session:
        rows = session.scalars(
            select(ActivityLog).order_by(ActivityLog.id.desc()).limit(limit)
        ).all()
        return [to_dict(r) for r in rows]


def delete_activity_log(log_id):

    with get_session() as session:
        log = session.get(ActivityLog, log_id)

        if log is None:
            return False

        session.delete(log)
        return True


def delete_activity_logs(log_ids):
    """Bulk delete by id list — a single DELETE ... WHERE id IN (...)
    query instead of one query per row, for the Dashboard's "Delete
    Selected" action."""

    if not log_ids:
        return 0

    with get_session() as session:
        return session.query(ActivityLog).filter(ActivityLog.id.in_(log_ids)).delete(synchronize_session=False)


def delete_all_activity_logs():

    with get_session() as session:
        session.query(ActivityLog).delete()


def count_active_super_admins(exclude_id=None):

    with get_session() as session:
        query = select(func.count()).select_from(User).where(
            User.role == ROLE_SUPER_ADMIN, User.status == "Active"
        )

        if exclude_id is not None:
            query = query.where(User.id != exclude_id)

        return session.scalar(query)
