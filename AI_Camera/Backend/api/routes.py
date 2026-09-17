from flask import Blueprint, jsonify, request, session, send_from_directory, Response
from api.dashboard import get_dashboard_data, get_admin_user_camera_overview, dismiss_activity_event, clear_all_activity_events
from api.admin_dashboard import get_admin_dashboard_data
from camera.stream import (
    start_local,
    stop_local,
    get_local_status,
    generate_local_mjpeg,
    get_camera_stream_status,
    generate_camera_mjpeg,
)
from api.registered import (
    get_registered_persons,
    get_person_images,
    add_registered_person,
    update_registered_person,
    delete_registered_person,
    faces_folder,
)
from api.unknown import (
    get_unknown_persons,
    delete_unknown_person,
    delete_multiple_unknown_persons,
    delete_all_unknown_persons,
    unknown_folder,
    unknown_image_owner_ok,
)
from api.detection_events import (
    get_detection_events,
    get_detection_event_stats,
    delete_detection_event,
    delete_multiple_detection_events,
    delete_all_detection_events,
    detection_events_folder,
    event_image_owner_ok,
)
from api.attendance import (
    get_attendance_records,
    get_daily_report,
    get_report_filename,
    get_attendance_by_date,
    get_attendance_by_month,
    records_to_csv_bytes,
    clear_attendance_records,
    report_folder,
)
from api.reports import get_reports, get_report_filepath, get_report_content
from api.pdf_export import build_table_pdf
from api.settings import get_settings, save_settings, reset_settings
from api.normal_cameras import (
    get_normal_cameras_for_customer,
    get_normal_camera,
    add_normal_camera,
    update_normal_camera,
    delete_normal_camera,
)
from api.avatar import save_avatar, remove_avatar, get_avatar_owner, AVATAR_FOLDER
from api.branding import get_branding, update_app_name, update_logo, remove_logo, LOGO_FOLDER
from api.website_content import get_website_content, update_section, update_image, WEBSITE_FOLDER
from api.leads import list_leads, create_lead, delete_lead
from notifications.fcm import register_token as register_fcm_token, unregister_token as unregister_fcm_token, send_new_lead_notification, is_fcm_configured
from api.cameras import (
    get_cameras_for_customer,
    get_camera,
    add_camera,
    update_camera,
    delete_camera,
    get_camera_counts,
    validate_camera_brand,
    validate_connection_fields,
    validate_custom_rtsp,
    test_camera_connection,
    record_connection_test_result,
    set_camera_detection_enabled,
    DEFAULT_STREAM_QUALITY,
    CONNECTION_SUCCESS_MESSAGE,
    CONNECTION_FAILURE_MESSAGE,
)
from api.camera_quota import get_admin_camera_summary, get_user_camera_summary
from api.sites import (
    get_sites_for_customer,
    get_site,
    create_site,
    update_site,
    delete_site,
    set_site_status,
    get_site_access,
    set_site_access,
    check_site_status,
    user_has_site_access,
)
from api.ai_config import (
    get_ai_config,
    update_ai_config,
    reset_ai_config,
    validate_ai_settings,
    get_ai_flag_locks,
    COMPANY_ADMIN_AI_KEYS,
    COMPANY_ADMIN_AI_SETTINGS_KEYS,
)
from api.retention_settings import get_retention_settings, update_retention_settings
from auth.auth import (
    authenticate,
    serialize_user,
    get_current_user,
    module_required,
    super_admin_required,
    company_admin_required,
    company_or_user_required,
    admin_required,
    login_required,
    get_tenant_id,
    get_data_scope,
    is_self_target,
    resolve_settings_target_id,
)
from auth.database import (
    log_activity,
    log_security_event,
    get_activity_logs,
    get_user_by_id,
    delete_activity_log,
    delete_activity_logs,
    delete_all_activity_logs,
    bump_session_version,
    ROLE_SUPER_ADMIN,
    ROLE_COMPANY_ADMIN,
    ROLE_USER,
)
from auth.rate_limit import (
    is_login_blocked,
    record_failed_login,
    record_successful_login,
    is_camera_test_blocked,
    record_camera_test_attempt,
    rate_limited,
)
from error_logging import sanitize_sensitive_url
from auth.csrf import issue_csrf_token, set_csrf_cookie, clear_csrf_cookie
from api.notifications import (
    get_notifications,
    get_unread_count,
    mark_notification_read,
    mark_all_read,
    delete_notification,
)
from api.users import list_users, add_user, edit_user, remove_user, set_user_status, reset_password, change_own_password, update_own_profile
from api.permissions import list_permissions, get_user_permissions, update_user_permissions
from api.company_users import (
    list_company_users,
    get_company_user,
    add_company_user,
    edit_company_user,
    remove_company_user,
    set_company_user_status,
    reset_company_user_password,
    get_company_user_permissions,
    update_company_user_permissions,
    get_company_user_whatsapp_settings,
    update_company_user_whatsapp_settings,
    reset_company_user_whatsapp_settings,
    update_company_user_avatar,
    remove_company_user_avatar,
    set_company_user_camera_limit,
)
from api.subscriptions import list_subscriptions, upsert_subscription, get_subscription, list_payments, add_payment
from api.billing import (
    list_billable_items,
    create_billable_item,
    update_billable_item,
    delete_billable_item,
    set_item_price_override,
    clear_item_price_override,
    set_item_access,
    get_billing_config,
    update_billing_config,
    get_billing_overview,
    get_company_billing_detail,
    get_checkout_context,
    checkout,
)
from api.module_packages import (
    get_package_catalog,
    update_package,
    set_submodule_enabled,
    set_package_price_override,
    clear_package_price_override,
    assign_package,
    get_company_packages,
    checkout_packages,
)
from api.admin_overview import (
    list_admin_overview,
    get_admin_overview_detail,
    get_user_storage_detail,
    set_company_storage_limit,
    set_admin_camera_limit,
)
from api.unknown_analytics import get_unknown_person_analytics
from api.validators import validate_email, validate_calendar_date, validate_month
from face.database import reload_database
from api.notification_settings import (
    get_notification_settings,
    update_unknown_alert_settings,
    update_detection_alert_settings,
    update_daily_report_settings,
    reset_notification_settings,
)
from notifications.service import get_notification_logs, delete_notification_log
from notifications.image_links import verify_public_image_link, verify_public_document_link, verify_public_event_image_link
from reports.daily_report import (
    generate_and_send_daily_report,
    get_report_logs,
    delete_report_log,
    get_report_filepath as get_daily_report_filepath,
    report_folder as daily_report_folder,
)
import os

api = Blueprint("api", __name__)


def _mutation_owner_restriction(current_user):
    """Per-User Data Isolation: for a mutation (edit/delete a specific
    camera/registered person/unknown person/attendance row/
    notification), a User caller must be restricted to rows they
    actually own — never trusted to pass this themselves. A Company
    Admin's own mutations stay unrestricted (None), exactly as before
    this feature — the Admin is already company-wide authorized by
    role, independent of whatever User happens to be selected in their
    UI filter."""

    return current_user["id"] if current_user["role"] == ROLE_USER else None


# Max page size a caller may request via ?limit= on an endpoint that opts
# into pagination below — same ceiling notification_logs_get/
# notification_settings' own paged endpoints already cap at, so a caller
# can never force one of these into effectively returning everything
# anyway.
_MAX_PAGE_LIMIT = 500


def _parse_pagination_args():
    """(limit, offset) from ?limit=/?offset=, or (None, None) if neither
    is present — the default, unbounded behavior every existing caller
    already gets, since nothing in this app sends these params yet.
    Malformed values are ignored (fall back to unbounded) rather than
    erroring, since a bad param here should never break a list page that
    would otherwise have loaded fine."""

    limit = None
    offset = None

    raw_limit = request.args.get("limit")
    if raw_limit is not None:
        try:
            limit = max(0, min(int(raw_limit), _MAX_PAGE_LIMIT))
        except (TypeError, ValueError):
            limit = None

    raw_offset = request.args.get("offset")
    if raw_offset is not None:
        try:
            offset = max(0, int(raw_offset))
        except (TypeError, ValueError):
            offset = None

    return limit, offset


# ==============================
# Authentication API
# ==============================
@api.route("/login", methods=["POST"])
def login():

    data = request.get_json(silent=True) or {}

    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    remember = bool(data.get("remember"))

    # .strip() here only DECIDES whether a password was actually provided
    # (a whitespace-only string is not a real password) — the untrimmed
    # `password` value below is still what's checked against the stored
    # hash, since a real password could legitimately contain meaningful
    # leading/trailing whitespace.
    if not email or not password.strip():
        return jsonify({"success": False, "message": "Email and password are required."}), 400

    email_error = validate_email(email)
    if email_error:
        return jsonify({"success": False, "message": email_error}), 400

    client_ip = request.remote_addr or "unknown"

    blocked, retry_after = is_login_blocked(client_ip, email)
    if blocked:
        log_security_event("Login Blocked (Rate Limited)", success=False, details=email)
        return jsonify({
            "success": False,
            "message": f"Too many failed login attempts. Try again in {retry_after} seconds.",
        }), 429

    user = authenticate(email, password)

    if not user:
        record_failed_login(client_ip, email)
        log_security_event("Login Failed", success=False, details=email)
        return jsonify({"success": False, "message": "Invalid email or password."}), 401

    record_successful_login(client_ip, email)

    session.clear()
    session["user_id"] = user["id"]
    session["session_version"] = user["session_version"]
    csrf_token = issue_csrf_token()
    session["csrf_token"] = csrf_token
    session.permanent = remember

    log_security_event("Login", user=user)

    response = jsonify({"success": True, "user": serialize_user(user)})
    set_csrf_cookie(response, csrf_token)
    return response


@api.route("/logout", methods=["POST"])
def logout():

    user = get_current_user()

    if user:
        log_security_event("Logout", user=user)

    session.clear()

    response = jsonify({"success": True, "message": "Logged out successfully."})
    clear_csrf_cookie(response)
    return response


@api.route("/me", methods=["GET"])
def me():

    user = get_current_user()

    if not user:
        return jsonify({"success": False, "message": "Not authenticated."}), 401

    return jsonify({"success": True, "user": serialize_user(user)})


# ==============================
# Dashboard API
# ==============================
@api.route("/dashboard", methods=["GET"])
@module_required("dashboard")
def dashboard():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    data = get_dashboard_data(scope["customer_id"], owner_user_id=scope["owner_user_id"])

    return jsonify(data)


# Admin Dashboard's "User & Camera Overview" section — Company-Admin-only
# (a User account has no sub-users/company-wide camera list to show an
# overview of; get_data_scope's per-User forcing doesn't apply here at
# all, this route simply never reaches a User caller).
@api.route("/dashboard/user-camera-overview", methods=["GET"])
@company_admin_required
@module_required("dashboard")
def dashboard_user_camera_overview():

    current_user = get_current_user()
    data = get_admin_user_camera_overview(get_tenant_id(current_user))

    return jsonify(data)


# Super Admin Dashboard — platform-wide totals across every customer,
# distinct from the per-customer /dashboard above.
@api.route("/admin/dashboard", methods=["GET"])
@super_admin_required
def admin_dashboard():

    return jsonify(get_admin_dashboard_data())


@api.route("/dashboard/activity/<event_id>", methods=["DELETE"])
@module_required("dashboard")
def dashboard_activity_delete(event_id):

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    dismiss_activity_event(scope["customer_id"], event_id, owner_user_id=scope["owner_user_id"])

    return jsonify({"success": True, "message": "Activity removed."})


@api.route("/dashboard/activity", methods=["DELETE"])
@module_required("dashboard")
def dashboard_activity_clear_all():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    clear_all_activity_events(scope["customer_id"], owner_user_id=scope["owner_user_id"])

    return jsonify({"success": True, "message": "Activity feed cleared."})


# ==============================
# Live Camera API
# ==============================
# Every stream here is one specific customer-owned camera's own RTSP
# source — never a local webcam. get_camera(camera_id, customer_id) is
# ownership-scoped, so a camera_id belonging to a different customer 404s
# instead of ever being opened.
@api.route("/live-camera/status/<int:camera_id>", methods=["GET"])
@module_required("live_camera")
def live_camera_status(camera_id):

    current_user = get_current_user()
    # Per-User Data Isolation: a User caller is restricted to a camera
    # they actually own, same _mutation_owner_restriction pattern as
    # every /company/cameras* mutation (api/cameras.py) — previously
    # this only checked tenant, so a User could view/stream ANY camera
    # in their company, not just their own. A Company Admin/Super Admin
    # caller is unrestricted (None), unchanged.
    camera = get_camera(
        camera_id, get_tenant_id(current_user),
        restrict_to_owner_user_id=_mutation_owner_restriction(current_user),
    )

    if camera is None:
        return jsonify({"success": False, "message": "Camera not found."}), 404

    return jsonify(get_camera_stream_status(camera_id, get_tenant_id(current_user), camera["rtsp_url"]))


@api.route("/live-camera/stream/<int:camera_id>", methods=["GET"])
@module_required("live_camera")
def live_camera_stream(camera_id):

    current_user = get_current_user()
    # Same Per-User Data Isolation restriction as live_camera_status above.
    camera = get_camera(
        camera_id, get_tenant_id(current_user),
        restrict_to_owner_user_id=_mutation_owner_restriction(current_user),
    )

    if camera is None:
        return jsonify({"success": False, "message": "Camera not found."}), 404

    response = Response(
        generate_camera_mjpeg(camera_id, get_tenant_id(current_user), camera["rtsp_url"]),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )
    # Without this, Werkzeug (especially under debug=True, whose debugger
    # middleware wraps every response) can try to fully materialize this
    # generator into memory to compute Content-Length/support the
    # response cache — which never completes for an intentionally
    # infinite MJPEG stream, so the client gets zero bytes, ever. This is
    # the actual "connects but the video never starts / freezes forever"
    # root cause: not a slow frame, but the HTTP response itself never
    # being flushed. direct_passthrough tells Werkzeug this response's
    # body must be sent exactly as produced, one chunk at a time.
    response.direct_passthrough = True
    return response


# Explicit, opt-in local-webcam DEBUG MODE — reached ONLY when the
# frontend's "Use Local Camera" button / ON-OFF toggle is used. Runs
# through the exact same detection_service worker + process_frame()
# pipeline as a real RTSP camera (see camera/stream.py, camera/
# detection_service.py) — scoped to whichever customer is logged in,
# same as every other endpoint here.
#
# start/stop are the ONLY two endpoints that ever start or stop the
# webcam worker — status/stream below are pure reads, exactly like the
# RTSP camera endpoints, so polling status can never itself resurrect a
# webcam the toggle just turned off.
@api.route("/live-camera/local/start", methods=["POST"])
@module_required("live_camera")
def live_camera_local_start():

    current_user = get_current_user()
    # Same scope resolution every other per-user-isolated endpoint uses
    # (see /dashboard above): with no requested_user_id, a logged-in User
    # always gets their own id back, and a Company Admin's own general
    # test stays unassigned/pooled (None) — exactly today's behavior,
    # see camera/stream.py's start_local().
    scope = get_data_scope(current_user)
    return jsonify(start_local(scope["customer_id"], owner_user_id=scope["owner_user_id"]))


@api.route("/live-camera/local/stop", methods=["POST"])
@module_required("live_camera")
def live_camera_local_stop():

    stop_local()
    return jsonify({"success": True})


@api.route("/live-camera/local/status", methods=["GET"])
@module_required("live_camera")
def live_camera_local_status():

    current_user = get_current_user()
    return jsonify(get_local_status(get_tenant_id(current_user)))


@api.route("/live-camera/local/stream", methods=["GET"])
@module_required("live_camera")
def live_camera_local_stream():

    current_user = get_current_user()

    response = Response(
        generate_local_mjpeg(get_tenant_id(current_user)),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )
    # See the identical comment on live_camera_stream() above — same
    # infinite-generator-must-not-be-buffered fix, same reason.
    response.direct_passthrough = True
    return response


# ==============================
# Registered Persons API
# ==============================
@api.route("/registered", methods=["GET"])
@module_required("registered_persons", "registered_persons_view")
def registered():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    # Optional paging — see _parse_pagination_args()'s own comment.
    limit, offset = _parse_pagination_args()

    persons, total = get_registered_persons(
        scope["customer_id"], owner_user_id=scope["owner_user_id"], limit=limit, offset=offset
    )

    return jsonify({
        "total": total,
        "persons": persons,
    })


# Create Registered Person API
@api.route("/registered", methods=["POST"])
@module_required("registered_persons")
def registered_create():

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    name = request.form.get("name")
    employee_id = request.form.get("employee_id")
    images = request.files.getlist("images")

    # Per-User Data Isolation: a User's own additions are ALWAYS owned by
    # themselves, forced server-side — never trusted from the form. Only
    # a Company Admin may explicitly assign (or leave unassigned).
    if current_user["role"] == ROLE_USER:
        owner_user_id = current_user["id"]
    else:
        raw_owner = request.form.get("owner_user_id")
        owner_user_id = None if raw_owner in (None, "", "null") else int(raw_owner)

    person, error = add_registered_person(tenant_id, name, employee_id, images, owner_user_id=owner_user_id)

    if error:
        # Sanitized operational log (Phase 2): customer/error-category
        # only — no person name, no image data. Replaces this route's
        # earlier "[DEBUG][registered_create]" prints, which logged the
        # person's name next to the customer id on every request.
        print(f"[registered_create] FAILED customer={tenant_id} error_category={error!r}")
        return jsonify({"success": False, "message": error}), 400

    reload_database(tenant_id)

    log_security_event(
        "Person Registered",
        user=current_user,
        target_type="registered_person",
        target_id=person["id"],
    )

    return jsonify({"success": True, "person": person}), 201


# Serve Registered Face Images
@api.route("/faces/<person>/<filename>", methods=["GET"])
@module_required("registered_persons", "registered_persons_view")
def face_image(person, filename):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    # Per-User Data Isolation: previously this served any face image
    # under this customer_id with no ownership check at all — a User
    # could view a sibling User's (or the Admin's) registered face
    # images just by guessing/copying a person name from another tab.
    # get_person_images() already does the real ownership-scoped DB
    # lookup; reusing it here as an existence+ownership gate, not for
    # its return value.
    restrict_to = _mutation_owner_restriction(current_user)
    if get_person_images(tenant_id, person, owner_user_id=restrict_to) is None:
        return jsonify({"success": False, "message": "Not found."}), 404

    person_folder = os.path.join(faces_folder(tenant_id), person)

    return send_from_directory(person_folder, filename)


# List a Registered Person's Face Images (for the Edit form)
@api.route("/registered/<person_name>/images", methods=["GET"])
@module_required("registered_persons", "registered_persons_view")
def registered_images(person_name):

    current_user = get_current_user()
    images = get_person_images(
        get_tenant_id(current_user), person_name, owner_user_id=_mutation_owner_restriction(current_user)
    )

    if images is None:
        return jsonify({"success": False, "message": "Person not found."}), 404

    return jsonify({
        "images": [
            {"filename": f, "url": f"http://localhost:5000/faces/{person_name}/{f}"}
            for f in images
        ]
    })


# Update Registered Person API
@api.route("/registered/<person_name>", methods=["PUT"])
@module_required("registered_persons")
def registered_update(person_name):

    current_user = get_current_user()

    new_name = request.form.get("name")
    employee_id = request.form.get("employee_id")
    new_images = request.files.getlist("images")
    removed_images = request.form.getlist("removed_images")

    # Same owner_user_id rule as create: only a Company Admin may
    # reassign; a User caller never touches this field (the sentinel
    # default in update_registered_person leaves ownership untouched).
    kwargs = {}
    if current_user["role"] != ROLE_USER and "owner_user_id" in request.form:
        raw_owner = request.form.get("owner_user_id")
        kwargs["owner_user_id"] = None if raw_owner in (None, "", "null") else int(raw_owner)

    person, error = update_registered_person(
        get_tenant_id(current_user), person_name, new_name, employee_id, new_images, removed_images,
        restrict_to_owner_user_id=_mutation_owner_restriction(current_user),
        **kwargs,
    )

    if error:
        status_code = 404 if error == "Person not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    reload_database(get_tenant_id(current_user))

    log_security_event(
        "Person Face Data Updated",
        user=current_user,
        target_type="registered_person",
        target_id=person["id"],
        details=person_name,
        company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "person": person})


# Delete Registered Person API
@api.route("/registered/<person_name>", methods=["DELETE"])
@module_required("registered_persons")
def delete_registered(person_name):

    current_user = get_current_user()
    deleted = delete_registered_person(
        get_tenant_id(current_user), person_name, owner_user_id=_mutation_owner_restriction(current_user)
    )

    if not deleted:
        return jsonify({"success": False, "message": "Person not found."}), 404

    reload_database(get_tenant_id(current_user))

    log_security_event(
        "Person Face Data Deleted",
        user=current_user,
        target_type="registered_person",
        details=person_name,
        company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "message": f"{person_name} deleted successfully."})


# ==============================
# Unknown Persons API
# ==============================
@api.route("/unknown-persons", methods=["GET"])
@module_required("unknown_persons")
def unknown_persons():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    # Optional paging — omitted entirely by every existing caller today,
    # so the default (both None) is the exact same unbounded response as
    # before this was added. Same "?limit=" idiom already used by
    # /account/notifications and /notifications/logs, capped the same way.
    limit, offset = _parse_pagination_args()

    persons, total = get_unknown_persons(
        scope["customer_id"], owner_user_id=scope["owner_user_id"], limit=limit, offset=offset
    )

    return jsonify({
        "total": total,
        "persons": persons,
    })


# Serve Unknown Face Images
@api.route("/unknown/<filename>", methods=["GET"])
@module_required("unknown_persons")
def unknown_image(filename):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    if not unknown_image_owner_ok(tenant_id, filename, owner_user_id=_mutation_owner_restriction(current_user)):
        return jsonify({"success": False, "message": "Not found."}), 404

    return send_from_directory(unknown_folder(tenant_id), filename)


# Serve Unknown Face Images — Public, Signed (WhatsApp ImageUrl)
# Deliberately outside every @module_required/@admin_required/session
# check on this file — wa.mydreamstechnology.in's servers fetch
# ImageUrl anonymously and can't hold a login session. Safe anyway:
# access is gated by the HMAC signature + expiry (see
# notifications/image_links.py), not by who's asking. expires/sig are
# PATH segments rather than a query string on purpose — confirmed live
# that sendtemplate.php's ImageUrl silently fails to attach the moment
# the URL has a `?...` on it, even on a host that otherwise works fine.
@api.route("/public/unknown-image/<int:customer_id>/<int:expires>/<sig>/<filename>", methods=["GET"])
def public_unknown_image(customer_id, expires, sig, filename):

    if not verify_public_image_link(customer_id, filename, expires, sig):
        return jsonify({"success": False, "message": "Invalid or expired link."}), 403

    return send_from_directory(unknown_folder(customer_id), filename)


# Serve Daily Report PDFs — Public, Signed (WhatsApp DocumentUrl). Same
# "anonymous fetch, gated by HMAC signature + expiry, not by who's
# asking" shape as public_unknown_image above — see
# notifications/image_links.py's build_public_document_url.
@api.route("/public/daily-report/<int:customer_id>/<int:expires>/<sig>/<filename>", methods=["GET"])
def public_daily_report_document(customer_id, expires, sig, filename):

    if not verify_public_document_link(customer_id, filename, expires, sig):
        return jsonify({"success": False, "message": "Invalid or expired link."}), 403

    return send_from_directory(daily_report_folder(customer_id), filename)


# Serve AI Detection Alert snapshots (fire/smoke/vehicle/animal/bird) —
# Public, Signed (WhatsApp ImageUrl). Same "anonymous fetch, gated by
# HMAC signature + expiry, not by who's asking" shape as
# public_unknown_image above — see notifications/image_links.py's
# build_public_event_image_url. <path:relpath> (not <filename>) because
# DetectionEvent.image_path is a "<DD-MM-YYYY>/<file>.jpg" subfolder
# path, same converter /detection-events/image/<customer_id>/<relpath>
# already uses for the session-gated version of this same file.
@api.route("/public/event-image/<int:customer_id>/<int:expires>/<sig>/<path:relpath>", methods=["GET"])
def public_event_image(customer_id, expires, sig, relpath):

    if not verify_public_event_image_link(customer_id, relpath, expires, sig):
        return jsonify({"success": False, "message": "Invalid or expired link."}), 403

    return send_from_directory(detection_events_folder(customer_id), relpath)


# Public pricing — the Zynez marketing / landing page's Pricing + Add-ons
# sections. Read-only, no session required, no per-company scope: it
# returns the SAME global catalog the Super Admin configures
# (get_package_catalog() / list_billable_items() with no customer_id, so
# no BillableItemPriceOverride / BillableItemAccess is ever consulted).
# Nothing here is writable and it changes no existing behaviour — it is
# purely an anonymous read of the already-existing pricing model, so the
# landing page never has to hardcode a price.
@api.route("/public/pricing", methods=["GET"])
def public_pricing():

    packages = get_package_catalog()["packages"]

    addons = [
        item
        for item in list_billable_items()
        if item.get("enabled") and item.get("activation_type") != "module"
    ]

    return jsonify({
        "packages": packages,
        "addons": addons,
        "billing_config": get_billing_config(),
    })


# Public website content — every piece of landing-page copy/imagery the
# Super Admin edits from Website Settings (see api/website_content.py).
# Same "anonymous, read-only, global, no session" reasoning as
# public_pricing directly above: the landing page has no login, so this
# must be reachable with no decorator at all.
@api.route("/public/website-content", methods=["GET"])
def public_website_content():

    return jsonify(get_website_content())


# Serve Website Content images (hero/section/logo) — public and
# undecorated like the route above, since anonymous landing-page
# visitors must be able to load them. Writable only via the
# @super_admin_required routes further below.
@api.route("/public/website-content/image/<filename>", methods=["GET"])
def public_website_content_image(filename):

    return send_from_directory(WEBSITE_FOLDER, filename)


# Public lead submission — the landing page's Interest & Lead popup AND
# its Contact section form (Frontend/Ai_FE/src/pages/Landing.jsx), both
# posting here with a different `source`. Anonymous, no session, same
# reasoning as public_pricing/public_website_content above: the landing
# page has no login. Rate-limited per IP (not per user — there is no
# user yet) so the endpoint can't be used to flood the leads table.
@api.route("/public/leads", methods=["POST"])
@rate_limited("public_leads", max_attempts=10, window_seconds=600, per="ip")
def public_leads_create():

    data = request.get_json(silent=True) or {}

    lead, error, is_new = create_lead(
        data.get("name"),
        data.get("phone"),
        data.get("address"),
        data.get("email"),
        source=data.get("source") or "Landing Page",
        # Real GPS coordinates (browser Geolocation API), entirely
        # optional — see Frontend/Ai_FE/src/lib/geolocation.js and
        # create_lead's own docstring. Absent/invalid values never block
        # this submission; they're just stored as NULL.
        latitude=data.get("latitude"),
        longitude=data.get("longitude"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    # Super Admin push notification (notifications/fcm.py) — only for a
    # genuinely NEW lead (is_new, from create_lead itself — never
    # inferred from timestamps, which can coincidentally match on a
    # same-second duplicate update too), never a duplicate-phone update.
    # Exception-isolated inside send_new_lead_notification itself: a
    # push failure can never turn this into a 500 or affect the lead
    # that's already saved.
    if is_new:
        send_new_lead_notification(lead)

    return jsonify({"success": True, "lead": lead})


# Delete Unknown Person API
@api.route("/unknown/<unknown_id>", methods=["DELETE"])
@module_required("unknown_persons")
def delete_unknown(unknown_id):

    current_user = get_current_user()
    deleted = delete_unknown_person(
        get_tenant_id(current_user), unknown_id, owner_user_id=_mutation_owner_restriction(current_user)
    )

    if not deleted:
        return jsonify({"success": False, "message": "Unknown person not found."}), 404

    return jsonify({"success": True, "message": f"{unknown_id} deleted successfully."})


# Delete Multiple Unknown Persons API
@api.route("/unknown-persons/bulk-delete", methods=["POST"])
@module_required("unknown_persons")
def delete_unknown_bulk():

    current_user = get_current_user()

    data = request.get_json(silent=True) or {}
    ids = data.get("ids")

    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No unknown persons selected."}), 400

    deleted_count = delete_multiple_unknown_persons(
        get_tenant_id(current_user), ids, owner_user_id=_mutation_owner_restriction(current_user)
    )

    return jsonify({"success": True, "deleted": deleted_count})


# Delete All Unknown Persons API
@api.route("/unknown-persons", methods=["DELETE"])
@module_required("unknown_persons")
def delete_unknown_all():

    current_user = get_current_user()
    deleted_count = delete_all_unknown_persons(
        get_tenant_id(current_user), owner_user_id=_mutation_owner_restriction(current_user)
    )

    return jsonify({"success": True, "deleted": deleted_count})


# ==============================
# Detection Events API (Multi-Object & Fire Detection)
# ==============================
# The unified feed of every non-attendance detection: vehicles, animals,
# fire, smoke (own table), plus PERSON_DETECTED / UNKNOWN_FACE merged in
# from the attendance / unknown_persons tables at read time. Same
# per-user isolation + optional paging idiom as /unknown-persons above.
@api.route("/detection-events", methods=["GET"])
@module_required("detection_events")
def detection_events():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    limit, offset = _parse_pagination_args()

    camera_id = request.args.get("camera_id")
    try:
        camera_id = int(camera_id) if camera_id not in (None, "") else None
    except (TypeError, ValueError):
        camera_id = None

    events, total = get_detection_events(
        scope["customer_id"],
        owner_user_id=scope["owner_user_id"],
        event_types=request.args.get("type"),
        camera_id=camera_id,
        limit=limit,
        offset=offset,
    )

    return jsonify({"total": total, "events": events})


@api.route("/detection-events/stats", methods=["GET"])
@module_required("detection_events")
def detection_events_stats():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    return jsonify({"stats": get_detection_event_stats(scope["customer_id"], owner_user_id=scope["owner_user_id"])})


# Serve a fire/smoke snapshot. relpath is "<DD-MM-YYYY>/<type>_<HH-MM-SS>.jpg"
# (a subfolder path) — <path:> converter, then the same existence +
# ownership gate as /unknown/<filename>.
@api.route("/detection-events/image/<int:customer_id>/<path:relpath>", methods=["GET"])
@module_required("detection_events")
def detection_event_image(customer_id, relpath):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    if customer_id != tenant_id:
        return jsonify({"success": False, "message": "Not found."}), 404

    if not event_image_owner_ok(tenant_id, relpath, owner_user_id=_mutation_owner_restriction(current_user)):
        return jsonify({"success": False, "message": "Not found."}), 404

    return send_from_directory(detection_events_folder(tenant_id), relpath)


@api.route("/detection-events/<event_id>", methods=["DELETE"])
@module_required("detection_events")
def detection_event_delete(event_id):

    current_user = get_current_user()
    deleted = delete_detection_event(
        get_tenant_id(current_user), event_id, owner_user_id=_mutation_owner_restriction(current_user)
    )

    if not deleted:
        return jsonify({"success": False, "message": "Detection event not found."}), 404

    return jsonify({"success": True, "message": f"{event_id} deleted successfully."})


@api.route("/detection-events/bulk-delete", methods=["POST"])
@module_required("detection_events")
def detection_events_bulk_delete():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")

    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No detection events selected."}), 400

    deleted_count = delete_multiple_detection_events(
        get_tenant_id(current_user), ids, owner_user_id=_mutation_owner_restriction(current_user)
    )

    return jsonify({"success": True, "deleted": deleted_count})


@api.route("/detection-events", methods=["DELETE"])
@module_required("detection_events")
def detection_events_clear():

    current_user = get_current_user()
    deleted_count = delete_all_detection_events(
        get_tenant_id(current_user), owner_user_id=_mutation_owner_restriction(current_user)
    )

    return jsonify({"success": True, "deleted": deleted_count})


# ==============================
# Attendance API
# ==============================
@api.route("/attendance", methods=["GET"])
@module_required("attendance")
def attendance():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    # Optional paging — see _parse_pagination_args()'s own comment.
    limit, offset = _parse_pagination_args()

    records, present, absent, total = get_attendance_records(
        scope["customer_id"], owner_user_id=scope["owner_user_id"], limit=limit, offset=offset
    )

    return jsonify({
        "total": total,
        "present": present,
        "absent": absent,
        "attendance": records,
    })


# Attendance Report API
@api.route("/attendance/report/<date>", methods=["GET"])
@module_required("attendance")
def attendance_report(date):

    current_user = get_current_user()
    rows = get_daily_report(get_tenant_id(current_user), date)

    if rows is None:
        return jsonify({"success": False, "message": "Report not found."}), 404

    return jsonify({"date": date, "report": rows})


# Download Attendance Report CSV
@api.route("/attendance/download/<date>", methods=["GET"])
@module_required("attendance")
def attendance_download(date):

    current_user = get_current_user()
    filename = get_report_filename(get_tenant_id(current_user), date)

    if filename is None:
        return jsonify({"success": False, "message": "Report not found."}), 404

    return send_from_directory(report_folder(get_tenant_id(current_user)), filename, as_attachment=True)


# Export Attendance Records (CSV) — real per-person attendance rows for a
# single date or an entire month, used by the Reports page Daily/Monthly
# Export CSV buttons.
@api.route("/attendance/export/csv", methods=["GET"])
@module_required("attendance")
def attendance_export_csv():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    date = request.args.get("date")
    month = request.args.get("month")

    if date:
        error, _parsed = validate_calendar_date(date, label="Date", allow_future=False)
        if error:
            return jsonify({"success": False, "message": error}), 400
        records = get_attendance_by_date(scope["customer_id"], date, owner_user_id=scope["owner_user_id"])
        label = date
    elif month:
        error, _parsed = validate_month(month, label="Month", allow_future=False)
        if error:
            return jsonify({"success": False, "message": error}), 400
        records = get_attendance_by_month(scope["customer_id"], month, owner_user_id=scope["owner_user_id"])
        label = month
    else:
        return jsonify({"success": False, "message": "A date or month is required."}), 400

    if not records:
        return jsonify({"success": False, "message": "No records available to export."}), 404

    csv_bytes = records_to_csv_bytes(records)

    return Response(
        csv_bytes,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=attendance_report_{label}.csv"},
    )


# Export Attendance Records (PDF) — same filtered data as the CSV export,
# used by the Reports page Daily/Monthly Export PDF buttons.
@api.route("/attendance/export/pdf", methods=["GET"])
@module_required("attendance")
def attendance_export_pdf():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    date = request.args.get("date")
    month = request.args.get("month")

    if date:
        error, _parsed = validate_calendar_date(date, label="Date", allow_future=False)
        if error:
            return jsonify({"success": False, "message": error}), 400
        records = get_attendance_by_date(scope["customer_id"], date, owner_user_id=scope["owner_user_id"])
        label = date
        subtitle = f"Daily Attendance Report - {date}"
    elif month:
        error, _parsed = validate_month(month, label="Month", allow_future=False)
        if error:
            return jsonify({"success": False, "message": error}), 400
        records = get_attendance_by_month(scope["customer_id"], month, owner_user_id=scope["owner_user_id"])
        label = month
        subtitle = f"Monthly Attendance Report - {month}"
    else:
        return jsonify({"success": False, "message": "A date or month is required."}), 400

    if not records:
        return jsonify({"success": False, "message": "No records available to export."}), 404

    pdf_bytes = build_table_pdf(
        title="Attendance Report",
        subtitle=subtitle,
        headers=["Name", "Date", "In Time", "Out Time", "Status"],
        rows=[[r["name"], r["date"], r["in_time"], r["out_time"], r["status"]] for r in records],
    )

    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=attendance_report_{label}.pdf"},
    )


# Clear Attendance Logs — used by Settings > Storage > Clear Attendance Logs.
@api.route("/attendance", methods=["DELETE"])
@module_required("attendance")
def attendance_clear():

    current_user = get_current_user()
    clear_attendance_records(
        get_tenant_id(current_user), owner_user_id=_mutation_owner_restriction(current_user)
    )

    return jsonify({"success": True, "message": "Attendance logs cleared."})


# ==============================
# Reports API
# ==============================
@api.route("/reports", methods=["GET"])
@module_required("reports")
def reports():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    data = get_reports(scope["customer_id"], owner_user_id=scope["owner_user_id"])

    return jsonify({
        "total_reports": len(data),
        "reports": data,
    })


# Download Report CSV — the raw file/row itself stays company-wide (see
# api/reports.py), not scoped by owner_user_id.
@api.route("/reports/download/<filename>", methods=["GET"])
@module_required("reports")
def reports_download(filename):

    current_user = get_current_user()
    safe_filename = get_report_filepath(get_tenant_id(current_user), filename)

    if safe_filename is None:
        return jsonify({"success": False, "message": "Report not found."}), 404

    return send_from_directory(report_folder(get_tenant_id(current_user)), safe_filename, as_attachment=True)


# View Report Contents
@api.route("/reports/view/<filename>", methods=["GET"])
@module_required("reports")
def reports_view(filename):

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    records = get_report_content(scope["customer_id"], filename, owner_user_id=scope["owner_user_id"])

    if records is None:
        return jsonify({"success": False, "message": "Report not found."}), 404

    return jsonify({"file_name": filename, "records": records})


# ==============================
# Settings API
# ==============================
@api.route("/settings", methods=["GET"])
@module_required("settings")
def settings_get():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))
    return jsonify({"settings": get_settings(target_id)})


@api.route("/settings", methods=["PUT"])
@module_required("settings")
def settings_update():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))
    data = request.get_json(silent=True) or {}

    updated, error = save_settings(target_id, data)

    if error:
        return jsonify({"success": False, "message": error}), 400

    return jsonify({"success": True, "settings": updated})


@api.route("/settings/reset", methods=["POST"])
@module_required("settings")
def settings_reset():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))

    return jsonify({"success": True, "settings": reset_settings(target_id)})


# ==============================
# User Management API (Super Admin only)
# ==============================
@api.route("/users", methods=["GET"])
@super_admin_required
def users_list():

    users = list_users()

    return jsonify({"total": len(users), "users": users})


@api.route("/users/<int:user_id>", methods=["GET"])
@super_admin_required
def users_get_one(user_id):

    user = get_user_by_id(user_id)

    if user is None:
        return jsonify({"success": False, "message": "User not found."}), 404

    return jsonify({"success": True, "user": serialize_user(user)})


@api.route("/users", methods=["POST"])
@super_admin_required
def users_create():

    data = request.get_json(silent=True) or {}

    user, error = add_user(
        data.get("name"),
        data.get("email"),
        data.get("username"),
        data.get("password"),
        data.get("role"),
        data.get("status") or "Active",
        data.get("phone_number"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Customer Created", details=user["email"], user_id=current_user["id"],
        target_type="user", target_id=user["id"],
    )

    return jsonify({"success": True, "user": user}), 201


@api.route("/users/<int:user_id>", methods=["PUT"])
@super_admin_required
def users_update(user_id):

    current_user = get_current_user()

    # This endpoint exists for a Super Admin to edit OTHER accounts
    # (customers). Editing your own account must go through
    # /account/profile instead, which derives its target solely from the
    # session — never from a caller-supplied id — so account isolation
    # can't depend on this route always being called with the "right" id.
    if user_id == current_user["id"]:
        return jsonify({
            "success": False,
            "message": "Use the My Account page to update your own profile.",
        }), 400

    data = request.get_json(silent=True) or {}

    user, error = edit_user(
        user_id,
        data.get("name"),
        data.get("email"),
        data.get("username"),
        data.get("role"),
        data.get("phone_number"),
    )

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"], "Customer Updated", details=user["email"], user_id=current_user["id"],
        target_type="user", target_id=user_id,
    )

    return jsonify({"success": True, "user": user})


@api.route("/users/<int:user_id>", methods=["DELETE"])
@super_admin_required
def users_delete(user_id):

    current_user = get_current_user()
    target = get_user_by_id(user_id)

    success, error = remove_user(user_id, current_user["id"])

    if not success:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"],
        "Customer Deleted",
        details=target["email"] if target else str(user_id),
        user_id=current_user["id"],
        target_type="user", target_id=user_id,
    )

    return jsonify({"success": True, "message": "User deleted successfully."})


@api.route("/users/<int:user_id>/status", methods=["PUT"])
@super_admin_required
def users_set_status(user_id):

    data = request.get_json(silent=True) or {}
    current_user = get_current_user()

    user, error = set_user_status(user_id, data.get("status"), current_user["id"])

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"],
        "Customer Enabled" if user["status"] == "Active" else "Customer Disabled",
        details=user["email"],
        user_id=current_user["id"],
        target_type="user", target_id=user_id,
    )

    return jsonify({"success": True, "user": user})


@api.route("/users/<int:user_id>/reset-password", methods=["PUT"])
@super_admin_required
@rate_limited("password_reset", max_attempts=10, window_seconds=15 * 60)
def users_reset_password(user_id):

    data = request.get_json(silent=True) or {}

    success, error = reset_password(user_id, data.get("password"))

    if not success:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    target = get_user_by_id(user_id)
    log_activity(
        current_user["name"],
        "Customer Password Changed",
        details=target["email"] if target else str(user_id),
        user_id=current_user["id"],
        target_type="user", target_id=user_id,
    )

    return jsonify({"success": True, "message": "Password reset successfully."})


@api.route("/users/<int:customer_id>/users", methods=["GET"])
@super_admin_required
def customer_users_list(customer_id):
    """Read-only: every User belonging to one Company Admin, for the
    Super Admin's Company Details page. Reuses list_company_users() as-is
    (see api/company_users.py) — the same function the Company Admin's
    own /company/users self-service route calls, just addressed by a
    URL-supplied customer_id instead of the caller's own tenant id. The
    Super Admin can only ever VIEW this list here — creating, editing,
    deleting, or changing a User's status/permissions is intentionally
    not exposed through this route; that stays exclusively on the
    Company Admin's own /company/users* endpoints."""

    customer = get_user_by_id(customer_id)

    if customer is None or customer["role"] != ROLE_COMPANY_ADMIN:
        return jsonify({"success": False, "message": "Company not found."}), 404

    users = list_company_users(customer_id)

    return jsonify({"total": len(users), "users": users})


# ==============================
# Permission Management API (Super Admin only)
# ==============================
@api.route("/permissions", methods=["GET"])
@super_admin_required
def permissions_catalog():

    return jsonify({"permissions": list_permissions()})


@api.route("/users/<int:user_id>/permissions", methods=["GET"])
@super_admin_required
def users_get_permissions(user_id):

    data, error = get_user_permissions(user_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify(data)


@api.route("/users/<int:user_id>/permissions", methods=["PUT"])
@super_admin_required
def users_update_permissions(user_id):

    data = request.get_json(silent=True) or {}

    result, error = update_user_permissions(user_id, data.get("module_keys"))

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Customer Permissions Updated", details=result["email"], user_id=current_user["id"],
        target_type="user", target_id=user_id,
    )

    return jsonify({"success": True, **result})


# ==============================
# Camera Management API (Super Admin only)
# ==============================
# Reachable only from the Super Admin's Customer Details page — never
# exposed to the User Portal. A camera is always scoped to the
# customer_id in the URL, so a Super Admin editing/deleting a camera can
# never accidentally target a different customer's camera by id alone.
@api.route("/users/<int:customer_id>/cameras", methods=["GET"])
@super_admin_required
def cameras_list(customer_id):

    if get_user_by_id(customer_id) is None:
        return jsonify({"success": False, "message": "Customer not found."}), 404

    cameras = get_cameras_for_customer(customer_id)

    return jsonify({"total": len(cameras), "cameras": cameras})


@api.route("/users/<int:customer_id>/cameras", methods=["POST"])
@super_admin_required
def cameras_create(customer_id):

    if get_user_by_id(customer_id) is None:
        return jsonify({"success": False, "message": "Customer not found."}), 404

    data = request.get_json(silent=True) or {}

    camera, error = add_camera(
        customer_id,
        data.get("camera_name"),
        data.get("camera_ip"),
        data.get("username"),
        data.get("password"),
        data.get("port"),
        data.get("channel_number"),
        data.get("brand"),
        data.get("rtsp_url"),
        data.get("camera_location"),
        stream_quality=data.get("stream_quality"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Camera Added", details=camera["camera_name"], user_id=current_user["id"],
        target_type="camera", target_id=camera["camera_id"], company_id=customer_id,
    )

    return jsonify({"success": True, "camera": camera}), 201


@api.route("/users/<int:customer_id>/cameras/<int:camera_id>", methods=["PUT"])
@super_admin_required
def cameras_update(customer_id, camera_id):

    data = request.get_json(silent=True) or {}

    # stream_quality only passed through when the request body actually
    # includes the key — this form has no Camera Quality control, so it
    # never sends one, and update_camera's _UNSET sentinel default means
    # "field omitted, don't touch the existing selection" (same contract
    # as owner_user_id below).
    quality_kwargs = {"stream_quality": data.get("stream_quality")} if "stream_quality" in data else {}

    camera, error = update_camera(
        camera_id,
        customer_id,
        data.get("camera_name"),
        data.get("camera_ip"),
        data.get("username"),
        data.get("password"),
        data.get("port"),
        data.get("channel_number"),
        data.get("brand"),
        data.get("rtsp_url"),
        data.get("camera_location"),
        **quality_kwargs,
    )

    if error:
        status_code = 404 if error == "Camera not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Camera Updated", details=camera["camera_name"], user_id=current_user["id"],
        target_type="camera", target_id=camera_id, company_id=customer_id,
    )

    return jsonify({"success": True, "camera": camera})


# Scoped under /users/<customer_id>/cameras like the rest of the camera
# API, but works for a camera that doesn't exist yet (the Add form) as
# well as one already saved (the Edit form, via optional camera_id in
# the body) — in the latter case the real, backend-verified result is
# persisted onto that row immediately (see record_connection_test_result).
@api.route("/users/<int:customer_id>/cameras/test-connection", methods=["POST"])
@super_admin_required
def cameras_test_connection(customer_id):

    if get_user_by_id(customer_id) is None:
        return jsonify({"success": False, "message": "Customer not found."}), 404

    current_user = get_current_user()

    # Security fix: without this, an authenticated caller could use this
    # endpoint as a free, unlimited internal network/port scanner — see
    # auth/rate_limit.py's is_camera_test_blocked for the full reasoning.
    blocked, retry_after = is_camera_test_blocked(current_user["id"], request.remote_addr)
    if blocked:
        response = jsonify({
            "success": False, "connected": False,
            "message": "Too many connection attempts. Please wait and try again.",
        })
        response.headers["Retry-After"] = str(retry_after)
        return response, 429
    record_camera_test_attempt(current_user["id"], request.remote_addr)

    data = request.get_json(silent=True) or {}

    brand = data.get("brand")
    camera_ip = data.get("camera_ip")
    username = data.get("username")
    password = data.get("password")
    port = data.get("port")
    channel_number = data.get("channel_number")
    custom_rtsp_url = data.get("rtsp_url")
    camera_id = data.get("camera_id")
    stream_quality = data.get("stream_quality")

    if port in (None, ""):
        port = 554

    error = validate_camera_brand(brand) or validate_connection_fields(camera_ip, username, password, port, channel_number)

    if not error and brand == "custom":
        error = validate_custom_rtsp(custom_rtsp_url)

    if error:
        return jsonify({"success": False, "connected": False, "message": error}), 400

    connected, reason, rtsp_url, preview = test_camera_connection(
        brand, camera_ip, username, password, port, channel_number, custom_rtsp_url, stream_quality or DEFAULT_STREAM_QUALITY
    )

    # Security fix: `reason` (raw socket/FFmpeg/OpenCV error text — can
    # include internal IPs, ports, and connection details) and `rtsp_url`
    # (can include the camera's own credentials for brand="custom") never
    # leave the server. Full detail stays in the server-side log only,
    # already credential-sanitized.
    print(f"[CAMERA_TEST] customer={customer_id} connected={connected} reason={sanitize_sensitive_url(reason)}")

    log_security_event(
        "Camera Connection Test",
        user=current_user,
        target_type="camera",
        target_id=camera_id,
        success=connected,
        company_id=customer_id,
    )

    if camera_id:
        record_connection_test_result(camera_id, customer_id, connected)

    return jsonify({
        "success": True,
        "connected": connected,
        "message": CONNECTION_SUCCESS_MESSAGE if connected else CONNECTION_FAILURE_MESSAGE,
        "preview": preview,
    })


@api.route("/users/<int:customer_id>/cameras/<int:camera_id>", methods=["DELETE"])
@super_admin_required
def cameras_delete(customer_id, camera_id):

    camera = get_camera(camera_id, customer_id)
    deleted = delete_camera(camera_id, customer_id)

    if not deleted:
        return jsonify({"success": False, "message": "Camera not found."}), 404

    current_user = get_current_user()
    log_activity(
        current_user["name"],
        "Camera Deleted",
        details=camera["camera_name"] if camera else str(camera_id),
        user_id=current_user["id"],
        target_type="camera", target_id=camera_id, company_id=customer_id,
    )

    return jsonify({"success": True, "message": "Camera deleted successfully."})


@api.route("/users/<int:customer_id>/cameras/<int:camera_id>/detection", methods=["PUT"])
@super_admin_required
def cameras_set_detection(customer_id, camera_id):
    """Starts/stops the AI Detection Engine's worker for this one camera
    — see camera/detection_service.py. Independent of `status`, which
    reflects live connectivity, not this on/off switch."""

    data = request.get_json(silent=True) or {}
    enabled = bool(data.get("detection_enabled"))

    camera = set_camera_detection_enabled(camera_id, customer_id, enabled)

    if camera is None:
        return jsonify({"success": False, "message": "Camera not found."}), 404

    current_user = get_current_user()
    log_activity(
        current_user["name"],
        "Camera Detection Enabled" if enabled else "Camera Detection Disabled",
        details=camera["camera_name"],
        user_id=current_user["id"],
        target_type="camera", target_id=camera_id, company_id=customer_id,
    )

    return jsonify({"success": True, "camera": camera})


# ==============================
# AI Configuration API (Super Admin only)
# ==============================
# Reachable only from the Super Admin's Customer Details page — never
# exposed to the User Portal, and never granted through the module
# permission system the way "settings" is. The AI pipeline
# (camera/frame_processor.py, face/unknown_manager.py) reads
# get_ai_config() directly rather than through this route.
@api.route("/users/<int:customer_id>/ai-config", methods=["GET"])
@super_admin_required
def ai_config_get(customer_id):

    if get_user_by_id(customer_id) is None:
        return jsonify({"success": False, "message": "Customer not found."}), 404

    return jsonify({"ai_config": get_ai_config(customer_id)})


@api.route("/users/<int:customer_id>/ai-config", methods=["PUT"])
@super_admin_required
def ai_config_update(customer_id):

    if get_user_by_id(customer_id) is None:
        return jsonify({"success": False, "message": "Customer not found."}), 404

    data = request.get_json(silent=True) or {}
    updated = update_ai_config(customer_id, data)

    current_user = get_current_user()
    log_activity(
        current_user["name"],
        "AI Configuration Updated",
        details=f"Customer #{customer_id}",
        user_id=current_user["id"],
    )

    return jsonify({"success": True, "ai_config": updated})


# ==============================
# Data Retention (Super Admin only, per Company Admin) — Admin & User
# Overview page. Reachable only from there, same shape as AI
# Configuration just above: a Super-Admin-only control targeting one
# specific Company Admin's customer_id, never exposed to the User
# Portal or the Company Admin's own settings.
# ==============================
@api.route("/users/<int:customer_id>/retention-settings", methods=["GET"])
@super_admin_required
def retention_settings_get(customer_id):

    if get_user_by_id(customer_id) is None:
        return jsonify({"success": False, "message": "Customer not found."}), 404

    return jsonify({"retention_settings": get_retention_settings(customer_id)})


@api.route("/users/<int:customer_id>/retention-settings", methods=["PUT"])
@super_admin_required
def retention_settings_update(customer_id):

    if get_user_by_id(customer_id) is None:
        return jsonify({"success": False, "message": "Customer not found."}), 404

    data = request.get_json(silent=True) or {}
    updated, error = update_retention_settings(customer_id, data.get("policy"))

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(
        current_user["name"],
        "Data Retention Policy Updated",
        details=f"Customer #{customer_id} -> {data.get('policy')}",
        user_id=current_user["id"],
    )

    return jsonify({"success": True, "retention_settings": updated})


# ==============================
# AI Detection Controls API (per-account self-service; Company Admin may
# also target one of their own Users)
# ==============================
# Settings > AI Detection Controls. Reads/writes the account identified by
# auth.auth.resolve_settings_target_id: the caller's own account by
# default, or — for a Company Admin only — one of their own Users' when
# ?user_id= names one, so one company can never see or change another's
# configuration, and a User can never reach another account's. Gated by
# the same "settings" module permission as the rest of the Settings page.
# Limited to COMPANY_ADMIN_AI_KEYS — unknown_alerts_enabled stays
# exclusively Super Admin-controlled even though it lives in the same
# table.
@api.route("/ai-detection-settings", methods=["GET"])
@module_required("settings")
def ai_detection_settings_get():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))
    tenant_id = get_tenant_id(current_user)
    full_config = get_ai_config(target_id, tenant_id=tenant_id)

    return jsonify({
        "ai_config": {key: full_config[key] for key in COMPANY_ADMIN_AI_KEYS},
        "locked": get_ai_flag_locks(tenant_id),
    })


@api.route("/ai-detection-settings", methods=["PUT"])
@module_required("settings")
def ai_detection_settings_update():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))
    tenant_id = get_tenant_id(current_user)

    data = request.get_json(silent=True) or {}
    allowed_only = {key: data[key] for key in COMPANY_ADMIN_AI_KEYS if key in data}

    updated = update_ai_config(target_id, allowed_only, tenant_id=tenant_id)

    details = ", ".join(f"{k}={updated[k]}" for k in allowed_only)
    if target_id != current_user["id"]:
        details += f" (for user #{target_id})"

    log_activity(
        current_user["name"],
        "AI Detection Controls Updated",
        details=details,
        user_id=current_user["id"],
    )

    return jsonify({
        "success": True,
        "ai_config": {key: updated[key] for key in COMPANY_ADMIN_AI_KEYS},
        "locked": get_ai_flag_locks(tenant_id),
    })


@api.route("/ai-detection-settings/reset", methods=["POST"])
@module_required("settings")
def ai_detection_settings_reset():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))
    tenant_id = get_tenant_id(current_user)

    updated = reset_ai_config(target_id, tenant_id=tenant_id)

    return jsonify({
        "success": True,
        "ai_config": {key: updated[key] for key in COMPANY_ADMIN_AI_KEYS},
        "locked": get_ai_flag_locks(tenant_id),
    })


# ==============================
# AI Settings API (Final Production Readiness — full recognition/quality/
# attendance/unknown thresholds; per-account self-service, same targeting
# as AI Detection Controls above)
# ==============================
# Distinct from /ai-detection-settings above (which only ever exposed
# the on/off toggles) — this is the broader page requested: every
# threshold that used to be a hardcoded constant in face/recognizer.py,
# face/quality.py, attendance/attendance.py, and face/unknown_manager.py
# is now readable/writable here, per-account, live (no code deploy to
# retune). Same account-targeting and "settings" module gate as every
# other self-service route in this file.
@api.route("/company/settings/ai", methods=["GET"])
@module_required("settings")
def company_ai_settings_get():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))
    full_config = get_ai_config(target_id)

    return jsonify({"settings": {key: full_config[key] for key in COMPANY_ADMIN_AI_SETTINGS_KEYS}})


@api.route("/company/settings/ai", methods=["PUT"])
@module_required("settings")
def company_ai_settings_update():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))

    data = request.get_json(silent=True) or {}
    allowed_only = {key: data[key] for key in COMPANY_ADMIN_AI_SETTINGS_KEYS if key in data}

    error = validate_ai_settings(allowed_only)

    if error:
        return jsonify({"success": False, "message": error}), 400

    updated = update_ai_config(target_id, allowed_only)

    details = ", ".join(f"{k}={updated[k]}" for k in allowed_only)
    if target_id != current_user["id"]:
        details += f" (for user #{target_id})"

    log_activity(
        current_user["name"],
        "AI Settings Updated",
        details=details,
        user_id=current_user["id"],
    )

    return jsonify({"success": True, "settings": {key: updated[key] for key in COMPANY_ADMIN_AI_SETTINGS_KEYS}})


@api.route("/company/settings/ai/reset", methods=["POST"])
@module_required("settings")
def company_ai_settings_reset():

    current_user = get_current_user()
    target_id = resolve_settings_target_id(current_user, request.args.get("user_id"))

    updated = reset_ai_config(target_id)

    return jsonify({"success": True, "settings": {key: updated[key] for key in COMPANY_ADMIN_AI_SETTINGS_KEYS}})


# ==============================
# Activity Logs API (Super Admin only)
# ==============================
@api.route("/activity-logs", methods=["GET"])
@super_admin_required
def activity_logs():

    return jsonify({"logs": get_activity_logs()})


@api.route("/activity-logs/<int:log_id>", methods=["DELETE"])
@super_admin_required
def activity_logs_delete_one(log_id):

    deleted = delete_activity_log(log_id)

    if not deleted:
        return jsonify({"success": False, "message": "Log entry not found."}), 404

    return jsonify({"success": True, "message": "Log entry deleted."})


# Bulk delete by id list — a single query instead of one DELETE per
# selected row (see auth.database.delete_activity_logs).
@api.route("/activity-logs/bulk-delete", methods=["POST"])
@super_admin_required
def activity_logs_delete_bulk():

    data = request.get_json(silent=True) or {}
    ids = data.get("ids")

    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No activity logs selected."}), 400

    deleted_count = delete_activity_logs(ids)

    return jsonify({"success": True, "deleted": deleted_count})


@api.route("/activity-logs", methods=["DELETE"])
@super_admin_required
def activity_logs_delete_all():

    delete_all_activity_logs()

    return jsonify({"success": True, "message": "All activity logs deleted."})


# ==============================
# Leads API (Super Admin only) — landing page Interest & Lead popup
# submissions (see api/leads.py). Creation is the anonymous
# POST /public/leads route above; only a Super Admin can view or remove
# them.
# ==============================
@api.route("/leads", methods=["GET"])
@super_admin_required
def leads_list():

    return jsonify({"leads": list_leads()})


@api.route("/leads/<int:lead_id>", methods=["DELETE"])
@super_admin_required
def leads_delete_one(lead_id):

    deleted = delete_lead(lead_id)

    if not deleted:
        return jsonify({"success": False, "message": "Lead not found."}), 404

    current_user = get_current_user()
    log_activity(current_user["name"], "Lead Deleted", details=str(lead_id), user_id=current_user["id"])

    return jsonify({"success": True, "message": "Lead deleted."})


# ==============================
# FCM Push Notifications (Super Admin only) — "New Lead" alerts, see
# notifications/fcm.py. @super_admin_required is what actually keeps a
# Company Admin/User from ever registering a device here — nothing about
# how a lead is created or who can call POST /public/leads changes.
# ==============================
@api.route("/fcm/register-token", methods=["POST"])
@super_admin_required
def fcm_register_token():

    data = request.get_json(silent=True) or {}
    current_user = get_current_user()

    ok, error = register_fcm_token(current_user["id"], data.get("token"))

    if error:
        return jsonify({"success": False, "message": error}), 400

    return jsonify({"success": True, "configured": is_fcm_configured()})


@api.route("/fcm/token", methods=["DELETE"])
@super_admin_required
def fcm_unregister_token():

    data = request.get_json(silent=True) or {}
    unregister_fcm_token(data.get("token"))

    return jsonify({"success": True})


# ==============================
# Platform Branding API (Super Admin only)
# ==============================
# Platform-wide (Application Name / Logo) — one value for the whole
# install, distinct from the per-customer /settings above. Only ever
# edited from the Super Admin System Settings page.
@api.route("/branding", methods=["GET"])
@super_admin_required
def branding_get():

    return jsonify(get_branding())


@api.route("/branding/app-name", methods=["PUT"])
@super_admin_required
def branding_update_app_name():

    data = request.get_json(silent=True) or {}

    branding, error = update_app_name(data.get("name"))

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Application Name Updated", details=branding["app_name"], user_id=current_user["id"])

    return jsonify({"success": True, **branding})


@api.route("/branding/logo", methods=["PUT"])
@super_admin_required
def branding_update_logo():

    file = request.files.get("logo")

    branding, error = update_logo(file)

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Platform Logo Updated", user_id=current_user["id"])

    return jsonify({"success": True, **branding})


@api.route("/branding/logo", methods=["DELETE"])
@super_admin_required
def branding_delete_logo():

    branding = remove_logo()

    current_user = get_current_user()
    log_activity(current_user["name"], "Platform Logo Removed", user_id=current_user["id"])

    return jsonify({"success": True, **branding})


# Serve Platform Logo — any authenticated user can view it (it's shown
# in the Super Admin Sidebar), but it can only ever be changed by a
# Super Admin via the routes above.
@api.route("/branding/logo/<filename>", methods=["GET"])
@login_required
def branding_logo_file(filename):

    return send_from_directory(LOGO_FOLDER, filename)


# ==============================
# Website Settings (Super Admin) — public landing page content. Read
# access is /public/website-content above (anonymous); only these two
# routes can change it. Module Package pricing is deliberately NOT here
# — see /module-packages further below, the single source of truth
# Website Settings' own Pricing card reads/writes directly. The one
# exception is the "extend_platform" section's monthly_price/yearly_price
# — a standalone marketing figure with no BillableItem behind it, so it
# lives here like any other piece of landing-page copy (see
# api/website_content.py's module comment for why).
# ==============================
@api.route("/website-content/<section_key>", methods=["PUT"])
@super_admin_required
def website_content_update_section(section_key):

    data = request.get_json(silent=True) or {}
    content, error = update_section(section_key, data)

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Website Content Updated", details=section_key, user_id=current_user["id"])

    return jsonify({"success": True, **content})


@api.route("/website-content/image/<slot_key>", methods=["PUT"])
@super_admin_required
def website_content_update_image(slot_key):

    file = request.files.get("image")
    content, error = update_image(slot_key, file)

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Website Content Image Updated", details=slot_key, user_id=current_user["id"])

    return jsonify({"success": True, **content})


# ==============================
# Subscription & Payment API (Super Admin only)
# ==============================
# Manual records only — no payment gateway, nothing here moves money.
# Super Admin records each company's plan/status and logs payments by
# hand (see api/subscriptions.py).
@api.route("/subscriptions", methods=["GET"])
@super_admin_required
def subscriptions_list():

    return jsonify({"subscriptions": list_subscriptions()})


@api.route("/users/<int:customer_id>/subscription", methods=["PUT"])
@super_admin_required
def subscriptions_update(customer_id):

    data = request.get_json(silent=True) or {}

    subscription, error = upsert_subscription(
        customer_id,
        data.get("plan_name"),
        data.get("status"),
        data.get("amount"),
        data.get("billing_cycle"),
        data.get("next_due_date"),
        data.get("notes"),
    )

    if error:
        status_code = 404 if error == "Company not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    log_activity(
        current_user["name"],
        "Subscription Updated",
        details=f"customer_id={customer_id}",
        user_id=current_user["id"],
    )

    return jsonify({"success": True, "subscription": subscription})


@api.route("/payments", methods=["GET"])
@super_admin_required
def payments_list():

    customer_id = request.args.get("customer_id", type=int)

    return jsonify({"payments": list_payments(customer_id)})


@api.route("/users/<int:customer_id>/payments", methods=["POST"])
@super_admin_required
def payments_create(customer_id):

    data = request.get_json(silent=True) or {}

    payments, error = add_payment(
        customer_id,
        data.get("amount"),
        data.get("method"),
        data.get("note"),
        data.get("paid_on"),
    )

    if error:
        status_code = 404 if error == "Company not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    log_activity(
        current_user["name"],
        "Payment Logged",
        details=f"customer_id={customer_id}",
        user_id=current_user["id"],
    )

    return jsonify({"success": True, "payments": payments}), 201


# ==============================
# Self-Service Account Profile
# ==============================
@api.route("/account/profile", methods=["PUT"])
@login_required
def update_profile():

    data = request.get_json(silent=True) or {}
    current_user = get_current_user()

    # current_user["id"] comes from the session, not from `data` — this
    # endpoint cannot be made to target any account other than the
    # caller's own, no matter what the request body contains.
    user, error = update_own_profile(
        current_user,
        data.get("name"),
        data.get("email"),
        data.get("username"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    # Shared self-service endpoint — used by both Super Admin (My Account)
    # and a regular Company Admin (Profile), so the log message reflects
    # whichever actually called it rather than always saying "Super Admin".
    log_activity(
        current_user["name"],
        f"{current_user['role']} Profile Updated",
        details=user["email"],
        user_id=current_user["id"],
    )

    return jsonify({"success": True, "user": user})


# Self-Service Profile Photo — upload/change (same route overwrites any
# previous photo for this account).
@api.route("/account/avatar", methods=["PUT"])
@login_required
def update_avatar():

    current_user = get_current_user()
    file = request.files.get("avatar")

    _, error = save_avatar(current_user["id"], file)

    if error:
        return jsonify({"success": False, "message": error}), 400

    updated_user = get_user_by_id(current_user["id"])

    return jsonify({"success": True, "user": serialize_user(updated_user)})


# Self-Service Profile Photo — remove
@api.route("/account/avatar", methods=["DELETE"])
@login_required
def delete_avatar():

    current_user = get_current_user()

    remove_avatar(current_user["id"])

    updated_user = get_user_by_id(current_user["id"])

    return jsonify({"success": True, "user": serialize_user(updated_user)})


# Serve Profile Photo
@api.route("/account/avatar/<filename>", methods=["GET"])
@login_required
def serve_avatar(filename):

    current_user = get_current_user()
    owner = get_avatar_owner(filename)

    # Filenames are deterministic (user_<id>.<ext>) — without an
    # ownership check here, any logged-in account in any company could
    # view any other account's profile photo just by guessing/copying
    # the URL. Allowed: the owner themselves, their own Company Admin,
    # or a Super Admin — same tiers every other cross-account view in
    # this app is scoped to.
    if owner is None:
        return jsonify({"success": False, "message": "Not found."}), 404

    allowed = (
        current_user["id"] == owner["id"]
        or current_user["role"] == ROLE_SUPER_ADMIN
        or (current_user["role"] == ROLE_COMPANY_ADMIN and owner.get("parent_admin_id") == current_user["id"])
    )

    if not allowed:
        return jsonify({"success": False, "message": "Not found."}), 404

    return send_from_directory(AVATAR_FOLDER, filename)


# ==============================
# Self-Service Account Password
# ==============================
@api.route("/account/password", methods=["PUT"])
@login_required
@rate_limited("password_change", max_attempts=5, window_seconds=15 * 60)
def change_password():

    data = request.get_json(silent=True) or {}
    current_user = get_current_user()

    success, error = change_own_password(
        current_user,
        data.get("new_password"),
    )

    if not success:
        return jsonify({"success": False, "message": error}), 400

    # Session revocation: change_own_password() -> reset_user_password()
    # already bumped this account's session_version (see auth/database.py),
    # which would otherwise log the caller themselves out on their very
    # next request. Re-syncing their OWN current session to the new value
    # here means only every OTHER session/device is invalidated.
    refreshed = get_user_by_id(current_user["id"])
    session["session_version"] = refreshed["session_version"]

    log_security_event(
        f"{current_user['role']} Password Changed",
        user=current_user,
        target_type="user",
        target_id=current_user["id"],
    )

    return jsonify({"success": True, "message": "Password updated successfully."})


@api.route("/account/sessions/revoke-all", methods=["POST"])
@login_required
def revoke_other_sessions():
    """Session revocation (Phase 2): "Log out of all other devices" —
    invalidates every session for this account except the one making this
    request. See auth.database.bump_session_version."""

    current_user = get_current_user()

    new_version = bump_session_version(current_user["id"])
    session["session_version"] = new_version

    log_security_event(
        f"{current_user['role']} Revoked Other Sessions",
        user=current_user,
        target_type="user",
        target_id=current_user["id"],
    )

    return jsonify({"success": True, "message": "All other sessions have been signed out."})


# ==============================
# Self-Service Cameras (User Portal — read-only)
# ==============================
# The User Portal only ever loads the cameras already assigned to the
# signed-in customer — it has no create/edit/delete capability. The
# customer id comes solely from the session, never from the client, so
# this can never be made to return another customer's cameras.
@api.route("/account/cameras", methods=["GET"])
@module_required("live_camera")
def account_cameras():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    cameras = get_cameras_for_customer(scope["customer_id"], owner_user_id=scope["owner_user_id"])

    return jsonify({"total": len(cameras), "cameras": cameras})


# Online/total camera counts for the Sidebar's Camera Status widget, which
# is shown on every protected page regardless of module permissions — so
# unlike /account/cameras above, this is gated by @login_required only,
# never a specific module.
@api.route("/account/cameras/summary", methods=["GET"])
@login_required
def account_cameras_summary():

    current_user = get_current_user()

    return jsonify(get_camera_counts(get_tenant_id(current_user)))


# ==============================
# Notifications API (Per-User Data Isolation)
# ==============================
# Reachable identically from both the Admin and User portals — a User
# always sees only their own notifications (forced server-side via
# get_data_scope), a Company Admin sees "All Users" by default and can
# narrow via ?user_id=, same convention as every other scoped GET above.
# No @module_required — matches the account-level (always reachable)
# precedent set by /account/subscription and /account/payments below.
@api.route("/account/notifications", methods=["GET"])
@login_required
def account_notifications():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    unread_only = request.args.get("unread_only") == "true"

    try:
        limit = min(int(request.args.get("limit", 50)), 200)
    except (TypeError, ValueError):
        limit = 50

    notifications = get_notifications(
        scope["customer_id"], scope["owner_user_id"], unread_only=unread_only, limit=limit
    )
    unread_count = get_unread_count(scope["customer_id"], scope["owner_user_id"])

    return jsonify({"total": len(notifications), "unread_count": unread_count, "notifications": notifications})


@api.route("/account/notifications/<int:notification_id>/read", methods=["PUT"])
@login_required
def account_notification_read(notification_id):

    current_user = get_current_user()
    ok = mark_notification_read(
        get_tenant_id(current_user), notification_id, owner_user_id=_mutation_owner_restriction(current_user)
    )

    if not ok:
        return jsonify({"success": False, "message": "Notification not found."}), 404

    return jsonify({"success": True})


@api.route("/account/notifications/read-all", methods=["PUT"])
@login_required
def account_notifications_read_all():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))
    count = mark_all_read(scope["customer_id"], owner_user_id=scope["owner_user_id"])

    return jsonify({"success": True, "updated": count})


@api.route("/account/notifications/<int:notification_id>", methods=["DELETE"])
@login_required
def account_notification_delete(notification_id):

    current_user = get_current_user()
    ok = delete_notification(
        get_tenant_id(current_user), notification_id, owner_user_id=_mutation_owner_restriction(current_user)
    )

    if not ok:
        return jsonify({"success": False, "message": "Notification not found."}), 404

    return jsonify({"success": True})


# ==============================
# Self-Service Subscription & Payment (User Portal — read-only)
# ==============================
# Same manual records Super Admin maintains (api/subscriptions.py) — this
# customer can only ever see their OWN row, since customer_id comes
# solely from the session. No edit capability here, matching the
# Company Admin's read-only access to this data.
@api.route("/account/subscription", methods=["GET"])
@login_required
def account_subscription():

    current_user = get_current_user()

    return jsonify({"subscription": get_subscription(get_tenant_id(current_user))})


# Company Admin/User read-only view of the Super Admin's Data Retention
# policy for this company (Admin & User Overview page owns the actual
# GET/PUT via /users/<id>/retention-settings, super_admin_required-only).
# customer_id comes solely from the session via get_tenant_id — same
# "can only ever see their OWN row" shape as /account/subscription just
# above — never from a client-supplied id, and there is no PUT here at
# all: this account can view the setting, never change it.
@api.route("/account/retention-settings", methods=["GET"])
@login_required
def account_retention_settings():

    current_user = get_current_user()

    return jsonify({"retention_settings": get_retention_settings(get_tenant_id(current_user))})


@api.route("/account/payments", methods=["GET"])
@login_required
def account_payments():

    current_user = get_current_user()

    return jsonify({"payments": list_payments(get_tenant_id(current_user))})


# ==============================
# Company Subscription & Payment API (Company Admin only, module-gated)
# ==============================
# Same underlying records as /account/subscription and /account/payments
# above, but dedicated to the Company Admin's own gated "Subscription &
# Payment" sidebar page — deliberately NOT the same routes as
# /account/subscription*, since those are also used by the older,
# ungated Profile-level Subscription page shared with the User portal
# (Frontend/Ai_FE/src/pages/Subscription.jsx) and must keep working for
# every User exactly as before. These two are read-only, same as
# /account/*.
@api.route("/company/subscription", methods=["GET"])
@company_admin_required
@module_required("subscription_payment")
def company_subscription():

    current_user = get_current_user()

    return jsonify({"subscription": get_subscription(get_tenant_id(current_user))})


@api.route("/company/payments", methods=["GET"])
@company_admin_required
@module_required("subscription_payment")
def company_payments():

    current_user = get_current_user()

    return jsonify({"payments": list_payments(get_tenant_id(current_user))})


# ==============================
# Billing & Pricing (Super Admin) + Checkout (Company Admin)
# ==============================
@api.route("/billing/items", methods=["GET"])
@super_admin_required
def billing_items_list():

    # ?customer_id=<id> — prices shown become that one company's
    # effective prices (its own override if the Super Admin set one,
    # otherwise the global price). Omitted = the global "All Admins"
    # catalog, unchanged from before per-Admin pricing existed.
    customer_id = request.args.get("customer_id", type=int)

    return jsonify({"items": list_billable_items(customer_id=customer_id)})


@api.route("/billing/items", methods=["POST"])
@super_admin_required
def billing_items_create():

    data = request.get_json(silent=True) or {}
    items, error = create_billable_item(data)

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Billing Item Created", details=data.get("item_key", ""), user_id=current_user["id"])

    return jsonify({"success": True, "items": items}), 201


@api.route("/billing/items/<int:item_id>", methods=["PUT"])
@super_admin_required
def billing_items_update(item_id):

    data = request.get_json(silent=True) or {}
    items, error = update_billable_item(item_id, data)

    if error:
        status_code = 404 if error == "Billing item not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    log_activity(current_user["name"], "Billing Item Updated", details=f"item_id={item_id}", user_id=current_user["id"])

    return jsonify({"success": True, "items": items})


@api.route("/billing/items/<int:item_id>", methods=["DELETE"])
@super_admin_required
def billing_items_delete(item_id):

    items, error = delete_billable_item(item_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    current_user = get_current_user()
    log_activity(current_user["name"], "Billing Item Deleted", details=f"item_id={item_id}", user_id=current_user["id"])

    return jsonify({"success": True, "items": items})


@api.route("/billing/items/<int:item_id>/override/<int:customer_id>", methods=["PUT"])
@super_admin_required
def billing_item_override_set(item_id, customer_id):

    data = request.get_json(silent=True) or {}
    items, error = set_item_price_override(
        customer_id,
        item_id,
        data.get("monthly_price"),
        data.get("yearly_price"),
        data.get("yearly_discount_percent"),
    )

    if error:
        status_code = 404 if error == "Billing item not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Billing Item Price Override Set",
        details=f"item_id={item_id} customer_id={customer_id}", user_id=current_user["id"],
    )

    return jsonify({"success": True, "items": items})


@api.route("/billing/items/<int:item_id>/override/<int:customer_id>", methods=["DELETE"])
@super_admin_required
def billing_item_override_clear(item_id, customer_id):

    items, error = clear_item_price_override(customer_id, item_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Billing Item Price Override Cleared",
        details=f"item_id={item_id} customer_id={customer_id}", user_id=current_user["id"],
    )

    return jsonify({"success": True, "items": items})


@api.route("/billing/items/<int:item_id>/access/<int:customer_id>", methods=["PUT"])
@super_admin_required
def billing_item_access_set(item_id, customer_id):

    data = request.get_json(silent=True) or {}
    enabled = bool(data.get("enabled"))
    items, error = set_item_access(customer_id, item_id, enabled)

    if error:
        status_code = 404 if error == "Billing item not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Billing Item Access Updated",
        details=f"item_id={item_id} customer_id={customer_id} enabled={enabled}", user_id=current_user["id"],
    )

    return jsonify({"success": True, "items": items})


# ==============================
# Module Packages (Super Admin) — the 4 purchasable packages, their
# prices, sub-module toggles, and per-company price / assignment.
# ==============================
@api.route("/module-packages", methods=["GET"])
@super_admin_required
def module_packages_list():

    customer_id = request.args.get("customer_id", type=int)

    return jsonify(get_package_catalog(customer_id=customer_id))


@api.route("/module-packages/<package_key>", methods=["PUT"])
@super_admin_required
def module_packages_update(package_key):

    data = request.get_json(silent=True) or {}
    result, error = update_package(package_key, data)

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Module Package Updated", details=package_key, user_id=current_user["id"])

    return jsonify({"success": True, **result})


@api.route("/module-packages/<package_key>/submodules/<submodule_key>", methods=["PUT"])
@super_admin_required
def module_packages_submodule_set(package_key, submodule_key):

    data = request.get_json(silent=True) or {}
    result, error = set_submodule_enabled(package_key, submodule_key, bool(data.get("enabled")))

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Module Sub-module Access Updated",
        details=f"{package_key}:{submodule_key} enabled={bool(data.get('enabled'))}", user_id=current_user["id"],
    )

    return jsonify({"success": True, **result})


@api.route("/module-packages/<package_key>/override/<int:customer_id>", methods=["PUT"])
@super_admin_required
def module_packages_override_set(package_key, customer_id):

    data = request.get_json(silent=True) or {}
    result, error = set_package_price_override(
        customer_id, package_key, data.get("monthly_price"), data.get("yearly_price")
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Module Package Price Override Set",
        details=f"{package_key} customer_id={customer_id}", user_id=current_user["id"],
    )

    return jsonify({"success": True, **result})


@api.route("/module-packages/<package_key>/override/<int:customer_id>", methods=["DELETE"])
@super_admin_required
def module_packages_override_clear(package_key, customer_id):

    result, error = clear_package_price_override(customer_id, package_key)

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Module Package Price Override Cleared",
        details=f"{package_key} customer_id={customer_id}", user_id=current_user["id"],
    )

    return jsonify({"success": True, **result})


@api.route("/module-packages/<package_key>/assign/<int:customer_id>", methods=["PUT"])
@super_admin_required
def module_packages_assign(package_key, customer_id):

    data = request.get_json(silent=True) or {}
    result, error = assign_package(customer_id, package_key, bool(data.get("owned")))

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(
        current_user["name"], "Module Package Assignment Updated",
        details=f"{package_key} customer_id={customer_id} owned={bool(data.get('owned'))}", user_id=current_user["id"],
    )

    return jsonify({"success": True, **result})


@api.route("/billing/config", methods=["GET"])
@super_admin_required
def billing_config_get():

    return jsonify(get_billing_config())


@api.route("/billing/config", methods=["PUT"])
@super_admin_required
def billing_config_update():

    data = request.get_json(silent=True) or {}
    config, error = update_billing_config(data.get("tax_percent"))

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Billing Config Updated", user_id=current_user["id"])

    return jsonify({"success": True, **config})


@api.route("/billing/overview", methods=["GET"])
@super_admin_required
def billing_overview():

    return jsonify({"companies": get_billing_overview()})


@api.route("/billing/overview/<int:customer_id>", methods=["GET"])
@super_admin_required
def billing_overview_detail(customer_id):

    return jsonify(get_company_billing_detail(customer_id))


# ==============================================================
# Admin & User Overview — Super Admin only. Read-only rollup of real
# storage/usage per Company Admin and per User (see api/admin_overview.py
# for how every figure is computed), plus the one writable field:
# a Company Admin's storage cap.
# ==============================================================
@api.route("/admin-overview/companies", methods=["GET"])
@super_admin_required
def admin_overview_companies():

    return jsonify({"companies": list_admin_overview()})


@api.route("/admin-overview/companies/<int:customer_id>", methods=["GET"])
@super_admin_required
def admin_overview_company_detail(customer_id):

    detail = get_admin_overview_detail(customer_id)

    if detail is None:
        return jsonify({"success": False, "message": "Company Admin not found."}), 404

    return jsonify(detail)


@api.route("/admin-overview/companies/<int:customer_id>/users/<int:user_id>", methods=["GET"])
@super_admin_required
def admin_overview_user_detail(customer_id, user_id):

    detail = get_user_storage_detail(customer_id, user_id)

    if detail is None:
        return jsonify({"success": False, "message": "User not found."}), 404

    return jsonify(detail)


@api.route("/admin-overview/companies/<int:customer_id>/storage-limit", methods=["PUT"])
@super_admin_required
def admin_overview_storage_limit(customer_id):

    data = request.get_json(silent=True) or {}
    updated, error = set_company_storage_limit(customer_id, data.get("storage_limit_gb"))

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Storage Limit Updated", user_id=current_user["id"])

    return jsonify({"success": True, **updated})


# Camera Limit / Camera Quota Management — Super Admin -> Admin Camera
# Limit. Same shape as the storage-limit route above (see
# api/admin_overview.py's set_admin_camera_limit for the "no upstream
# constraint, reducing below usage never deletes anything" rules).
@api.route("/admin-overview/companies/<int:customer_id>/camera-limit", methods=["PUT"])
@super_admin_required
def admin_overview_camera_limit(customer_id):

    data = request.get_json(silent=True) or {}
    updated, error = set_admin_camera_limit(customer_id, data.get("camera_limit"))

    if error:
        return jsonify({"success": False, "message": error}), 400

    current_user = get_current_user()
    log_activity(current_user["name"], "Admin Camera Limit Updated", user_id=current_user["id"])

    return jsonify({"success": True, **updated})


@api.route("/company/checkout-context", methods=["GET"])
@company_admin_required
@module_required("subscription_payment")
def company_checkout_context():

    current_user = get_current_user()

    return jsonify(get_checkout_context(get_tenant_id(current_user)))


@api.route("/company/checkout", methods=["POST"])
@company_admin_required
@module_required("subscription_payment")
def company_checkout():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    result, error = checkout(
        get_tenant_id(current_user),
        data.get("item_keys"),
        data.get("billing_cycle"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(
        current_user["name"],
        "Checkout Completed",
        details=f"items={','.join(i['item_key'] for i in result['payment']['items'])}",
        user_id=current_user["id"],
    )

    return jsonify({"success": True, **result})


@api.route("/company/module-packages", methods=["GET"])
@company_admin_required
@module_required("subscription_payment")
def company_module_packages():

    current_user = get_current_user()

    return jsonify(get_company_packages(get_tenant_id(current_user)))


@api.route("/company/module-packages/checkout", methods=["POST"])
@company_admin_required
@module_required("subscription_payment")
def company_module_packages_checkout():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    result, error = checkout_packages(
        get_tenant_id(current_user),
        data.get("package_keys"),
        data.get("billing_cycle"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(
        current_user["name"],
        "Package Checkout Completed",
        details=f"packages={','.join(result['payment']['packages'])}",
        user_id=current_user["id"],
    )

    return jsonify({"success": True, **result})


# ==============================
# Company Unknown Person Analytics API (Company Admin only, module-gated)
# ==============================
# Read-only aggregation (api/unknown_analytics.py) over the same
# unknown_persons table api/unknown.py already serves from — no new
# table, no image files touched, no change to how a face is detected or
# matched (face/unknown_manager.py is untouched).
@api.route("/company/unknown-analytics", methods=["GET"])
@company_or_user_required
@module_required("unknown_person_analytics")
def company_unknown_analytics():

    current_user = get_current_user()
    scope = get_data_scope(current_user, request.args.get("user_id"))

    return jsonify(get_unknown_person_analytics(scope["customer_id"], owner_user_id=scope["owner_user_id"]))


# ==============================
# Company User Management API (Company Admin, or a User granted
# "user_management")
# ==============================
# A company's own "Manage Users" — every function this calls into
# (api/company_users.py) is scoped to get_tenant_id(current_user) and can
# only ever touch a User that actually belongs to this company, exactly
# the same ownership guarantee the Super Admin's camera/AI-config routes
# already have for customer_id. Every route below with a <user_id> also
# rejects a User caller acting on their OWN id (is_self_target) — this
# surface manages OTHER Users, never self.
@api.route("/company/users", methods=["GET"])
@company_or_user_required
@module_required("user_management")
def company_users_list():

    current_user = get_current_user()
    exclude_id = current_user["id"] if current_user["role"] == ROLE_USER else None
    users = list_company_users(get_tenant_id(current_user), exclude_user_id=exclude_id)

    return jsonify({"total": len(users), "users": users})


@api.route("/company/users/<int:user_id>", methods=["GET"])
@company_or_user_required
@module_required("user_management")
def company_users_get_one(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    user, error = get_company_user(get_tenant_id(current_user), user_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify({"success": True, "user": user})


@api.route("/company/users", methods=["POST"])
@company_or_user_required
@module_required("user_management")
def company_users_create():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    user, error = add_company_user(
        get_tenant_id(current_user),
        data.get("name"),
        data.get("email"),
        data.get("username"),
        data.get("password"),
        data.get("status") or "Active",
        data.get("phone_number"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(
        current_user["name"], "User Created", details=user["email"], user_id=current_user["id"],
        target_type="user", target_id=user["id"], company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "user": user}), 201


@api.route("/company/users/<int:user_id>", methods=["PUT"])
@company_or_user_required
@module_required("user_management")
def company_users_update(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    data = request.get_json(silent=True) or {}

    user, error = edit_company_user(
        get_tenant_id(current_user),
        user_id,
        data.get("name"),
        data.get("email"),
        data.get("username"),
        data.get("phone_number"),
    )

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"], "User Updated", details=user["email"], user_id=current_user["id"],
        target_type="user", target_id=user_id, company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "user": user})


@api.route("/company/users/<int:user_id>", methods=["DELETE"])
@company_or_user_required
@module_required("user_management")
def company_users_delete(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    target, _ = get_company_user(get_tenant_id(current_user), user_id)

    success, error = remove_company_user(get_tenant_id(current_user), user_id)

    if not success:
        return jsonify({"success": False, "message": error}), 404

    log_activity(
        current_user["name"],
        "User Deleted",
        details=target["email"] if target else str(user_id),
        user_id=current_user["id"],
        target_type="user", target_id=user_id, company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "message": "User deleted successfully."})


@api.route("/company/users/<int:user_id>/status", methods=["PUT"])
@company_or_user_required
@module_required("user_management")
def company_users_set_status(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    data = request.get_json(silent=True) or {}

    user, error = set_company_user_status(get_tenant_id(current_user), user_id, data.get("status"))

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"],
        "User Enabled" if user["status"] == "Active" else "User Disabled",
        details=user["email"],
        user_id=current_user["id"],
        target_type="user", target_id=user_id, company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "user": user})


@api.route("/company/users/<int:user_id>/reset-password", methods=["PUT"])
@company_or_user_required
@module_required("user_management")
@rate_limited("password_reset", max_attempts=10, window_seconds=15 * 60)
def company_users_reset_password(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    data = request.get_json(silent=True) or {}

    success, error = reset_company_user_password(get_tenant_id(current_user), user_id, data.get("password"))

    if not success:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    target, _ = get_company_user(get_tenant_id(current_user), user_id)
    log_activity(
        current_user["name"],
        "User Password Reset",
        details=target["email"] if target else str(user_id),
        user_id=current_user["id"],
        target_type="user", target_id=user_id, company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "message": "Password reset successfully."})


@api.route("/company/users/<int:user_id>/permissions", methods=["GET"])
@company_or_user_required
@module_required("user_management")
def company_users_get_permissions(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    data, error = get_company_user_permissions(get_tenant_id(current_user), user_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify(data)


@api.route("/company/users/<int:user_id>/permissions", methods=["PUT"])
@company_or_user_required
@module_required("user_management")
def company_users_update_permissions(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    data = request.get_json(silent=True) or {}

    result, error = update_company_user_permissions(get_tenant_id(current_user), user_id, data.get("module_keys"))

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"], "User Permissions Updated", details=result["email"], user_id=current_user["id"],
        target_type="user", target_id=user_id, company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, **result})


# Camera Limit / Camera Quota Management — Admin -> Per-User Camera
# Limit. Company-Admin-exclusive (never company_or_user_required): per
# the feature's permission rules, a User can view but never modify a
# camera limit, their own or anyone else's — see
# api/company_users.py's set_company_user_camera_limit for the
# allocation-budget validation against this Admin's own camera_limit.
@api.route("/company/users/<int:user_id>/camera-limit", methods=["PUT"])
@company_admin_required
@module_required("user_management")
def company_users_update_camera_limit(user_id):

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    result, error = set_company_user_camera_limit(get_tenant_id(current_user), user_id, data.get("camera_limit"))

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(current_user["name"], "User Camera Limit Updated", details=result["email"], user_id=current_user["id"])

    return jsonify({"success": True, **result})


# User Management > Add/Edit User > WhatsApp & Reports — per-User
# WhatsApp number, Unknown Alert/Send Image/Daily Report toggles, and
# Daily Report time. Same ownership-checked pattern (and the same
# "user_management" module gate) as the permissions routes above; a
# Company Admin can only ever reach their OWN Users here.
@api.route("/company/users/<int:user_id>/whatsapp-settings", methods=["GET"])
@company_or_user_required
@module_required("user_management")
def company_users_get_whatsapp_settings(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    data, error = get_company_user_whatsapp_settings(get_tenant_id(current_user), user_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify({"success": True, **data})


@api.route("/company/users/<int:user_id>/whatsapp-settings", methods=["PUT"])
@company_or_user_required
@module_required("user_management")
def company_users_update_whatsapp_settings(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    data = request.get_json(silent=True) or {}

    result, error = update_company_user_whatsapp_settings(get_tenant_id(current_user), user_id, data)

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"], "User WhatsApp & Report Settings Updated",
        details=f"user_id={user_id}", user_id=current_user["id"],
    )

    return jsonify({"success": True, **result})


@api.route("/company/users/<int:user_id>/whatsapp-settings/reset", methods=["POST"])
@company_or_user_required
@module_required("user_management")
def company_users_reset_whatsapp_settings(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    result, error = reset_company_user_whatsapp_settings(get_tenant_id(current_user), user_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify({"success": True, **result})


# Settings page > Profile, when a Company Admin is managing one of their
# Users — same self-service upload/remove flow as /account/avatar,
# ownership-checked and targeting user_id instead of the caller's own id.
@api.route("/company/users/<int:user_id>/avatar", methods=["PUT"])
@company_or_user_required
@module_required("user_management")
def company_users_update_avatar(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    file = request.files.get("avatar")

    user, error = update_company_user_avatar(get_tenant_id(current_user), user_id, file)

    if error:
        status_code = 404 if error == "User not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    return jsonify({"success": True, "user": user})


@api.route("/company/users/<int:user_id>/avatar", methods=["DELETE"])
@company_or_user_required
@module_required("user_management")
def company_users_delete_avatar(user_id):

    current_user = get_current_user()

    if is_self_target(current_user, user_id):
        return jsonify({"success": False, "message": "You cannot manage your own account here."}), 403

    user, error = remove_company_user_avatar(get_tenant_id(current_user), user_id)

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify({"success": True, "user": user})


# ==============================
# Company Camera Management API (Company Admin, or a User granted
# "camera_management")
# ==============================
# Self-service equivalent of the Super Admin's /users/<customer_id>/
# cameras* routes — same api/cameras.py functions, but customer_id is
# always get_tenant_id(current_user) rather than a caller-supplied URL
# param, so a caller can only ever manage their own company's cameras.
@api.route("/company/cameras", methods=["GET"])
@company_or_user_required
@module_required("camera_management")
def company_cameras_list():

    current_user = get_current_user()
    cameras = get_cameras_for_customer(
        get_tenant_id(current_user), owner_user_id=_mutation_owner_restriction(current_user)
    )

    return jsonify({"total": len(cameras), "cameras": cameras})


# Camera Limit / Camera Quota Management — the Camera Management page's
# own "your quota" banner. A Company Admin gets their company-wide
# rollup (limit/used/remaining/usage%/allocated-to-users); a User gets
# only their own personal rollup, never the company-wide one (a User
# only "can view own camera limit and usage", per this feature's
# permission rules) — the field that isn't relevant to the caller's role
# is simply null rather than omitted, so the frontend never has to
# branch on which keys exist.
@api.route("/company/cameras/quota", methods=["GET"])
@company_or_user_required
@module_required("camera_management")
def company_cameras_quota():

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    admin_quota = get_admin_camera_summary(tenant_id) if current_user["role"] == ROLE_COMPANY_ADMIN else None
    user_quota = get_user_camera_summary(current_user["id"]) if current_user["role"] == ROLE_USER else None

    return jsonify({"admin": admin_quota, "user": user_quota})


@api.route("/company/cameras", methods=["POST"])
@company_or_user_required
@module_required("camera_management")
@rate_limited("camera_write", max_attempts=20, window_seconds=60)
def company_cameras_create():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    # Camera Limit / Camera Quota Management + "a User can never assign a
    # camera to anyone but themselves" (see permission rules) — a User
    # caller's camera is ALWAYS assigned to their own id, regardless of
    # what owner_user_id the request asks for. The frontend's Add Camera
    # form already hides this field for a User and always submits null,
    # but the backend must never trust that — this is the real
    # enforcement, and also what makes camera_quota.py's per-User check
    # below meaningful (it only means anything if ownership itself can't
    # be spoofed).
    owner_user_id = current_user["id"] if current_user["role"] == ROLE_USER else data.get("owner_user_id")

    # Site / VPN Gateway Management: "" (the frontend's "No Site" option)
    # normalizes to None, same convention owner_user_id already uses. A
    # User caller's requested site_id must additionally be one they were
    # actually granted (SiteUser) — never trusted blind just because the
    # picker happened to only show granted Sites; a Company Admin caller
    # is only restricted to their own company's Sites, which add_camera's
    # own _validate_site_id already enforces.
    site_id = data.get("site_id") or None
    if site_id is not None:
        try:
            site_id = int(site_id)
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Invalid site."}), 400
        if current_user["role"] == ROLE_USER and not user_has_site_access(current_user["id"], site_id):
            return jsonify({"success": False, "message": "You do not have access to the selected site."}), 403

    camera, error = add_camera(
        get_tenant_id(current_user),
        data.get("camera_name"),
        data.get("camera_ip"),
        data.get("username"),
        data.get("password"),
        data.get("port"),
        data.get("channel_number"),
        data.get("brand"),
        data.get("rtsp_url"),
        data.get("camera_location"),
        owner_user_id=owner_user_id,
        stream_quality=data.get("stream_quality"),
        site_id=site_id,
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(
        current_user["name"], "Camera Added", details=camera["camera_name"], user_id=current_user["id"],
        target_type="camera", target_id=camera["camera_id"], company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "camera": camera}), 201


@api.route("/company/cameras/<int:camera_id>", methods=["PUT"])
@company_or_user_required
@module_required("camera_management")
@rate_limited("camera_write", max_attempts=20, window_seconds=60)
def company_cameras_update(camera_id):

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    # owner_user_id/stream_quality are only passed through when the
    # request body actually includes the key — update_camera's _UNSET
    # sentinel default means "field omitted, don't touch the existing
    # value" versus an explicit value, which means "change it." A User
    # caller is the one exception: their camera's owner_user_id is
    # ALWAYS forced back to their own id, even if the request omits the
    # field entirely or asks for something else — same "can never assign
    # to anyone but themselves" rule as company_cameras_create above.
    if current_user["role"] == ROLE_USER:
        extra = {"owner_user_id": current_user["id"]}
    else:
        extra = {"owner_user_id": data.get("owner_user_id")} if "owner_user_id" in data else {}
    if "stream_quality" in data:
        extra["stream_quality"] = data.get("stream_quality")

    # Site / VPN Gateway Management — same "" -> None normalization and
    # per-User access re-check as company_cameras_create above. Only
    # touched when the request body actually includes the key (_UNSET
    # sentinel default in update_camera means "leave the existing Site
    # alone" otherwise).
    if "site_id" in data:
        site_id = data.get("site_id") or None
        if site_id is not None:
            try:
                site_id = int(site_id)
            except (TypeError, ValueError):
                return jsonify({"success": False, "message": "Invalid site."}), 400
            if current_user["role"] == ROLE_USER and not user_has_site_access(current_user["id"], site_id):
                return jsonify({"success": False, "message": "You do not have access to the selected site."}), 403
        extra["site_id"] = site_id

    camera, error = update_camera(
        camera_id,
        get_tenant_id(current_user),
        data.get("camera_name"),
        data.get("camera_ip"),
        data.get("username"),
        data.get("password"),
        data.get("port"),
        data.get("channel_number"),
        data.get("brand"),
        data.get("rtsp_url"),
        data.get("camera_location"),
        restrict_to_owner_user_id=_mutation_owner_restriction(current_user),
        **extra,
    )

    if error:
        status_code = 404 if error == "Camera not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"], "Camera Updated", details=camera["camera_name"], user_id=current_user["id"],
        target_type="camera", target_id=camera_id, company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "camera": camera})


@api.route("/company/cameras/test-connection", methods=["POST"])
@company_or_user_required
@module_required("camera_management")
def company_cameras_test_connection():

    current_user = get_current_user()

    # Security fix — same reasoning as cameras_test_connection above.
    blocked, retry_after = is_camera_test_blocked(current_user["id"], request.remote_addr)
    if blocked:
        response = jsonify({
            "success": False, "connected": False,
            "message": "Too many connection attempts. Please wait and try again.",
        })
        response.headers["Retry-After"] = str(retry_after)
        return response, 429
    record_camera_test_attempt(current_user["id"], request.remote_addr)

    data = request.get_json(silent=True) or {}

    brand = data.get("brand")
    camera_ip = data.get("camera_ip")
    username = data.get("username")
    password = data.get("password")
    port = data.get("port")
    channel_number = data.get("channel_number")
    custom_rtsp_url = data.get("rtsp_url")
    camera_id = data.get("camera_id")
    stream_quality = data.get("stream_quality")

    if port in (None, ""):
        port = 554

    error = validate_camera_brand(brand) or validate_connection_fields(camera_ip, username, password, port, channel_number)

    if not error and brand == "custom":
        error = validate_custom_rtsp(custom_rtsp_url)

    if error:
        return jsonify({"success": False, "connected": False, "message": error}), 400

    connected, reason, rtsp_url, preview = test_camera_connection(
        brand, camera_ip, username, password, port, channel_number, custom_rtsp_url, stream_quality or DEFAULT_STREAM_QUALITY
    )

    # Security fix — see cameras_test_connection above for the full
    # reasoning: raw `reason`/`rtsp_url` never leave the server.
    print(f"[CAMERA_TEST] user={current_user['id']} connected={connected} reason={sanitize_sensitive_url(reason)}")

    log_security_event(
        "Camera Connection Test",
        user=current_user,
        target_type="camera",
        target_id=camera_id,
        success=connected,
        company_id=get_tenant_id(current_user),
    )

    if camera_id:
        record_connection_test_result(
            camera_id, get_tenant_id(current_user), connected,
            restrict_to_owner_user_id=_mutation_owner_restriction(current_user),
        )

    return jsonify({
        "success": True,
        "connected": connected,
        "message": CONNECTION_SUCCESS_MESSAGE if connected else CONNECTION_FAILURE_MESSAGE,
        "preview": preview,
    })


@api.route("/company/cameras/<int:camera_id>", methods=["DELETE"])
@company_or_user_required
@module_required("camera_management")
def company_cameras_delete(camera_id):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)
    restrict_to = _mutation_owner_restriction(current_user)

    camera = get_camera(camera_id, tenant_id, restrict_to_owner_user_id=restrict_to)
    deleted = delete_camera(camera_id, tenant_id, restrict_to_owner_user_id=restrict_to)

    if not deleted:
        return jsonify({"success": False, "message": "Camera not found."}), 404

    log_activity(
        current_user["name"],
        "Camera Deleted",
        details=camera["camera_name"] if camera else str(camera_id),
        user_id=current_user["id"],
        target_type="camera", target_id=camera_id, company_id=tenant_id,
    )

    return jsonify({"success": True, "message": "Camera deleted successfully."})


@api.route("/company/cameras/<int:camera_id>/detection", methods=["PUT"])
@company_or_user_required
@module_required("camera_management")
def company_cameras_set_detection(camera_id):
    """Starts/stops the AI Detection Engine's worker for this one camera
    — see camera/detection_service.py. Independent of `status`, which
    reflects live connectivity, not this on/off switch."""

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    data = request.get_json(silent=True) or {}
    enabled = bool(data.get("detection_enabled"))

    camera = set_camera_detection_enabled(
        camera_id, tenant_id, enabled, restrict_to_owner_user_id=_mutation_owner_restriction(current_user)
    )

    if camera is None:
        return jsonify({"success": False, "message": "Camera not found."}), 404

    log_activity(
        current_user["name"],
        "Camera Detection Enabled" if enabled else "Camera Detection Disabled",
        details=camera["camera_name"],
        user_id=current_user["id"],
        target_type="camera", target_id=camera_id, company_id=tenant_id,
    )

    return jsonify({"success": True, "camera": camera})


# ==============================
# Site / VPN Gateway Management API
# ==============================
# See api/sites.py's own module docstring for what a Site is (a
# network/access grouping this app RECORDS) and, just as importantly,
# what it is NOT (never the thing that opens/manages the actual
# WireGuard tunnel, never a place a private key is stored or returned).
#
# Every mutating route here is Company-Admin-only (company_admin_required
# + module_required("site_management") — a User can never hold that
# module at all, see api/company_users.py's GRANTABLE_USER_MODULE_KEYS).
# The list endpoint is the one exception: a User needs it too, to
# populate the Camera Management "Site / Office" picker with exactly
# the Sites they've been granted — see company_sites_list's own
# docstring for why that stays outside the module gate.
@api.route("/company/sites", methods=["GET"])
@company_or_user_required
def company_sites_list():
    """Company Admin sees every Site in their company, any status (the
    Site Management table + the "Site / Office" picker, filtered to
    Active-only client-side for the latter). A User sees only the Sites
    they've been explicitly granted (SiteUser) — this is also what
    powers their own Camera Management "Site / Office" picker, which is
    why this one route is deliberately NOT behind
    module_required("site_management"): a User can never be granted
    that module (Company-Admin-only), but still needs this list to add
    a camera."""

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    user_id = current_user["id"] if current_user["role"] == ROLE_USER else None
    sites = get_sites_for_customer(tenant_id, user_id=user_id)

    return jsonify({"total": len(sites), "sites": sites})


@api.route("/company/sites", methods=["POST"])
@company_admin_required
@module_required("site_management")
@rate_limited("site_write", max_attempts=20, window_seconds=60)
def company_sites_create():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    site, error = create_site(
        get_tenant_id(current_user),
        data.get("site_name"),
        data.get("vpn_gateway_ip"),
        data.get("camera_network"),
        data.get("vpn_public_key"),
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(
        current_user["name"], "Site Added", details=site["site_name"], user_id=current_user["id"],
        target_type="site", target_id=site["site_id"], company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "site": site}), 201


@api.route("/company/sites/<int:site_id>", methods=["PUT"])
@company_admin_required
@module_required("site_management")
@rate_limited("site_write", max_attempts=20, window_seconds=60)
def company_sites_update(site_id):

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    site, error = update_site(
        site_id,
        get_tenant_id(current_user),
        data.get("site_name"),
        data.get("vpn_gateway_ip"),
        data.get("camera_network"),
        data.get("vpn_public_key"),
    )

    if error:
        status_code = 404 if error == "Site not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"], "Site Updated", details=site["site_name"], user_id=current_user["id"],
        target_type="site", target_id=site_id, company_id=get_tenant_id(current_user),
    )

    return jsonify({"success": True, "site": site})


@api.route("/company/sites/<int:site_id>", methods=["DELETE"])
@company_admin_required
@module_required("site_management")
def company_sites_delete(site_id):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    site = get_site(site_id, tenant_id)
    deleted = delete_site(site_id, tenant_id)

    if not deleted:
        return jsonify({"success": False, "message": "Site not found."}), 404

    log_activity(
        current_user["name"], "Site Deleted",
        details=site["site_name"] if site else str(site_id),
        user_id=current_user["id"],
        target_type="site", target_id=site_id, company_id=tenant_id,
    )

    return jsonify({"success": True, "message": "Site deleted successfully."})


@api.route("/company/sites/<int:site_id>/status", methods=["PUT"])
@company_admin_required
@module_required("site_management")
def company_sites_set_status(site_id):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    data = request.get_json(silent=True) or {}
    status = data.get("status")

    site, error = set_site_status(site_id, tenant_id, status)

    if error:
        status_code = 404 if error == "Site not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(
        current_user["name"],
        "Site Activated" if status == "Active" else "Site Deactivated",
        details=site["site_name"], user_id=current_user["id"],
        target_type="site", target_id=site_id, company_id=tenant_id,
    )

    return jsonify({"success": True, "site": site})


@api.route("/company/sites/<int:site_id>/access", methods=["GET"])
@company_admin_required
@module_required("site_management")
def company_sites_get_access(site_id):

    current_user = get_current_user()

    access, error = get_site_access(site_id, get_tenant_id(current_user))

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify({"success": True, **access})


@api.route("/company/sites/<int:site_id>/access", methods=["PUT"])
@company_admin_required
@module_required("site_management")
def company_sites_set_access(site_id):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)
    data = request.get_json(silent=True) or {}

    access, error = set_site_access(site_id, tenant_id, data.get("user_ids"))

    if error:
        status_code = 404 if error == "Site not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    site = get_site(site_id, tenant_id)
    log_activity(
        current_user["name"], "Site Access Updated",
        details=site["site_name"] if site else str(site_id),
        user_id=current_user["id"],
        target_type="site", target_id=site_id, company_id=tenant_id,
    )

    return jsonify({"success": True, **access})


@api.route("/company/sites/<int:site_id>/check-status", methods=["POST"])
@company_admin_required
@module_required("site_management")
@rate_limited("site_check_status", max_attempts=10, window_seconds=60)
def company_sites_check_status(site_id):

    current_user = get_current_user()

    site, error = check_site_status(site_id, get_tenant_id(current_user))

    if error:
        return jsonify({"success": False, "message": error}), 404

    return jsonify({"success": True, "site": site})


# ==============================
# Normal Camera API (Company Admin, or a User granted "normal_camera")
# ==============================
# A separate, deliberately minimal camera registry — name/location/
# assigned User/description only. No camera_ip/rtsp_url/brand/
# credentials, no connection test, no AI Detection Engine worker (see
# api/normal_cameras.py, the NormalCamera model) — purely metadata,
# save and display. Same scoping/permission idiom as /company/cameras
# above, gated by its own "normal_camera" module instead of
# "camera_management" so the two pages can be granted independently.
@api.route("/company/normal-cameras", methods=["GET"])
@company_or_user_required
@module_required("normal_camera")
def company_normal_cameras_list():

    current_user = get_current_user()
    cameras = get_normal_cameras_for_customer(
        get_tenant_id(current_user), owner_user_id=_mutation_owner_restriction(current_user)
    )

    return jsonify({"total": len(cameras), "cameras": cameras})


@api.route("/company/normal-cameras", methods=["POST"])
@company_or_user_required
@module_required("normal_camera")
def company_normal_cameras_create():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    # A User caller's camera is ALWAYS assigned to their own id, never
    # trusted from the request body — same "can never assign to anyone
    # but themselves" rule as /company/cameras (company_cameras_create).
    if current_user["role"] == ROLE_USER:
        owner_user_id = current_user["id"]
    else:
        owner_user_id = data.get("owner_user_id")

    camera, error = add_normal_camera(
        get_tenant_id(current_user),
        data.get("camera_name"),
        data.get("camera_location"),
        data.get("description"),
        owner_user_id=owner_user_id,
    )

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(current_user["name"], "Normal Camera Added", details=camera["camera_name"], user_id=current_user["id"])

    return jsonify({"success": True, "camera": camera}), 201


@api.route("/company/normal-cameras/<int:camera_id>", methods=["PUT"])
@company_or_user_required
@module_required("normal_camera")
def company_normal_cameras_update(camera_id):

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    # Same "never trust owner_user_id from a User's request body" rule as
    # create above.
    if current_user["role"] == ROLE_USER:
        owner_user_id = current_user["id"]
    else:
        owner_user_id = data.get("owner_user_id")

    camera, error = update_normal_camera(
        camera_id,
        get_tenant_id(current_user),
        data.get("camera_name"),
        data.get("camera_location"),
        data.get("description"),
        owner_user_id=owner_user_id,
        restrict_to_owner_user_id=_mutation_owner_restriction(current_user),
    )

    if error:
        status_code = 404 if error == "Camera not found." else 400
        return jsonify({"success": False, "message": error}), status_code

    log_activity(current_user["name"], "Normal Camera Updated", details=camera["camera_name"], user_id=current_user["id"])

    return jsonify({"success": True, "camera": camera})


@api.route("/company/normal-cameras/<int:camera_id>", methods=["DELETE"])
@company_or_user_required
@module_required("normal_camera")
def company_normal_cameras_delete(camera_id):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)
    restrict_to = _mutation_owner_restriction(current_user)

    camera = get_normal_camera(camera_id, tenant_id, restrict_to_owner_user_id=restrict_to)
    deleted = delete_normal_camera(camera_id, tenant_id, restrict_to_owner_user_id=restrict_to)

    if not deleted:
        return jsonify({"success": False, "message": "Camera not found."}), 404

    log_activity(
        current_user["name"],
        "Normal Camera Deleted",
        details=camera["camera_name"] if camera else str(camera_id),
        user_id=current_user["id"],
    )

    return jsonify({"success": True, "message": "Camera deleted successfully."})


# ==============================
# Notification & Reporting Layer (Admin/Super Admin only)
# ==============================
# Everything below is a self-contained layer AROUND the AI detection
# pipeline, not part of it — see notifications/ and reports/ (new
# top-level packages, sibling to api/auth/camera/face/attendance).
# Scoped to get_tenant_id(current_user) exactly like Settings/AI
# Settings above (a Company Admin's own company; a Super Admin visiting
# this page manages their own account's row, same edge case
# resolve_settings_target_id's callers already accept elsewhere).
# Gated by admin_required, NOT module_required("settings") — a User must
# never reach these routes even if granted the "settings" module,
# per this feature's explicit "Admin panel only" requirement.
@api.route("/notifications/settings", methods=["GET"])
@admin_required
def notification_settings_get():

    current_user = get_current_user()

    return jsonify({"settings": get_notification_settings(get_tenant_id(current_user))})


@api.route("/notifications/settings/unknown-alert", methods=["PUT"])
@admin_required
@rate_limited("notification_settings", max_attempts=30, window_seconds=60)
def notification_settings_update_unknown_alert():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    updated, error = update_unknown_alert_settings(get_tenant_id(current_user), data)

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(current_user["name"], "Unknown Person Alert Settings Updated", user_id=current_user["id"])

    return jsonify({"success": True, "settings": updated})


@api.route("/notifications/settings/detection-alerts", methods=["PUT"])
@admin_required
@rate_limited("notification_settings", max_attempts=30, window_seconds=60)
def notification_settings_update_detection_alerts():
    """Vehicle / Fire-Smoke / Animal / Bird alert toggles — each fully
    independent of the others and of Unknown Person Alert's own toggle
    (see api/notification_settings.DETECTION_ALERT_KEYS)."""

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    updated, error = update_detection_alert_settings(get_tenant_id(current_user), data)

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(current_user["name"], "Detection Alert Settings Updated", user_id=current_user["id"])

    return jsonify({"success": True, "settings": updated})


@api.route("/notifications/settings/daily-report", methods=["PUT"])
@admin_required
@rate_limited("notification_settings", max_attempts=30, window_seconds=60)
def notification_settings_update_daily_report():

    current_user = get_current_user()
    data = request.get_json(silent=True) or {}

    updated, error = update_daily_report_settings(get_tenant_id(current_user), data)

    if error:
        return jsonify({"success": False, "message": error}), 400

    log_activity(current_user["name"], "Daily Report Settings Updated", user_id=current_user["id"])

    return jsonify({"success": True, "settings": updated})


@api.route("/notifications/settings/reset", methods=["POST"])
@admin_required
def notification_settings_reset():

    current_user = get_current_user()
    updated = reset_notification_settings(get_tenant_id(current_user))

    log_activity(current_user["name"], "Notification & Report Settings Reset", user_id=current_user["id"])

    return jsonify({"success": True, "settings": updated})


# Notification History — Unknown Person Alert send attempts, most recent
# first. Recipient numbers are masked (see notifications/service.py's
# get_notification_logs) since this is a read-only history view, unlike
# the settings routes above where the Admin needs the real number to
# edit it.
@api.route("/notifications/logs", methods=["GET"])
@admin_required
def notification_logs_get():

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    try:
        limit = min(int(request.args.get("limit", 100)), 500)
    except (TypeError, ValueError):
        limit = 100

    # Settings page's per-User WhatsApp & Reports scope: ?user_id=
    # narrows history to exactly that ONE User's own alerts — validated
    # against get_company_user first so a caller can never see another
    # company's User's history by guessing an id.
    related_user_id = None
    raw_user_id = request.args.get("user_id")

    if raw_user_id:
        try:
            related_user_id = int(raw_user_id)
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Invalid user_id."}), 400

        _user, error = get_company_user(tenant_id, related_user_id)
        if error:
            return jsonify({"success": False, "message": error}), 404

    logs = get_notification_logs(tenant_id, limit=limit, related_user_id=related_user_id)

    return jsonify({"total": len(logs), "logs": logs})


@api.route("/notifications/logs/<int:log_id>", methods=["DELETE"])
@admin_required
def notification_logs_delete(log_id):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    if not delete_notification_log(tenant_id, log_id):
        return jsonify({"success": False, "message": "Notification log not found."}), 404

    return jsonify({"success": True, "message": "Notification log deleted."})


# Daily Report history + on-demand generation (for testing, and for an
# Admin who wants "today's report" before its scheduled time). Both
# reuse reports.daily_report.generate_and_send_daily_report — the exact
# same function reports/scheduler.py calls — so a manual run and a
# scheduled run behave identically.
@api.route("/reports/daily-report/logs", methods=["GET"])
@admin_required
def daily_report_logs_get():

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    try:
        limit = min(int(request.args.get("limit", 100)), 500)
    except (TypeError, ValueError):
        limit = 100

    target_user_id = None
    raw_user_id = request.args.get("user_id")

    if raw_user_id:
        try:
            target_user_id = int(raw_user_id)
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Invalid user_id."}), 400

        _user, error = get_company_user(tenant_id, target_user_id)
        if error:
            return jsonify({"success": False, "message": error}), 404

    logs = get_report_logs(tenant_id, limit=limit, user_id=target_user_id)

    return jsonify({"total": len(logs), "logs": logs})


@api.route("/reports/daily-report/logs/<int:log_id>", methods=["DELETE"])
@admin_required
def daily_report_logs_delete(log_id):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    if not delete_report_log(tenant_id, log_id):
        return jsonify({"success": False, "message": "Report log not found."}), 404

    return jsonify({"success": True, "message": "Report log deleted."})


@api.route("/reports/daily-report/generate-now", methods=["POST"])
@admin_required
@rate_limited("report_generate", max_attempts=5, window_seconds=60)
def daily_report_generate_now():
    """Manual trigger — used for testing (see this feature's Testing
    section: "Do not claim WhatsApp delivery is tested because the
    external API has not been integrated yet"). `force=true` bypasses
    the same-day idempotency guard so a report can be regenerated
    repeatedly while testing without needing to wait for the next
    calendar day. Optional `user_id` generates that specific User's own
    personalized report instead of the company-wide one — ownership-
    checked via get_company_user, same as every other per-User route."""

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    data = request.get_json(silent=True) or {}
    force = bool(data.get("force"))
    target_user_id = data.get("user_id")

    if target_user_id is not None:
        _user, error = get_company_user(tenant_id, target_user_id)
        if error:
            return jsonify({"success": False, "message": error}), 404

    result = generate_and_send_daily_report(tenant_id, force=force, target_user_id=target_user_id)

    if result is None:
        return jsonify({"success": False, "message": "Report generation failed. Check the server logs."}), 500

    log_activity(current_user["name"], "Daily Report Generated (Manual)", details=str(result), user_id=current_user["id"])

    return jsonify({"success": True, "result": result})


@api.route("/reports/daily-report/download/<filename>", methods=["GET"])
@admin_required
def daily_report_download(filename):

    current_user = get_current_user()
    tenant_id = get_tenant_id(current_user)

    safe_filename = get_daily_report_filepath(tenant_id, filename)

    if safe_filename is None:
        return jsonify({"success": False, "message": "Report not found."}), 404

    return send_from_directory(daily_report_folder(tenant_id), safe_filename, as_attachment=True)
