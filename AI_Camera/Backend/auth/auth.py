from functools import wraps

from flask import session, jsonify
from werkzeug.security import check_password_hash

from auth.database import (
    get_user_by_email,
    get_user_by_id,
    get_user_module_keys,
    get_users_by_parent,
    ROLE_SUPER_ADMIN,
    ROLE_COMPANY_ADMIN,
    ROLE_USER,
    MODULES,
)

ALL_MODULE_KEYS = [key for key, _ in MODULES]


def get_effective_modules(user):
    """Modules this user can actually access. Super Admin always gets
    every module — that's not a grant, it's what being Super Admin means.
    A Company Admin gets exactly the modules the Super Admin has granted
    THEM (see auth.database.MODULES / api.permissions), the same
    DB-backed mechanism a User's own grant from their Company Admin
    already uses (see api.company_users) — previously this unconditionally
    returned every module for a Company Admin regardless of what was
    actually stored, which is the bug this fixes."""

    if user["role"] == ROLE_SUPER_ADMIN:
        return list(ALL_MODULE_KEYS)

    return get_user_module_keys(user["id"])


def has_module_permission(user, module_key):

    return module_key in get_effective_modules(user)


def is_self_target(user, target_user_id):
    """True when a User (never a Company Admin — their own row is never
    role==ROLE_USER, so this is structurally always False for them) is
    about to act on their OWN row through the company_users.py
    self-service surface. That surface exists to manage OTHER Users in
    the company; self-service (edit own profile, reset own password,
    etc.) already has its own dedicated Profile/Settings routes, so
    routes.py's /company/users/<user_id>/* handlers call this first and
    403 rather than letting a User edit/delete/reset-password/re-grant
    permissions on themselves — the one privilege-escalation path
    granting them "user_management" would otherwise open."""

    return user["role"] == ROLE_USER and user["id"] == target_user_id


def is_company_admin(user):
    return user["role"] == ROLE_COMPANY_ADMIN


def is_super_admin(user):
    return user["role"] == ROLE_SUPER_ADMIN


def get_tenant_id(user):
    """The id whose company data (cameras, registered persons, attendance,
    settings, subscription, ...) this account should see — the Company
    Admin's own id for a Company Admin, or the owning Company Admin's id
    for one of their Users. Every company's data is scoped by this id,
    never by the caller's own `id` directly (those differ for a User —
    using the wrong one would either 404 a User out of their own
    company's data or, worse, let one company's data leak into another's).
    Meaningless for Super Admin, who has no company data of their own."""

    if user["role"] == ROLE_USER:
        return user.get("parent_admin_id")

    return user["id"]


def get_data_scope(user, requested_user_id=None):
    """Per-User Data Isolation. Resolves BOTH axes a route needs: which
    company (customer_id, exactly what get_tenant_id already returns —
    unchanged, still used everywhere for company-level operations like
    User/Camera CRUD, Settings, Subscriptions) and which owner_user_id
    subset of that company's per-record data (cameras, registered/
    unknown persons, attendance, notifications) to show.

    Returns {"customer_id": int, "owner_user_id": int | "unassigned" |
    None}. Callers pass owner_user_id straight through to the api/*.py
    query functions, which treat None as "no filter" (today's exact
    pooled behavior), "unassigned" as "IS NULL", and an int as
    "== that id".

    - A User (role == ROLE_USER) ALWAYS gets scoped to their own id,
      regardless of what requested_user_id says — that branch is never
      even reached for a User, so no crafted query string can ever show
      them another User's (or the Admin's) data.
    - A Company Admin defaults to owner_user_id=None ("all users",
      today's pooled aggregate) unless requested_user_id narrows it to
      "unassigned" or one of THEIR OWN Users' ids (validated against
      get_users_by_parent here, never trusted blind). Garbage or another
      company's user id is silently ignored and falls back to the safe
      "all" aggregate rather than erroring or leaking."""

    customer_id = get_tenant_id(user)

    if user["role"] == ROLE_USER:
        return {"customer_id": customer_id, "owner_user_id": user["id"]}

    if requested_user_id in (None, "", "all"):
        return {"customer_id": customer_id, "owner_user_id": None}

    if requested_user_id == "unassigned":
        return {"customer_id": customer_id, "owner_user_id": "unassigned"}

    try:
        target_id = int(requested_user_id)
    except (TypeError, ValueError):
        return {"customer_id": customer_id, "owner_user_id": None}

    company_user_ids = {u["id"] for u in get_users_by_parent(customer_id)}

    if target_id not in company_user_ids:
        return {"customer_id": customer_id, "owner_user_id": None}

    return {"customer_id": customer_id, "owner_user_id": target_id}


def resolve_settings_target_id(user, requested_user_id=None):
    """Per-User Settings. Resolves the single account whose settings
    profile a request should read/write/reset — always exactly one
    concrete user id (never "all"/"unassigned"; unlike get_data_scope
    above, a settings profile is per-account with no aggregate view).

    - A User (role == ROLE_USER) ALWAYS gets their own id, regardless of
      what requested_user_id says — that branch is never even reached
      for a User, so no crafted query string can ever let them read or
      write another account's settings.
    - A Company Admin defaults to their OWN id (their own settings)
      unless requested_user_id names one of THEIR OWN Users (validated
      against get_users_by_parent here, never trusted blind) — letting
      the Admin view/edit/reset that specific User's settings instead.
      Garbage or another company's user id silently falls back to the
      Admin's own id, never erroring or leaking."""

    if user["role"] == ROLE_USER:
        return user["id"]

    if requested_user_id in (None, "", "self"):
        return user["id"]

    try:
        target_id = int(requested_user_id)
    except (TypeError, ValueError):
        return user["id"]

    company_user_ids = {u["id"] for u in get_users_by_parent(user["id"])}

    if target_id not in company_user_ids:
        return user["id"]

    return target_id


def role_label(user):
    """Human-facing role name — now just the real stored role, kept as
    its own function since callers (serialize_user, the frontend) already
    depend on this name existing."""

    return user["role"]


def serialize_user(user):

    avatar_path = user.get("avatar_path")

    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "username": user["username"],
        "phone_number": user.get("phone_number"),
        "role": user["role"],
        "role_label": role_label(user),
        "status": user["status"],
        "created_at": user["created_at"],
        "avatar_url": f"http://localhost:5000/account/avatar/{avatar_path}" if avatar_path else None,
        "modules": get_effective_modules(user),
    }


def authenticate(email, password):
    """Return the user row on valid credentials for an active account,
    otherwise None."""

    user = get_user_by_email(email)

    if not user:
        return None

    if user["status"] != "Active":
        return None

    if not check_password_hash(user["password"], password):
        return None

    return user


def get_current_user():
    """Resolves the signed-in user for this request, or None if there
    isn't one — including a session that LOOKS present but is no longer
    valid: the account was disabled, or its session_version has been
    bumped since this cookie was issued (password changed/reset,
    disabled, or "log out of all other sessions" — see
    auth.database.bump_session_version / reset_user_password /
    update_user_status). Either case clears the cookie outright rather
    than just returning None, so the browser stops sending a dead cookie
    on every subsequent request.

    A cookie issued before session_version existed at all carries no
    "session_version" key (not a stale one) — that's backfilled from the
    DB's current value here instead of being treated as a mismatch, so
    this check never mass-logs-out sessions that were already open when
    the feature shipped."""

    user_id = session.get("user_id")

    if not user_id:
        return None

    user = get_user_by_id(user_id)

    if user is None:
        session.clear()
        return None

    if user["status"] != "Active":
        session.clear()
        return None

    session_version = session.get("session_version")

    if session_version is None:
        session["session_version"] = user["session_version"]
    elif session_version != user["session_version"]:
        session.clear()
        return None

    return user


def login_required(view_func):

    @wraps(view_func)
    def wrapper(*args, **kwargs):

        if get_current_user() is None:
            return jsonify({"success": False, "message": "Authentication required."}), 401

        return view_func(*args, **kwargs)

    return wrapper


def module_required(*module_keys):
    """Gate a route behind one or more module permissions. Super Admin
    always passes; a User needs at least one of the given modules
    explicitly granted (e.g. a read route accepting either full edit
    access or a view-only variant of the same module)."""

    def decorator(view_func):

        @wraps(view_func)
        def wrapper(*args, **kwargs):

            user = get_current_user()

            if user is None:
                return jsonify({"success": False, "message": "Authentication required."}), 401

            if not any(has_module_permission(user, key) for key in module_keys):
                return jsonify({"success": False, "message": "You do not have permission to access this module."}), 403

            return view_func(*args, **kwargs)

        return wrapper

    return decorator


def super_admin_required(view_func):

    @wraps(view_func)
    def wrapper(*args, **kwargs):

        user = get_current_user()

        if user is None:
            return jsonify({"success": False, "message": "Authentication required."}), 401

        if user["role"] != ROLE_SUPER_ADMIN:
            return jsonify({"success": False, "message": "Super Admin access required."}), 403

        return view_func(*args, **kwargs)

    return wrapper


def admin_required(view_func):
    """Gate a route to any Admin tier (Company Admin or Super Admin),
    excluding a plain User — for the Notification & Reporting feature's
    Admin Settings, which must never be reachable by a User account even
    if they happen to hold the "settings" module permission."""

    @wraps(view_func)
    def wrapper(*args, **kwargs):

        user = get_current_user()

        if user is None:
            return jsonify({"success": False, "message": "Authentication required."}), 401

        if user["role"] == ROLE_USER:
            return jsonify({"success": False, "message": "Admin access required."}), 403

        return view_func(*args, **kwargs)

    return wrapper


def company_admin_required(view_func):
    """Gate a route to Company Admin only — the account-level "manage my
    own company's billing" routes (/company/subscription, /company/payments,
    /company/checkout*) that must never be reachable by a User under that
    Company Admin, module grant or not — see company_or_user_required for
    the sibling self-service routes (Users/Cameras/Normal Cameras/Unknown
    Person Analytics) a User CAN reach once granted the matching module."""

    @wraps(view_func)
    def wrapper(*args, **kwargs):

        user = get_current_user()

        if user is None:
            return jsonify({"success": False, "message": "Authentication required."}), 401

        if user["role"] != ROLE_COMPANY_ADMIN:
            return jsonify({"success": False, "message": "Company Admin access required."}), 403

        return view_func(*args, **kwargs)

    return wrapper


def company_or_user_required(view_func):
    """Gate a route to Company Admin or one of their Users — the shared
    tenant-scoped self-service surface (api/company_users.py's User
    Management, and the /company/cameras*, /company/normal-cameras*,
    /company/unknown-analytics routes in api/routes.py) that a User can
    also reach once granted the matching module via module_required,
    always applied alongside this decorator on every route it guards.
    Every function behind this resolves its tenant via
    get_tenant_id(current_user), which already maps a User to their
    OWNING Company Admin's id, so a User reaches only their own
    company's data here — exactly like a Company Admin does."""

    @wraps(view_func)
    def wrapper(*args, **kwargs):

        user = get_current_user()

        if user is None:
            return jsonify({"success": False, "message": "Authentication required."}), 401

        if user["role"] not in (ROLE_COMPANY_ADMIN, ROLE_USER):
            return jsonify({"success": False, "message": "Access required."}), 403

        return view_func(*args, **kwargs)

    return wrapper
