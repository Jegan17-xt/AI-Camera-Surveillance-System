from auth.database import (
    get_all_permissions,
    get_user_by_id,
    get_user_module_keys,
    set_user_permissions,
    ROLE_SUPER_ADMIN,
    MODULES,
    ALWAYS_ACTIVE_MODULE_KEYS,
)

VALID_MODULE_KEYS = {key for key, _ in MODULES}


def list_permissions():

    return get_all_permissions()


def get_user_permissions(user_id):

    user = get_user_by_id(user_id)

    if user is None:
        return None, "User not found."

    granted = set(get_user_module_keys(user_id))

    permissions = [
        {
            "module_key": key,
            "module_label": label,
            "granted": key in granted,
            # Lets any caller (e.g. the Module Access & Billing section
            # on AdminCompanyDetails.jsx) show/disable these two as
            # permanently unlocked without duplicating
            # ALWAYS_ACTIVE_MODULE_KEYS on the frontend.
            "always_active": key in ALWAYS_ACTIVE_MODULE_KEYS,
        }
        for key, label in MODULES
    ]

    return {
        "user_id": user_id,
        "name": user["name"],
        "email": user["email"],
        "role": user["role"],
        "permissions": permissions,
    }, None


def update_user_permissions(user_id, module_keys):

    user = get_user_by_id(user_id)

    if user is None:
        return None, "User not found."

    if user["role"] == ROLE_SUPER_ADMIN:
        return None, "Permissions do not apply to Super Admin accounts."

    if module_keys is not None and not isinstance(module_keys, list):
        return None, "Module permissions must be provided as a list."

    clean_keys = {key for key in (module_keys or []) if key in VALID_MODULE_KEYS}
    # Dashboard and Subscription & Payment can never be fully revoked
    # here — a Company Admin can no longer self-restore module access
    # via checkout (that's now Super-Admin-only, see api/billing.py),
    # so removing either would be a dead-end lockout.
    clean_keys |= ALWAYS_ACTIVE_MODULE_KEYS

    set_user_permissions(user_id, sorted(clean_keys))

    result, _ = get_user_permissions(user_id)

    return result, None
