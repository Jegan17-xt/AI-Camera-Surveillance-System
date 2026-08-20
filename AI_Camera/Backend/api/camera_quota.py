"""Camera Limit / Camera Quota Management — the single source of truth
for every "how many cameras can this Admin/User have" question in the
app. Reused by api/admin_overview.py (Super Admin -> Admin Camera Limit),
api/company_users.py (Admin -> Per-User Camera Limit), and api/cameras.py
(actual enforcement at camera create/reassign time), so the same rules
apply everywhere instead of being reimplemented per caller.

Two independent checks exist, matching the two different moments they
apply at:

  - "Allocation budget" (validate_admin_capacity_for_user_limit) — when
    an Admin sets/changes a User's OWN camera_limit, the SUM of every
    User's camera_limit under that Admin must never exceed the Admin's
    own camera_limit. This is a budgeting check on the numbers
    themselves, independent of how many cameras actually exist yet.

  - "Actual usage" (validate_camera_creation_quota /
    validate_camera_reassignment_quota) — when a camera is actually
    created or reassigned, checked against REAL camera counts
    (api/cameras.py's get_camera_counts — never a cached/stored number),
    for both the Admin's own total and (if the camera is being assigned
    to one) that User's own total. This is what actually blocks the
    Add Camera action.

Reducing an Admin's or a User's camera_limit below their current actual
usage is always allowed — existing cameras are NEVER auto-deleted here
or anywhere else. The over-limit account simply can't create (or, for a
User, receive) another camera until real usage drops back within the new
limit — see each summary's "status" field ("Active" | "Over Limit").

camera_limit itself lives on auth.models.User (one column, reused for
both the Company Admin tier and the User tier — see that column's
comment). NULL = unlimited, same "absent means no enforcement"
convention this codebase already uses for Subscription.storage_limit_gb.
"""

from auth.database import get_user_by_id, get_users_by_parent, ROLE_COMPANY_ADMIN, ROLE_USER

ADMIN_LIMIT_EXCEEDED_MESSAGE = "Camera limit exceeded. Your Admin account has no remaining camera capacity."


def _camera_counts(customer_id, owner_user_id=None):
    """Lazy import — api/cameras.py imports THIS module (for the
    enforcement checks below), so importing api.cameras at module load
    time here would be a circular import. By the time this function
    actually runs, both modules are fully loaded, so a local import is
    safe and free of import-order issues."""

    from api.cameras import get_camera_counts

    return get_camera_counts(customer_id, owner_user_id=owner_user_id)


def _usage_fields(camera_limit, used):
    """Shared {remaining, over_limit_by, usage_percent, status} shape for
    both an Admin's and a User's summary — never negative numbers in the
    display fields (over_limit_by carries how far over instead)."""

    if camera_limit is None:
        return {"remaining": None, "over_limit_by": 0, "usage_percent": None, "status": "Active"}

    remaining = max(camera_limit - used, 0)
    over_limit_by = max(used - camera_limit, 0)
    usage_percent = round((used / camera_limit) * 100) if camera_limit > 0 else (100 if used > 0 else 0)
    status = "Over Limit" if over_limit_by > 0 else "Active"

    return {"remaining": remaining, "over_limit_by": over_limit_by, "usage_percent": usage_percent, "status": status}


def get_admin_camera_summary(customer_id):
    """One Company Admin's camera quota rollup. None if customer_id
    isn't a real Company Admin."""

    admin = get_user_by_id(customer_id)

    if admin is None or admin["role"] != ROLE_COMPANY_ADMIN:
        return None

    camera_limit = admin.get("camera_limit")
    used = _camera_counts(customer_id)["total"]

    users = get_users_by_parent(customer_id)
    # A User with no personal limit set (NULL = unlimited) doesn't
    # contribute a number to this sum — "unlimited" isn't a quantity to
    # budget against. Their actual cameras still count toward `used`
    # above and are still capped by the Admin's own camera_limit at
    # creation time either way (see validate_camera_creation_quota).
    allocated_to_users = sum(u.get("camera_limit") or 0 for u in users)

    return {
        "camera_limit": camera_limit,
        "used": used,
        "user_count": len(users),
        "allocated_to_users": allocated_to_users,
        **_usage_fields(camera_limit, used),
    }


def get_user_camera_summary(user_id):
    """One User's camera quota rollup. None if user_id isn't a real
    User-role account."""

    user = get_user_by_id(user_id)

    if user is None or user["role"] != ROLE_USER:
        return None

    camera_limit = user.get("camera_limit")
    used = _camera_counts(user["parent_admin_id"], owner_user_id=user_id)["total"]

    return {
        "camera_limit": camera_limit,
        "used": used,
        **_usage_fields(camera_limit, used),
    }


def validate_admin_capacity_for_user_limit(parent_admin_id, target_user_id, new_camera_limit):
    """An Admin setting/changing one User's camera_limit must never push
    the SUM of every User's camera_limit under that Admin above the
    Admin's own camera_limit. Returns an error message, or None if the
    change is within budget (including: Admin has no camera_limit at
    all, i.e. unlimited budget, or new_camera_limit itself is None/
    unlimited, which never consumes budget)."""

    admin = get_user_by_id(parent_admin_id)
    admin_limit = admin.get("camera_limit") if admin else None

    if admin_limit is None or new_camera_limit is None:
        return None

    users = get_users_by_parent(parent_admin_id)
    allocated_excluding_target = sum(
        u.get("camera_limit") or 0 for u in users if u["id"] != target_user_id
    )

    if allocated_excluding_target + new_camera_limit > admin_limit:
        return ADMIN_LIMIT_EXCEEDED_MESSAGE

    return None


def validate_camera_creation_quota(customer_id, owner_user_id):
    """Called from api/cameras.py's add_camera, before a brand-new camera
    is inserted. Checks the Admin's own actual usage (this company's
    real total cameras vs. their Super-Admin-set camera_limit) and, if
    this camera is being assigned to a specific User, that User's own
    actual usage too — both computed live, never trusted from the
    request. Returns an error message, or None if within quota."""

    admin_summary = get_admin_camera_summary(customer_id)

    if admin_summary and admin_summary["camera_limit"] is not None:
        if admin_summary["used"] >= admin_summary["camera_limit"]:
            return ADMIN_LIMIT_EXCEEDED_MESSAGE

    if owner_user_id is not None:
        user_summary = get_user_camera_summary(owner_user_id)

        if user_summary and user_summary["camera_limit"] is not None:
            if user_summary["used"] >= user_summary["camera_limit"]:
                return f"Camera limit reached. You can use up to {user_summary['camera_limit']} cameras."

    return None


def validate_camera_reassignment_quota(new_owner_user_id):
    """Called from api/cameras.py's update_camera, only when
    owner_user_id is actually being changed to a new, non-None User.
    Moving one existing camera between Users never changes the Admin's
    own company-wide total, so only the NEW owner's own quota needs
    checking here."""

    if new_owner_user_id is None:
        return None

    user_summary = get_user_camera_summary(new_owner_user_id)

    if user_summary and user_summary["camera_limit"] is not None:
        if user_summary["used"] >= user_summary["camera_limit"]:
            return f"Camera limit reached. This user can use up to {user_summary['camera_limit']} cameras."

    return None
