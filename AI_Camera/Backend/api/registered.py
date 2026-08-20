import os
import shutil
import numpy as np
import cv2
from datetime import datetime

from sqlalchemy import select, text

from db import get_session, engine
from auth.models import RegisteredPerson
from face.face_detector import detect_faces
from face.quality import rank_face_quality
from face.embedding_codec import encode_embeddings
from api.attendance import delete_attendance_for_person, rename_attendance_person
from api.validators import validate_text_field, validate_image_upload
from api.scope import apply_owner_scope
from auth.database import get_users_by_parent

# Base Path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Face images stay filesystem-based (per the storage-migration spec —
# only structured metadata and embeddings moved to MySQL) — this is the
# actual data-isolation boundary for them. Without it, every customer
# reads and writes the exact same files, which is why a brand-new
# Customer B used to see Customer A's registered persons immediately on
# first login.
CUSTOMERS_ROOT = os.path.join(BASE_DIR, "dataset", "customers")

ALLOWED_EXTENSIONS = (".jpg", ".jpeg", ".png")

# Matches the frontend's upload-selection requirement (RegisteredPersons.jsx
# MIN_IMAGES) — how many raw files the Add-Person form requires the admin
# to choose before Save is even enabled. Purely a UI guardrail now, not a
# backend accept/reject gate — see MIN_EMBEDDING_COUNT/TARGET_EMBEDDING_COUNT
# below for that. Keeping both named "MIN_IMAGES"-adjacent and cross-
# referenced in comments is what keeps them from drifting apart silently.
MIN_IMAGES = 20

# The real acceptance gate: fewer than this many images passing every
# quality check (face/quality.py) and registration is rejected outright.
MIN_EMBEDDING_COUNT = 8

# Never store more than this many embeddings for one person, even if
# every uploaded image was excellent — only the highest-scoring subset is
# kept (see _select_best). This is the core of the optimization: the old
# pipeline ran full detection+quality+embedding on every image TWICE
# (once to validate, once to actually generate) and stored an embedding
# for every image that passed, however many that was. This pipeline runs
# detection+quality+embedding exactly ONCE per uploaded image, and keeps
# only the best TARGET_EMBEDDING_COUNT of them — fewer, curated
# embeddings per person, not a slower/duplicated version of "keep them
# all".
TARGET_EMBEDDING_COUNT = 10

MAX_IMAGE_BYTES = 5 * 1024 * 1024
EMPLOYEE_ID_MAX = 30


def init_registered_persons_table():
    """Per-User Data Isolation — owner_user_id backfill for a
    registered_persons table that predates this column, same idempotent
    INFORMATION_SCHEMA-guarded pattern as api/cameras.py's
    init_cameras_table(). Must run after auth.database.init_db()."""

    with engine.connect() as conn:
        existing_columns = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'registered_persons'"
                )
            )
        }

        if "owner_user_id" not in existing_columns:
            conn.execute(text("ALTER TABLE registered_persons ADD COLUMN owner_user_id INTEGER NULL"))
            conn.execute(text("ALTER TABLE registered_persons ADD INDEX idx_registered_persons_owner_user_id (owner_user_id)"))
            conn.execute(text(
                "ALTER TABLE registered_persons ADD CONSTRAINT fk_registered_persons_owner_user_id "
                "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL"
            ))
            conn.commit()


def _customer_root(customer_id):
    return os.path.join(CUSTOMERS_ROOT, str(customer_id))


def faces_folder(customer_id):
    return os.path.join(_customer_root(customer_id), "faces")


def _is_safe_name(name):
    return bool(name) and "/" not in name and "\\" not in name and ".." not in name


def _person_image_files(person_folder):

    if not os.path.isdir(person_folder):
        return []

    return sorted(
        f for f in os.listdir(person_folder)
        if f.lower().endswith(ALLOWED_EXTENSIONS)
    )


def get_registered_persons(customer_id, owner_user_id=None, limit=None, offset=None):
    """The single source of truth for "how many people are registered" —
    Dashboard and every other consumer must derive their count from this
    same list, so the number shown can never drift from what this
    function actually returns. The set of persons and their metadata
    (name, employee_id, status) comes from MySQL; only the image
    thumbnail/count/registered-date are still resolved from the
    filesystem, since images themselves stay file-based. A person with no
    usable images is excluded from both the list and the count — there's
    nothing to recognize or display for them.

    `limit`/`offset` (both default None — unbounded, identical to every
    existing caller's current behavior) optionally page the RETURNED
    list only, applied after the images-exist filter above so a caller
    that opts into paging still gets each page's real, complete rows.
    The returned total count is always the FULL count (every registered
    person with usable images), never just this page's size — every
    existing consumer (Dashboard, api/reports.py's total_registered,
    reports/daily_report.py's attendance summary) depends on that."""

    persons = []

    with get_session() as session:
        query = (
            select(RegisteredPerson)
            .where(RegisteredPerson.customer_id == customer_id)
            .order_by(RegisteredPerson.person_name)
        )
        query = apply_owner_scope(query, RegisteredPerson.owner_user_id, owner_user_id)
        rows = session.scalars(query).all()

        for row in rows:

            person_path = os.path.join(faces_folder(customer_id), row.person_name)
            images = _person_image_files(person_path)

            if not images:
                continue

            persons.append(
                {
                    "id": row.id,
                    "name": row.person_name,
                    "employee_id": row.employee_id or "",
                    "registered_date": (row.created_at or "")[:10],
                    "image": f"http://localhost:5000/faces/{row.person_name}/{images[0]}",
                    "image_count": len(images),
                    "face_status": row.status,
                    "owner_user_id": row.owner_user_id,
                }
            )

    total = len(persons)

    if limit is not None or offset is not None:
        start = offset or 0
        end = (start + limit) if limit is not None else None
        persons = persons[start:end]

    return persons, total


def get_person_images(customer_id, person_name, owner_user_id=None):

    if not _is_safe_name(person_name):
        return None

    with get_session() as session:
        query = select(RegisteredPerson).where(
            RegisteredPerson.customer_id == customer_id, RegisteredPerson.person_name == person_name
        )
        query = apply_owner_scope(query, RegisteredPerson.owner_user_id, owner_user_id)
        row = session.scalar(query)

    if row is None:
        return None

    person_path = os.path.join(faces_folder(customer_id), person_name)

    if not os.path.isdir(person_path):
        return None

    return _person_image_files(person_path)


def _detect_and_score(image, filename, customer_id=None):
    """Runs face detection + quality ranking exactly ONCE on a decoded
    image array. detect_faces()'s InsightFace call already computes the
    embedding alongside the bbox/landmarks in the same forward pass, so
    a candidate that passes already carries the embedding it would
    otherwise need a second, separate pass to (re-)compute — see
    face/quality.py rank_face_quality for the scoring/selection logic
    and face/embedding_generator.py's module docstring for the pipeline
    this replaces for the web upload flow.

    `customer_id` threads through to rank_face_quality so registration
    uses this SAME company's own AI Settings thresholds (Settings >
    AI Settings) instead of the hardcoded module defaults.

    Returns a candidate dict, or None if this image fails any hard
    quality gate (including "more than one face in this photo")."""

    faces = detect_faces(image)

    if not faces:
        return None

    best_face = max(faces, key=lambda f: f.det_score)
    ok, _reason, _metrics, score = rank_face_quality(image, best_face, faces, customer_id)

    if not ok:
        return None

    return {
        "filename": filename,
        "embedding": best_face.embedding.astype(np.float32),
        "score": score,
    }


def _score_uploaded_images(image_files, customer_id=None):
    """FileStorage objects (a fresh upload) -> (candidates, error,
    rejected_count). Each candidate additionally carries the raw `bytes`
    of its source file, so whichever ones make the final cut can be
    written to disk byte-for-byte later — never re-encoded through
    cv2.imwrite, which would recompress the JPEG and quietly reduce
    image quality on every save.

    Extension mismatches are silently dropped (pre-existing behavior — a
    mixed file-picker selection shouldn't hard-fail the whole upload). A
    file that DOES match the extension allow-list but fails the size cap
    or the content-sniff check is a hard error instead of a silent drop,
    since silently dropping it would otherwise surface later as a
    confusing "not enough images" message rather than naming the actual
    problem file."""

    candidates = []
    rejected_count = 0

    for file in (image_files or []):

        if not file or not file.filename:
            continue

        ext = os.path.splitext(file.filename)[1].lower()

        if ext not in ALLOWED_EXTENSIONS:
            continue

        file_bytes = file.stream.read()
        file.stream.seek(0)

        error = validate_image_upload(
            file_bytes, ALLOWED_EXTENSIONS, MAX_IMAGE_BYTES, label=f'Image "{file.filename}"'
        )

        if error:
            return None, error, 0

        decoded = cv2.imdecode(np.frombuffer(file_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)

        if decoded is None:
            rejected_count += 1
            continue

        candidate = _detect_and_score(decoded, file.filename, customer_id)

        if candidate is None:
            rejected_count += 1
            continue

        candidate["bytes"] = file_bytes
        candidate["ext"] = ext
        candidates.append(candidate)

    return candidates, None, rejected_count


def _score_files_on_disk(folder, filenames, customer_id=None):
    """Same single-pass detect-and-score, for images that already exist
    on disk — used by update_registered_person to re-rank a person's
    CURRENTLY kept images alongside any newly uploaded ones. There is no
    per-image record of which embedding (inside the one stacked blob
    MySQL stores) belongs to which file, so a kept file's embedding has
    to be recomputed here rather than looked up — but still only once,
    same as any other candidate."""

    candidates = []

    for filename in filenames:

        path = os.path.join(folder, filename)
        image = cv2.imread(path)

        if image is None:
            continue

        candidate = _detect_and_score(image, filename, customer_id)

        if candidate is not None:
            candidate["existing_path"] = path
            candidate["ext"] = os.path.splitext(filename)[1].lower()
            candidates.append(candidate)

    return candidates


def _select_best(candidates, limit=TARGET_EMBEDDING_COUNT):
    """Selection is ALWAYS by quality score, descending — never upload
    order, never random sampling."""

    return sorted(candidates, key=lambda c: c["score"], reverse=True)[:limit]


def _write_person_folder(person_folder, selected):
    """Leaves person_folder containing EXACTLY the selected images,
    renumbered 001..NNN — every uploaded/kept image that didn't make the
    final selection is discarded, not archived (the spec's recommended
    "only save the best images" option, not "save everything").

    Kept-on-disk candidates are staged through a collision-free temp name
    first, since renumbering in place can otherwise clobber a file that
    hasn't been read yet when two images swap positions (e.g. the image
    that was 003.jpg needs to become 001.jpg while 001.jpg needs to
    become 003.jpg)."""

    os.makedirs(person_folder, exist_ok=True)

    for candidate in selected:

        if "bytes" in candidate:
            continue

        existing_path = candidate.get("existing_path")

        if existing_path and os.path.exists(existing_path):
            temp_path = os.path.join(person_folder, f".tmp_{id(candidate)}{candidate.get('ext') or '.jpg'}")
            shutil.move(existing_path, temp_path)
            candidate["_temp_path"] = temp_path

    kept_temp_paths = {c["_temp_path"] for c in selected if "_temp_path" in c}

    for existing_name in os.listdir(person_folder):
        existing_path = os.path.join(person_folder, existing_name)
        if existing_path in kept_temp_paths:
            continue
        if os.path.isfile(existing_path):
            os.remove(existing_path)

    for i, candidate in enumerate(selected, start=1):

        ext = candidate.get("ext") or ".jpg"
        out_path = os.path.join(person_folder, f"{i:03}{ext}")

        if "bytes" in candidate:
            with open(out_path, "wb") as f:
                f.write(candidate["bytes"])
        elif "_temp_path" in candidate:
            shutil.move(candidate["_temp_path"], out_path)

        candidate["final_filename"] = f"{i:03}{ext}"


def _embeddings_blob(selected):
    embeddings = np.array([c["embedding"] for c in selected], dtype=np.float32)
    return encode_embeddings(embeddings)


def _validate_owner_user_id(customer_id, owner_user_id):
    """Shared by add/update — None (unassigned) is always fine; a real
    id must belong to one of this company's own Users. Same rule as
    api/cameras.py's identically-named helper."""

    if owner_user_id is None:
        return None

    company_user_ids = {u["id"] for u in get_users_by_parent(customer_id)}

    if owner_user_id not in company_user_ids:
        return "Selected user does not belong to this company."

    return None


def add_registered_person(customer_id, name, employee_id, image_files, owner_user_id=None):

    name = (name or "").strip()

    error = validate_text_field(name, "Name", min_len=2, max_len=50)
    if error:
        return None, error

    if not _is_safe_name(name):
        return None, "Name contains invalid characters."

    employee_id = (employee_id or "").strip()
    error = validate_text_field(employee_id, "Employee ID", max_len=EMPLOYEE_ID_MAX, required=False)
    if error:
        return None, error

    error = _validate_owner_user_id(customer_id, owner_user_id)
    if error:
        return None, error

    person_folder = os.path.join(faces_folder(customer_id), name)

    if os.path.isdir(person_folder):
        return None, "A person with this name is already registered."

    with get_session() as session:
        existing = session.scalar(
            select(RegisteredPerson).where(
                RegisteredPerson.customer_id == customer_id,
                RegisteredPerson.person_name == name,
            )
        )
        if existing is not None:
            return None, "A person with this name is already registered."

    # One detection+quality+embedding pass per uploaded image — not two
    # (see module docstrings above) — followed by ranking and keeping
    # only the best TARGET_EMBEDDING_COUNT.
    candidates, error, rejected_count = _score_uploaded_images(image_files, customer_id)
    if error:
        return None, error

    if len(candidates) < MIN_EMBEDDING_COUNT:
        if rejected_count:
            return None, (
                f"Only {len(candidates)} of your images passed face-quality checks "
                f"(clear, well-lit, in-focus, single face, not heavily rotated) — {rejected_count} were rejected. "
                f"At least {MIN_EMBEDDING_COUNT} high-quality images are required for registration."
            )
        return None, f"At least {MIN_EMBEDDING_COUNT} high-quality face images are required for registration."

    selected = _select_best(candidates)
    print(f"[DEBUG][add_registered_person] Selected {len(selected)}/{len(candidates)} candidates for {name!r}")

    _write_person_folder(person_folder, selected)
    print(f"[DEBUG][add_registered_person] Image save OK -> {person_folder}")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    blob = _embeddings_blob(selected)
    print(f"[DEBUG][add_registered_person] Embedding generation OK ({len(selected)} vectors, {len(blob)} bytes)")
    thumbnail = selected[0]["final_filename"]

    try:
        with get_session() as session:
            row = RegisteredPerson(
                customer_id=customer_id,
                admin_id=customer_id,
                person_name=name,
                employee_id=employee_id or None,
                face_embedding=blob,
                face_image_path=thumbnail,
                status="Active",
                created_at=now,
                updated_at=now,
                owner_user_id=owner_user_id,
            )
            session.add(row)
            session.flush()
            new_id = row.id
        print(f"[DEBUG][add_registered_person] SQL INSERT + MySQL commit OK id={new_id}")
    except Exception as e:
        print(f"[DEBUG][add_registered_person] SQL INSERT FAILED: {e}")
        raise

    # Built directly instead of re-querying/re-listing every registered
    # person for this tenant just to find the one just added.
    person = {
        "id": new_id,
        "name": name,
        "employee_id": employee_id or "",
        "registered_date": now[:10],
        "image": f"http://localhost:5000/faces/{name}/{thumbnail}",
        "image_count": len(selected),
        "face_status": "Active",
        "owner_user_id": owner_user_id,
    }

    return person, None


_UNSET = object()  # distinct from None, which is a legitimate "unassign" value for owner_user_id


def update_registered_person(
    customer_id, current_name, new_name, employee_id, new_image_files, removed_filenames,
    owner_user_id=_UNSET, restrict_to_owner_user_id=None,
):
    """`owner_user_id` (default _UNSET, meaning "field omitted, don't
    change it") is the NEW assignment value a Company Admin may set —
    None explicitly unassigns. `restrict_to_owner_user_id` is a
    different axis entirely: when the caller is a User (never an
    Admin), this is forced to their own id server-side, restricting
    every lookup below to a row they actually own — a User can never
    edit a person outside their own ownership, even by guessing a name
    that exists under a sibling User or the Admin's Unassigned bucket."""

    if not _is_safe_name(current_name):
        return None, "Invalid person name."

    current_folder = os.path.join(faces_folder(customer_id), current_name)

    if not os.path.isdir(current_folder):
        return None, "Person not found."

    with get_session() as session:
        query = select(RegisteredPerson).where(
            RegisteredPerson.customer_id == customer_id,
            RegisteredPerson.person_name == current_name,
        )
        query = apply_owner_scope(query, RegisteredPerson.owner_user_id, restrict_to_owner_user_id)
        existing_row = session.scalar(query)

    if existing_row is None:
        return None, "Person not found."

    new_name = (new_name or "").strip() or current_name

    error = validate_text_field(new_name, "Name", min_len=2, max_len=50)
    if error:
        return None, error

    if not _is_safe_name(new_name):
        return None, "Name contains invalid characters."

    employee_id = (employee_id or "").strip()
    error = validate_text_field(employee_id, "Employee ID", max_len=EMPLOYEE_ID_MAX, required=False)
    if error:
        return None, error

    if owner_user_id is not _UNSET:
        error = _validate_owner_user_id(customer_id, owner_user_id)
        if error:
            return None, error

    if new_name != current_name and os.path.isdir(os.path.join(faces_folder(customer_id), new_name)):
        return None, "A person with this name is already registered."

    existing_images = set(_person_image_files(current_folder))
    removed = set(removed_filenames or []) & existing_images
    kept_filenames = sorted(existing_images - removed)

    new_candidates, error, rejected_count = _score_uploaded_images(new_image_files, customer_id)
    if error:
        return None, error

    images_changed = bool(removed) or bool(new_candidates)

    if images_changed and len(kept_filenames) + len(new_candidates) < MIN_EMBEDDING_COUNT:
        if rejected_count:
            return None, (
                f"Only {len(new_candidates)} of your new images passed face-quality checks "
                f"(clear, well-lit, in-focus, single face, not heavily rotated) — {rejected_count} were rejected. "
                f"A registered person must have at least {MIN_EMBEDDING_COUNT} high-quality face images."
            )
        return None, f"A registered person must have at least {MIN_EMBEDDING_COUNT} high-quality face images."

    # A rename is just a rename — the embedding VALUES don't change. The
    # face-image folder still gets renamed on disk (images stay
    # file-based), but the embedding itself is just a row UPDATE now,
    # not a file move.
    final_name = current_name
    final_folder = current_folder

    if new_name != current_name:

        new_folder = os.path.join(faces_folder(customer_id), new_name)
        os.rename(current_folder, new_folder)
        final_name = new_name
        final_folder = new_folder

        with get_session() as session:
            row = session.get(RegisteredPerson, existing_row.id)
            row.person_name = final_name
            row.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Attendance references this person by a stable person_id, not by
        # name, so a rename needs no cascade update there anymore — kept
        # as a documented no-op call rather than removed, to leave this
        # call site unchanged.
        rename_attendance_person(customer_id, current_name, final_name)

    with get_session() as session:
        row = session.scalar(
            select(RegisteredPerson).where(
                RegisteredPerson.customer_id == customer_id,
                RegisteredPerson.person_name == final_name,
            )
        )
        row.employee_id = employee_id or None
        row.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if owner_user_id is not _UNSET:
            row.owner_user_id = owner_user_id

    if images_changed:

        # Kept files need re-detecting (once each, same single-pass
        # helper as a fresh upload) because embeddings aren't stored with
        # a per-image identity, only as one merged array for the whole
        # person — there's no cheaper way to know which stored vector
        # belonged to which possibly-removed file. Re-ranking the full
        # remaining set (kept + new) together is also what keeps
        # curation consistent: a batch of great new photos can bump out
        # an older, lower-quality kept one even if it wasn't explicitly
        # removed.
        kept_candidates = _score_files_on_disk(final_folder, kept_filenames, customer_id)
        all_candidates = kept_candidates + new_candidates

        if len(all_candidates) < MIN_EMBEDDING_COUNT:
            return None, f"A registered person must have at least {MIN_EMBEDDING_COUNT} high-quality face images."

        selected = _select_best(all_candidates)

        _write_person_folder(final_folder, selected)

        blob = _embeddings_blob(selected)
        thumbnail = selected[0]["final_filename"]

        with get_session() as session:
            row = session.scalar(
                select(RegisteredPerson).where(
                    RegisteredPerson.customer_id == customer_id,
                    RegisteredPerson.person_name == final_name,
                )
            )
            row.face_embedding = blob
            row.status = "Active"
            row.face_image_path = thumbnail
            row.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    persons, _ = get_registered_persons(customer_id)
    person = next((p for p in persons if p["name"] == final_name), None)

    return person, None


def delete_registered_person(customer_id, person_name, owner_user_id=None):
    """`owner_user_id`, when provided (a User caller, forced to their
    own id), restricts this to a person they actually own — checked
    BEFORE touching the filesystem, not just the DB row, so a User can
    never delete a sibling's/Admin's face-image folder merely by
    guessing a name that exists under this customer_id but isn't
    theirs."""

    if not person_name or "/" in person_name or "\\" in person_name or ".." in person_name:
        return False

    with get_session() as session:
        query = select(RegisteredPerson).where(
            RegisteredPerson.customer_id == customer_id,
            RegisteredPerson.person_name == person_name,
        )
        query = apply_owner_scope(query, RegisteredPerson.owner_user_id, owner_user_id)
        row = session.scalar(query)

        if row is None:
            return False

        session.delete(row)

    person_folder = os.path.join(faces_folder(customer_id), person_name)
    deleted = True

    if os.path.exists(person_folder):
        shutil.rmtree(person_folder)

    # Cascade: a deleted person must vanish from every module, not just
    # Registered Persons — Attendance.person_id also has ON DELETE CASCADE
    # at the DB level, but this explicit call stays as a defensive
    # belt-and-suspenders (and for any DB that isn't enforcing the FK).
    delete_attendance_for_person(customer_id, person_name)

    return deleted
