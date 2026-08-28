"""Company Admin's self-service "Manage my own company's Users" — the
same shape as api/users.py (Super Admin's Company/Admin Management), but
every function is scoped to `parent_admin_id` (the calling Company
Admin's own id) and can only ever touch a User row that actually belongs
to that Company Admin. This is what makes "Company Admin must NEVER
access another company's Users" a structural guarantee rather than a
frontend-only rule — a user_id belonging to a different company 404s
here exactly like it does everywhere else in the app (see get_camera,
get_registered_persons, etc.)."""

from auth.database import (
    get_users_by_parent,
    get_user_by_id,
    create_user,
    update_user,
    delete_user,
    update_user_status,
    reset_user_password,
    get_user_module_keys,
    set_user_permissions,
    set_user_camera_limit,
    ROLE_USER,
    MODULES,
)
from auth.auth import serialize_user
from api.validators import (
    validate_text_field,
    validate_email,
    validate_phone,
    validate_password,
)
from api.user_notification_settings import (
    get_user_notification_settings,
    update_user_notification_settings,
    reset_user_notification_settings,
)
from api.avatar import save_avatar, remove_avatar
from api.camera_quota import get_user_camera_summary, validate_admin_capacity_for_user_limit

VALID_STATUSES = ("Active", "Inactive")


def _serialize_user_with_camera_quota(user):
    """serialize_user() plus this User's own Camera Limit / Camera Quota
    rollup (api/camera_quota.py) — every User Management API response
    goes through this instead of the bare serialize_user, so the table/
    Add/Edit User modal in pages/UserManagement.jsx always has
    camera_limit/used/remaining/usage_percent/status without a second
    round-trip. None passes through as None (e.g. a failed lookup)."""

    if user is None:
        return None

    return {**serialize_user(user), "camera_quota": get_user_camera_summary(user["id"])}


# Every module a User's own portal (/user/*) actually routes — see
# Frontend/src/App.jsx's ModulePortalRoutes() and constants/modules.js,
# the exact same shared page set the Company Admin portal (/admin/*)
# mounts. A Company Admin may grant a User any subset of these. Three
# system modules are deliberately never included here, all stripped a
# second time in update_company_user_permissions below, defense-in-depth,
# so no tampered request can ever grant any of them:
#   - subscription_payment — Company Admin's own billing, no /user/*
#     route at all.
#   - user_management — managing this company's OTHER Users/their
#     credentials is Company-Admin-only; the /user-management page and
#     /company/users* API keep working for Company Admin exactly as
#     before, a User account just can never be granted access to it.
#   - site_management — Site/VPN Gateway CRUD and access management is
#     Company-Admin-only (see api/sites.py); a User's own visibility into
#     Sites comes from SiteUser assignment, never from this module.
GRANTABLE_USER_MODULE_KEYS = {
    "dashboard",
    "live_camera",
    "camera_management",
    "normal_camera",
    "registered_persons",
    "unknown_persons",
    "unknown_person_analytics",
    "attendance",
    "reports",
    "settings",
}

# Legacy Registered Persons "view only" tier — predates this module's
# 11-key grantable set and is no longer shown/editable as its own
# checkbox (constants/modules.js's Registered Persons is a single page,
# not two), but a User who already holds it must keep working exactly as
# before. NEVER add to this: it's a narrow carve-out for one already-
# granted legacy key, not a general "preserve anything" escape hatch —
# see update_company_user_permissions.
_LEGACY_PRESERVED_MODULE_KEYS = {"registered_persons_view"}


def _owned_user(parent_admin_id, user_id):
    """The target User row, or None if it doesn't exist or doesn't
    belong to this Company Admin — the single check every mutation below
    goes through before touching anything."""

    user = get_user_by_id(user_id)

    if user is None or user["role"] != ROLE_USER or user["parent_admin_id"] != parent_admin_id:
        return None

    return user


def list_company_users(parent_admin_id, exclude_user_id=None):
    """`exclude_user_id` drops the caller's own row — routes.py passes it
    whenever the caller is a User, so if this ever became reachable by
    one again they'd never see Edit/Delete/Reset/Permissions actions
    against their own account (self-service for that stays on
    Profile/Settings). Currently always None in practice: "user_management"
    is no longer a User-grantable module (see GRANTABLE_USER_MODULE_KEYS),
    so a User can never pass module_required to reach this function at
    all, and a Company Admin caller never needs it either — their own row
    is never role==ROLE_USER, so it can never appear here (see
    _owned_user)."""

    return [
        _serialize_user_with_camera_quota(u)
        for u in get_users_by_parent(parent_admin_id)
        if u["id"] != exclude_user_id
    ]


def get_company_user(parent_admin_id, user_id):

    user = _owned_user(parent_admin_id, user_id)

    return (_serialize_user_with_camera_quota(user), None) if user else (None, "User not found.")


def add_company_user(parent_admin_id, name, email, username, password, status, phone_number=None):

    name = (name or "").strip()
    email = (email or "").strip().lower()
    username = (username or "").strip()
    phone_number = (phone_number or "").strip()
    status = status if status in VALID_STATUSES else "Active"

    error = (
        validate_text_field(name, "Name", min_len=2, max_len=50)
        or validate_email(email)
        or validate_text_field(username, "Username", min_len=3, max_len=50)
        or validate_phone(phone_number)
        or validate_password(password, label="Password", strong=True)
    )

    if error:
        return None, error

    new_id, error = create_user(
        name, email, username, password, ROLE_USER, status, phone_number, parent_admin_id=parent_admin_id
    )

    if error:
        return None, error

    return _serialize_user_with_camera_quota(get_user_by_id(new_id)), None


def edit_company_user(parent_admin_id, user_id, name, email, username, phone_number=None):

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    name = (name or "").strip()
    email = (email or "").strip().lower()
    username = (username or "").strip()
    phone_number = (phone_number or "").strip()

    error = (
        validate_text_field(name, "Name", min_len=2, max_len=50)
        or validate_email(email)
        or validate_text_field(username, "Username", min_len=3, max_len=50)
        or validate_phone(phone_number)
    )

    if error:
        return None, error

    # Role never changes here — a User row stays a User row, only ever
    # created/removed, never promoted, through this self-service surface.
    updated, error = update_user(user_id, name, email, username, ROLE_USER, phone_number)

    if error:
        return None, error

    if not updated:
        return None, "User not found."

    return _serialize_user_with_camera_quota(get_user_by_id(user_id)), None


def set_company_user_camera_limit(parent_admin_id, user_id, camera_limit):
    """Admin sets (or clears, with None) one of their own Users' camera
    cap. Validated against this Admin's own remaining allocation budget
    (api/camera_quota.py's validate_admin_capacity_for_user_limit) — the
    SUM of every User's camera_limit under this Admin can never exceed
    the Admin's own camera_limit (Backend API enforcement; the frontend
    must never be trusted to have checked this itself). Reducing a
    User's limit is always allowed, even below their current actual
    usage — see camera_quota.py's module docstring for why that's a safe
    "Over Limit" state, not a rejection."""

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    if camera_limit is not None:
        if not isinstance(camera_limit, int) or isinstance(camera_limit, bool) or camera_limit < 0:
            return None, "Camera limit must be a whole number of 0 or more."

    budget_error = validate_admin_capacity_for_user_limit(parent_admin_id, user_id, camera_limit)

    if budget_error:
        return None, budget_error

    set_user_camera_limit(user_id, camera_limit)

    return _serialize_user_with_camera_quota(get_user_by_id(user_id)), None


def remove_company_user(parent_admin_id, user_id):

    if _owned_user(parent_admin_id, user_id) is None:
        return False, "User not found."

    if not delete_user(user_id):
        return False, "User not found."

    return True, None


def set_company_user_status(parent_admin_id, user_id, status):

    if status not in VALID_STATUSES:
        return None, "Invalid status."

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    if not update_user_status(user_id, status):
        return None, "User not found."

    return _serialize_user_with_camera_quota(get_user_by_id(user_id)), None


def reset_company_user_password(parent_admin_id, user_id, new_password):

    error = validate_password(new_password, label="Password", strong=True)

    if error:
        return False, error

    if _owned_user(parent_admin_id, user_id) is None:
        return False, "User not found."

    if not reset_user_password(user_id, new_password):
        return False, "User not found."

    return True, None


def get_company_user_permissions(parent_admin_id, user_id):

    user = _owned_user(parent_admin_id, user_id)

    if user is None:
        return None, "User not found."

    granted = set(get_user_module_keys(user_id))

    permissions = [
        {"module_key": key, "module_label": label, "granted": key in granted}
        for key, label in MODULES
        if key in GRANTABLE_USER_MODULE_KEYS
    ]

    return {
        "user_id": user_id,
        "name": user["name"],
        "email": user["email"],
        "permissions": permissions,
    }, None


def update_company_user_permissions(parent_admin_id, user_id, module_keys):

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    if module_keys is not None and not isinstance(module_keys, list):
        return None, "Module permissions must be provided as a list."

    clean_keys = {key for key in (module_keys or []) if key in GRANTABLE_USER_MODULE_KEYS}

    # This modal only ever shows/edits GRANTABLE_USER_MODULE_KEYS, so a
    # plain save must never silently revoke a legacy key it never
    # displayed a checkbox for.
    clean_keys |= set(get_user_module_keys(user_id)) & _LEGACY_PRESERVED_MODULE_KEYS

    # subscription_payment, user_management, and site_management must
    # NEVER reach a User, even via a tampered module_keys payload — all
    # three are already excluded from GRANTABLE_USER_MODULE_KEYS above,
    # but stripped again here, unconditionally, as the last line of
    # defense before this ever hits the database. This also cleans up
    # any of these keys on the next save for a User who happened to hold
    # one already.
    clean_keys -= {"subscription_payment", "user_management", "site_management"}

    set_user_permissions(user_id, sorted(clean_keys))

    result, _ = get_company_user_permissions(parent_admin_id, user_id)

    return result, None


def get_company_user_whatsapp_settings(parent_admin_id, user_id):
    """User Management > Add/Edit User > WhatsApp & Reports — the
    ownership check below is what makes "a Company Admin can only ever
    configure their OWN Users' WhatsApp settings" structural rather than
    a frontend-only rule, same pattern as every other function here."""

    user = _owned_user(parent_admin_id, user_id)

    if user is None:
        return None, "User not found."

    return {
        "user_id": user_id,
        "name": user["name"],
        "settings": get_user_notification_settings(user_id),
    }, None


def update_company_user_whatsapp_settings(parent_admin_id, user_id, new_values):

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    updated, error = update_user_notification_settings(user_id, new_values)

    if error:
        return None, error

    return {"user_id": user_id, "settings": updated}, None


def reset_company_user_whatsapp_settings(parent_admin_id, user_id):

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    return {"user_id": user_id, "settings": reset_user_notification_settings(user_id)}, None


def update_company_user_avatar(parent_admin_id, user_id, file):
    """Settings page > Profile, when a Company Admin is managing one of
    their Users — reuses api/avatar.py's save_avatar exactly as the
    self-service /account/avatar route does, just targeting user_id
    instead of the caller's own id, after the same ownership check every
    other function here goes through."""

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    _path, error = save_avatar(user_id, file)

    if error:
        return None, error

    return _serialize_user_with_camera_quota(get_user_by_id(user_id)), None


def remove_company_user_avatar(parent_admin_id, user_id):

    if _owned_user(parent_admin_id, user_id) is None:
        return None, "User not found."

    remove_avatar(user_id)

    return _serialize_user_with_camera_quota(get_user_by_id(user_id)), None
