from auth.database import get_all_users, get_activity_logs, ROLE_COMPANY_ADMIN
from api.cameras import get_camera_counts_all, get_camera_counts_by_customer

RECENT_ACTIVITY_LIMIT = 20


def get_admin_dashboard_data():
    """Super Admin Dashboard data — Company Admin + Camera information
    only (no per-customer face-recognition/attendance/report totals; the
    Super Admin oversees companies and their camera fleets, individual
    customers' own Dashboards already cover their own operational data).

    "company_admin_camera_status" is one row per Company Admin, so a
    newly-created Company Admin appears automatically on the next fetch
    with zero cameras — no separate "onboarding" step needed.

    Camera counts per Company Admin are computed in a single grouped
    query (get_camera_counts_by_customer) rather than one query per
    company, so this stays fast as the number of companies grows."""

    all_users = get_all_users()
    company_admins = [u for u in all_users if u["role"] == ROLE_COMPANY_ADMIN]
    company_admin_ids = [admin["id"] for admin in company_admins]

    counts_by_customer = get_camera_counts_by_customer(company_admin_ids)

    company_admin_camera_status = []

    for admin in company_admins:
        counts = counts_by_customer[admin["id"]]
        total = counts["total"]
        online = counts["online"]

        company_admin_camera_status.append(
            {
                "customer_id": admin["id"],
                # The user model has a single "name" field for a Company
                # Admin account — there is no separate company-name vs
                # admin-person-name distinction in the schema today, so
                # both labels below intentionally show the same value.
                "company_name": admin["name"],
                "admin_name": admin["name"],
                "total_cameras": total,
                "online_cameras": online,
                "offline_cameras": total - online,
            }
        )

    camera_counts = get_camera_counts_all()
    cameras_offline = camera_counts["total"] - camera_counts["online"]

    recent_activity = [
        {
            "id": entry["id"],
            "user_name": entry["user_name"],
            "action": entry["action"],
            "details": entry["details"],
            "created_at": entry["created_at"],
        }
        for entry in get_activity_logs(limit=RECENT_ACTIVITY_LIMIT)
    ]

    return {
        "total_company_admins": len(company_admins),
        "total_cameras": camera_counts["total"],
        "cameras_online": camera_counts["online"],
        "cameras_offline": cameras_offline,
        "company_admin_camera_status": company_admin_camera_status,
        "recent_activity": recent_activity,
    }
