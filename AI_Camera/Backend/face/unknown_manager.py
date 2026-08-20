import os
import cv2
import time
import threading
import numpy as np
from datetime import datetime

from sqlalchemy import select, func

from db import get_session
from auth.models import UnknownPerson, Camera
from face.embedding_codec import encode_embeddings, decode_single_embedding
from camera.processing_locks import get_customer_lock
from error_logging import log_exception

# ==========================================
# Per-customer image folders
# ==========================================
# Face/frame images stay filesystem-based (per the storage-migration spec
# — only structured metadata and embeddings moved to MySQL). Every
# capture lives under a customer_id subfolder — the same isolation
# boundary used throughout api/*.py. A shared global store here would
# mean a face the live camera failed to recognize for Customer B gets
# compared against (and potentially merged with) Customer A's previously
# -saved unknown people, which is exactly the kind of cross-tenant leak
# this fix closes.
CUSTOMERS_ROOT = os.path.join("dataset", "customers")


def _customer_root(customer_id):
    return os.path.join(CUSTOMERS_ROOT, str(customer_id))


def _unknown_face_folder(customer_id):
    return os.path.join(_customer_root(customer_id), "unknown")


def _unknown_embedding_folder(customer_id):
    """No longer used to store anything (embeddings live in MySQL now) —
    kept only so any stale on-disk folder from before this migration
    doesn't need manual cleanup, and as a stable name if ever needed
    again."""

    return os.path.join(_customer_root(customer_id), "unknown_embeddings")


# ==========================================
# Settings
# ==========================================
# Fallback only — real value is this company's own AI Settings
# (Settings > AI Settings > Unknown Duplicate Threshold,
# unknown_duplicate_threshold), read live via
# _resolve_duplicate_threshold() below. Governs the SAME InsightFace/
# ArcFace embedding space recognizer.py's recognition_threshold does,
# but is intentionally a SEPARATE setting — "is this the same unknown
# person I already saved" and "does this match a registered person" are
# different questions an operator may reasonably want tuned differently.
DEFAULT_SIMILARITY_THRESHOLD = 0.50


def _resolve_duplicate_threshold(customer_id):

    try:
        from api.ai_config import get_ai_config
        return get_ai_config(customer_id)["unknown_duplicate_threshold"]
    except Exception as e:
        log_exception(e, "unknown duplicate-threshold lookup")
        return DEFAULT_SIMILARITY_THRESHOLD

# Fallback only — real value comes from Settings > AI Settings >
# "Unknown Person Cooldown (Minutes)" (ai_retry_interval_minutes), read
# live via _get_save_cooldown_seconds() below.
DEFAULT_SAVE_COOLDOWN_SECONDS = 5

# Cooldown state is per (customer, BATCH) — one video frame for that
# customer's active stream — not per individual face, and not shared
# across customers. Decided ONCE per frame by the caller
# (camera/frame_processor.py) via is_new_unknown_save_allowed(), and
# reported back via mark_unknown_batch_saved() only after the whole
# frame's faces have been processed — so every face in the same frame is
# judged against the same, unmoved cooldown clock (otherwise the first
# face's save would start the cooldown clock the very next face in that
# same frame gets wrongly blocked by).
_last_batch_time = {}  # customer_id -> float

# Re-reading the settings database on every single processed frame would
# add a DB round-trip to the hot path; a short cache keeps the cooldown
# "live" (a Settings change takes effect within a few seconds) without
# querying on every frame. Kept per customer_id since different
# customers can configure a different cooldown.
_cooldown_cache = {}  # customer_id -> {"seconds": float, "checked_at": float}
_COOLDOWN_CACHE_TTL = 5  # seconds


def _get_save_cooldown_seconds(customer_id):
    """How long to wait before a brand-new (non-matching) unknown person
    can be saved again for this customer — configurable via the Settings
    page instead of a hardcoded constant, so the value shown in Settings
    actually controls real detection behavior."""

    now = time.time()
    cached = _cooldown_cache.get(customer_id)

    if cached is not None and now - cached["checked_at"] < _COOLDOWN_CACHE_TTL:
        return cached["seconds"]

    try:
        from api.settings import get_settings
        # Settings are per-account now (see api/settings.py), but this
        # background pipeline always reads the Company Admin's own copy
        # (customer_id here is always the tenant/Admin's id, never a
        # regular User's — see auth.auth.get_tenant_id) — unaffected by
        # any individual User's own personal settings.
        minutes = get_settings(customer_id).get("ai_retry_interval_minutes", DEFAULT_SAVE_COOLDOWN_SECONDS / 60)
        seconds = max(float(minutes), 0) * 60
    except Exception as e:
        log_exception(e, "unknown-save cooldown lookup")
        seconds = DEFAULT_SAVE_COOLDOWN_SECONDS

    _cooldown_cache[customer_id] = {"seconds": seconds, "checked_at": now}

    return seconds


def is_new_unknown_save_allowed(customer_id, frame_time=None):
    """Read-only cooldown check, meant to be called ONCE per video frame
    (before looping over that frame's faces) — never mutates state, so
    every face detected in the same frame gets the same answer."""

    if frame_time is None:
        frame_time = time.time()

    last_batch_time = _last_batch_time.get(customer_id, 0)

    return (frame_time - last_batch_time) >= _get_save_cooldown_seconds(customer_id)


def mark_unknown_batch_saved(customer_id, frame_time=None):
    """Call once after a frame's faces have all been processed, only if
    at least one brand-new unknown person was actually saved during it —
    starts the cooldown for the NEXT frame/batch, for this customer only."""

    if frame_time is None:
        frame_time = time.time()

    _last_batch_time[customer_id] = frame_time


# ==========================================
# Cosine Similarity
# ==========================================
def cosine_similarity(a, b):

    return np.dot(a, b) / (
        np.linalg.norm(a) *
        np.linalg.norm(b)
    )


# ==========================================
# Update Unknown Database
# ==========================================
def update_unknown_database(customer_id, unknown_person_id):
    """Bumps last_seen/detection_count for an already-saved unknown
    person recognized again — `unknown_person_id` is the MySQL row id
    (see _find_best_match), replacing the old embedding-filename key."""

    now_str = datetime.now().strftime("%d-%m-%Y %H:%M:%S")

    with get_session() as session:
        row = session.get(UnknownPerson, unknown_person_id)

        if row is not None and row.customer_id == customer_id:
            row.last_seen = now_str
            row.detection_count = (row.detection_count or 0) + 1


def _resolve_camera_location(camera_id):

    if camera_id is None:
        return None

    with get_session() as session:
        camera = session.get(Camera, camera_id)
        return camera.camera_location if camera else None


def _resolve_camera_name(camera_id):
    """Used only by the Notification & Reporting layer's Unknown Person
    Alert event below — not consulted anywhere in the detection/matching
    logic above."""

    if camera_id is None:
        return None

    with get_session() as session:
        camera = session.get(Camera, camera_id)
        return camera.camera_name if camera else None


def _resolve_camera_owner(camera_id):
    """Per-User Data Isolation: the User this camera is assigned to
    (None if unassigned/no camera_id) — the UnknownPerson row this
    detection produces inherits this at creation time, same derivation
    rule as attendance/attendance.py's mark_attendance."""

    if camera_id is None:
        return None

    with get_session() as session:
        camera = session.get(Camera, camera_id)
        return camera.owner_user_id if camera else None


# ==========================================
# In-memory embedding cache (same pattern as face/database.py's
# registered-persons cache), kept per customer_id so one customer's
# unknown-face matching can never be influenced by another customer's
# already-saved unknown people.
# ==========================================
# Re-decoding every saved unknown person's embedding blob from MySQL on
# every single call was the real per-face cost here: with N people
# already saved and M new unknown faces in one frame, that's N*M
# embedding decodes every frame. A cheap (COUNT, MAX id) signature check
# against MySQL (indexed, no BLOB columns touched) decides whether a full
# reload is even needed — the same "cheap to check, only reload when
# something actually changed" property the old bare os.listdir() diff
# had, just expressed against MySQL instead of the filesystem.
_embedding_cache = {}  # customer_id -> {unknown_person_id -> normalized embedding}
_cache_signature = {}  # customer_id -> (count, max_id)


def _refresh_embedding_cache(customer_id):

    with get_session() as session:
        count, max_id = session.execute(
            select(func.count(UnknownPerson.id), func.max(UnknownPerson.id))
            .where(UnknownPerson.customer_id == customer_id)
        ).one()

    signature = (count or 0, max_id or 0)

    if _cache_signature.get(customer_id) == signature:
        return

    with get_session() as session:
        rows = session.execute(
            select(UnknownPerson.id, UnknownPerson.embedding).where(UnknownPerson.customer_id == customer_id)
        ).all()

    cache = {}

    for row_id, blob in rows:

        vec = decode_single_embedding(blob)

        if vec is None:
            continue

        norm = np.linalg.norm(vec)

        if norm > 0:
            vec = vec / norm

        cache[row_id] = vec

    _embedding_cache[customer_id] = cache
    _cache_signature[customer_id] = signature


def _find_best_match(customer_id, embedding):
    """Best (score, unknown_person_id) match for `embedding` against
    every currently-saved unknown person belonging to this customer.

    --- CPU Optimization: vectorized matching ---
    Previously this called cosine_similarity() once per cached unknown
    person, in a plain Python loop. Both `embedding` (normalized by
    save_unknown() before this is ever called) and every vector in
    _embedding_cache (normalized in _refresh_embedding_cache above) are
    already unit vectors, so their cosine similarity is just their dot
    product — stacking every cached vector into one (N, 512) matrix and
    multiplying by `embedding` once computes every score in a single
    NumPy call instead of N individual Python-level function calls. Same
    "highest score wins, first occurrence on a tie" behavior as the
    original loop (np.argmax also returns the first index of the max)."""

    _refresh_embedding_cache(customer_id)

    cache = _embedding_cache.get(customer_id, {})

    if not cache:
        return -1.0, None

    ids = list(cache.keys())
    matrix = np.stack([cache[i] for i in ids])  # (N, 512), already unit-normalized
    scores = matrix @ embedding  # embedding is already unit-normalized by the caller

    best_idx = int(np.argmax(scores))

    return float(scores[best_idx]), ids[best_idx]


# ==========================================
# Save Unknown Person
# ==========================================
def save_unknown(customer_id, face_image, full_frame, embedding, allow_new_save=True, camera_id=None, confidence=None, owner_user_id_fallback=None):
    """Processes one detected-as-unrecognized face for this customer.

    `allow_new_save` is the cooldown decision for the CURRENT FRAME, made
    once by the caller via is_new_unknown_save_allowed() before looping
    over that frame's faces.

    `camera_id`/`confidence` (both optional) record which camera produced
    this detection and the recognizer's match confidence at the moment it
    decided "unknown" — both threaded through from
    camera/frame_processor.py, which already has them available. Absent
    for the standalone interactive script (camera/camera.py), which
    passes neither.

    `owner_user_id_fallback` (optional) is a caller-supplied fallback used
    ONLY when `camera_id` is None — i.e. only the local-webcam debug
    source (camera/stream.py's start_local), which has no `cameras` table
    row for `_resolve_camera_owner` to look up, so it would otherwise
    always save owner_user_id=None and never surface on any specific
    User's Dashboard (only the Admin's unfiltered aggregate). A real
    camera_id still resolves ownership exactly as before — a fresh DB
    lookup via `_resolve_camera_owner`, unaffected by this parameter. The
    resolved result is what every use of `owner_user_id` below this point
    (the saved row, the in-app notification, the WhatsApp alert event)
    actually reads — there is deliberately only ever one owner_user_id
    value in play past this point, never two.
    """

    if face_image is None or face_image.size == 0:
        return False

    os.makedirs(_unknown_face_folder(customer_id), exist_ok=True)

    # Use embedding from recognizer
    embedding = embedding.astype(np.float32)
    embedding /= max(np.linalg.norm(embedding), 1e-8)

    # Check duplicate unknown — this permanently recognizes the SAME
    # physical unknown person across frames. There is no consensus/voting
    # here (see camera/frame_processor.py — Unknown faces are handled
    # single-attempt, one call to this function per detection): this
    # embedding comparison against every already-saved unknown person is
    # the ENTIRE mechanism that decides new-vs-duplicate.
    # Narrowed lock (see camera/processing_locks.py): "is this a duplicate
    # of an already-saved unknown person" is a check-then-write against
    # both the in-memory embedding cache AND MySQL — two sibling cameras
    # for this customer detecting the same physical unknown person at the
    # same instant could otherwise both decide "not a duplicate" and both
    # insert a new row. Everything from the duplicate check through the
    # cache sync after a successful insert must stay serialized per
    # customer; YOLO/InsightFace inference that already ran to produce
    # `embedding` is NOT covered by any lock anymore, so this must start
    # here, not any earlier.
    with get_customer_lock(customer_id):

        duplicate_threshold = _resolve_duplicate_threshold(customer_id)
        best_score, best_id = _find_best_match(customer_id, embedding)
        is_duplicate = best_score >= duplicate_threshold

        print(f"[UNKNOWN] Matched Existing Unknown: {'Yes' if is_duplicate else 'No'} (best_score={best_score:.4f}, best_id={best_id}, threshold={duplicate_threshold})")

        if is_duplicate:
            update_unknown_database(customer_id, best_id)
            print(f"[UNKNOWN] Unknown Saved: False (duplicate of id={best_id}, similarity={best_score:.2f})")
            print(f"[UNKNOWN] Detection Count Updated: True (id={best_id})")
            print("[UNKNOWN] Analytics Updated: False (duplicate detections do not increase Daily/Monthly charts)")
            return False

        # Cooldown — only gates creating a brand-new unknown person (a
        # duplicate re-sighting above is never rate-limited, since it's
        # just a Last Seen/Detection Count bump, not a new record).
        if not allow_new_save:
            print("[UNKNOWN] Unknown Saved: False (new-person cooldown active)")
            return False

        now = datetime.now()
        now_str = now.strftime("%d-%m-%Y %H:%M:%S")
        location = _resolve_camera_location(camera_id)
        # From here on, `owner_user_id` IS the resolved value — every
        # later reference in this function (the row below, the in-app
        # notification, the WhatsApp alert event) reads this same name,
        # so there is no risk of any of them accidentally using the raw,
        # unresolved fallback parameter instead.
        owner_user_id = _resolve_camera_owner(camera_id) if camera_id is not None else owner_user_id_fallback

        with get_session() as session:

            row = UnknownPerson(
                customer_id=customer_id,
                camera_id=camera_id,
                embedding=encode_embeddings(embedding),
                detected_time=now_str,
                last_seen=now_str,
                detection_count=1,
                location=location,
                confidence=float(confidence) if confidence is not None else None,
                created_at=now_str,
                owner_user_id=owner_user_id,
            )
            session.add(row)
            session.flush()
            new_id = row.id

            face_name = f"unknown_{new_id:03}.jpg"
            frame_name = f"frame_{new_id:03}.jpg"

            face_path = os.path.join(_unknown_face_folder(customer_id), face_name)
            frame_path = os.path.join(_unknown_face_folder(customer_id), frame_name)

            face_saved = cv2.imwrite(face_path, face_image)
            frame_saved = cv2.imwrite(frame_path, full_frame)

            if not face_saved or not frame_saved:
                print(f"[UNKNOWN] Unknown Saved: False (image write failed, id={new_id}, face_saved={face_saved}, frame_saved={frame_saved})")
                session.delete(row)
                return False

            row.image_path = face_name
            row.frame_image_path = frame_name

        print(f"[UNKNOWN] Unknown Saved: True (new record, id={new_id})")
        print(f"[UNKNOWN] Image Path: {face_path}")
        print(f"[UNKNOWN] Database Saved: True (id={new_id})")
        print(f"[UNKNOWN] Detection Count Updated: True (initial count=1, id={new_id})")
        print(f"[UNKNOWN] Analytics Updated: True (id={new_id} counts toward today's Daily and this month's Monthly chart)")

        # Keep the in-memory cache in sync immediately — so if another
        # face in this SAME frame happens to be this same new person
        # again (e.g. two overlapping detections), it's recognized as a
        # duplicate right away instead of also being saved as yet
        # another "new" person.
        _embedding_cache.setdefault(customer_id, {})[new_id] = embedding

        # Keep the signature in step with the cache we just updated by
        # hand — a fresh COUNT/MAX query would just confirm what we
        # already know, so update it directly instead of invalidating
        # (which would force a redundant reload on the very next call).
        old_count, _old_max = _cache_signature.get(customer_id, (0, 0))
        _cache_signature[customer_id] = (old_count + 1, new_id)

    # Unknown Person Alerts OFF: the unknown person above is still saved
    # in full (image, embedding, database row) — only the alert
    # notification for this detection is suppressed. Lazily imported for
    # the same reason as _get_save_cooldown_seconds()'s `api.settings`
    # import above.
    try:
        from api.ai_config import get_ai_config
        alerts_enabled = get_ai_config(customer_id)["unknown_alerts_enabled"]
    except Exception as e:
        log_exception(e, "unknown-alert config lookup")
        alerts_enabled = True

    # notify_unknown_person (Settings > Notifications) previously existed
    # as a stored preference with no actual effect anywhere — Per-User
    # Data Isolation's Notifications feature is what finally wires it up
    # to something real, alongside the pre-existing unknown_alerts_enabled
    # AI Setting (both must be on).
    try:
        from api.settings import get_settings
        # Same as the cooldown lookup above — always the Company Admin's
        # own copy, unaffected by any individual User's own settings.
        notify_enabled = get_settings(customer_id).get("notify_unknown_person", True)
    except Exception as e:
        log_exception(e, "notify_unknown_person settings lookup")
        notify_enabled = True

    if alerts_enabled:
        print("=" * 50)
        print("UNKNOWN PERSON ALERT — NEW UNKNOWN PERSON SAVED")
        print("Customer :", customer_id)
        print("ID       :", new_id)
        print("Face     :", face_name)
        print("Frame    :", frame_name)
        print("Camera   :", camera_id)
        print("Confidence :", confidence)
        print("Date     :", now.strftime("%d-%m-%Y"))
        print("Time     :", now.strftime("%H:%M:%S"))
        print("=" * 50)

        if notify_enabled:
            try:
                from api.notifications import create_notification
                create_notification(
                    customer_id,
                    owner_user_id,
                    type="unknown_person",
                    message=f"New unknown person detected{f' at {location}' if location else ''}.",
                    camera_id=camera_id,
                )
            except Exception as e:
                log_exception(e, f"create_notification (unknown_person, id={new_id})")

    # ==========================================
    # Notification & Reporting Layer (WhatsApp Unknown Person Alert)
    # ==========================================
    # Fully independent of the in-app Notification bell above — this is
    # the Admin-configurable WhatsApp alert (Settings > Notifications &
    # Reports), gated entirely by its OWN settings inside
    # NotificationService (enabled/disabled, recipient, confidence
    # threshold, cooldown). Fired unconditionally here, for every
    # brand-new unknown person actually saved, regardless of
    # unknown_alerts_enabled/notify_unknown_person above — those two only
    # ever controlled the legacy in-app bell. Isolated in its own
    # try/except so a bug or misconfiguration in the notification layer
    # can never affect detection, tracking, or the save that just
    # succeeded above.
    try:
        from notifications.events import build_unknown_person_confirmed_event
        from notifications.service import handle_unknown_person_confirmed

        event = build_unknown_person_confirmed_event(
            customer_id=customer_id,
            unknown_person_id=new_id,
            camera_id=camera_id,
            camera_name=_resolve_camera_name(camera_id),
            # Full camera frame (frame_path), not the cropped face
            # (face_path) — the WhatsApp Unknown Person alert must show
            # the same complete-frame evidence image as the Unknown
            # Persons dashboard, per this feature's "never send only the
            # face crop" requirement. face_path/face_image remain used
            # internally for recognition/embedding — untouched.
            captured_image_path=frame_path,
            confidence=confidence,
            detected_at=now_str,
            location=location,
            owner_user_id=owner_user_id,
        )
        # Dispatched on its own thread — handle_unknown_person_confirmed
        # can now make a real outbound WhatsApp API call (network I/O),
        # which must never stall this detection/processor thread's next
        # frame. It's already fully exception-isolated internally (see
        # its own docstring: "Never raises"), so nothing here needs to
        # join it or inspect its result.
        threading.Thread(
            target=handle_unknown_person_confirmed,
            args=(event,),
            daemon=True,
            name=f"whatsapp-alert-{new_id}",
        ).start()
    except Exception as e:
        log_exception(e, f"NotificationService dispatch (unknown_person, id={new_id})")

    return True
