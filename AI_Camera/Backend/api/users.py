from auth.database import (
    get_all_users,
    create_user,
    update_user,
    delete_user,
    update_user_status,
    reset_user_password,
    get_user_by_id,
    count_active_super_admins,
    ROLE_SUPER_ADMIN,
    ROLE_COMPANY_ADMIN,
)
from auth.auth import serialize_user
from api.validators import (
    validate_text_field,
    validate_email,
    validate_phone,
    validate_password,
)

# This module backs Super Admin's /users* routes only — "Admin
# Management" (creating other Super Admins) and "Company Management"
# (creating Company Admin accounts) both go through it, filtered by
# `role`. Super Admin must never create a User directly (every User is
# created by a Company Admin instead — see api/company_users.py), so
# ROLE_USER is deliberately not a valid role here: any request that
# doesn't ask for one of these two falls back to ROLE_COMPANY_ADMIN,
# never ROLE_USER.
VALID_ROLES = (ROLE_SUPER_ADMIN, ROLE_COMPANY_ADMIN)
VALID_STATUSES = ("Active", "Inactive")


def list_users():

    return [serialize_user(u) for u in get_all_users()]


def add_user(name, email, username, password, role, status, phone_number=None):

    name = (name or "").strip()
    email = (email or "").strip().lower()
    username = (username or "").strip()
    phone_number = (phone_number or "").strip()
    role = role if role in VALID_ROLES else ROLE_COMPANY_ADMIN
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

    new_id, error = create_user(name, email, username, password, role, status, phone_number)

    if error:
        return None, error

    return serialize_user(get_user_by_id(new_id)), None


def edit_user(user_id, name, email, username, role, phone_number=None):

    name = (name or "").strip()
    email = (email or "").strip().lower()
    username = (username or "").strip()
    phone_number = (phone_number or "").strip()
    role = role if role in VALID_ROLES else ROLE_COMPANY_ADMIN

    error = (
        validate_text_field(name, "Name", min_len=2, max_len=50)
        or validate_email(email)
        or validate_text_field(username, "Username", min_len=3, max_len=50)
        or validate_phone(phone_number)
    )

    if error:
        return None, error

    existing = get_user_by_id(user_id)

    if existing is None:
        return None, "User not found."

    if existing["role"] == ROLE_SUPER_ADMIN and role != ROLE_SUPER_ADMIN:
        if count_active_super_admins(exclude_id=user_id) == 0:
            return None, "At least one active Super Admin must remain."

    updated, error = update_user(user_id, name, email, username, role, phone_number)

    if error:
        return None, error

    if not updated:
        return None, "User not found."

    return serialize_user(get_user_by_id(user_id)), None


def remove_user(user_id, current_user_id):

    if user_id == current_user_id:
        return False, "You cannot delete your own account."

    existing = get_user_by_id(user_id)

    if existing is None:
        return False, "User not found."

    if existing["role"] == ROLE_SUPER_ADMIN and existing["status"] == "Active":
        if count_active_super_admins(exclude_id=user_id) == 0:
            return False, "At least one active Super Admin must remain."

    if not delete_user(user_id):
        return False, "User not found."

    return True, None


def set_user_status(user_id, status, current_user_id):

    if status not in VALID_STATUSES:
        return None, "Invalid status."

    if user_id == current_user_id and status == "Inactive":
        return None, "You cannot disable your own account."

    existing = get_user_by_id(user_id)

    if existing is None:
        return None, "User not found."

    if existing["role"] == ROLE_SUPER_ADMIN and status == "Inactive":
        if count_active_super_admins(exclude_id=user_id) == 0:
            return None, "At least one active Super Admin must remain."

    if not update_user_status(user_id, status):
        return None, "User not found."

    return serialize_user(get_user_by_id(user_id)), None


def reset_password(user_id, new_password):

    error = validate_password(new_password, label="Password", strong=True)

    if error:
        return False, error

    if get_user_by_id(user_id) is None:
        return False, "User not found."

    if not reset_user_password(user_id, new_password):
        return False, "User not found."

    return True, None


def update_own_profile(current_user, name, email, username):
    """Self-service profile update. Unlike edit_user(), the target row is
    never taken from caller-supplied input — it is always current_user["id"],
    read straight from the authenticated session — so this function is
    structurally incapable of touching any account other than the caller's
    own, regardless of what the frontend sends. Role is also never accepted
    here; it stays exactly what the session already says it is. There is no
    Phone field on this form, so the caller's existing phone_number is
    always passed straight through unchanged."""

    name = (name or "").strip()
    email = (email or "").strip().lower()
    username = (username or "").strip()

    error = (
        validate_text_field(name, "Name", min_len=2, max_len=50)
        or validate_email(email)
        or validate_text_field(username, "Username", min_len=3, max_len=50)
    )

    if error:
        return None, error

    updated, error = update_user(
        current_user["id"], name, email, username, current_user["role"], current_user.get("phone_number")
    )

    if error:
        return None, error

    if not updated:
        return None, "User not found."

    return serialize_user(get_user_by_id(current_user["id"])), None


def change_own_password(current_user, new_password):

    error = validate_password(new_password, label="New Password", strong=True)

    if error:
        return False, error

    reset_user_password(current_user["id"], new_password)

    return True, None
