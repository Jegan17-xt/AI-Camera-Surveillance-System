import os
import re

from auth.database import get_user_by_id, set_user_avatar
from api.validators import validate_image_upload

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AVATAR_FOLDER = os.path.join(BASE_DIR, "dataset", "avatars")

ALLOWED_AVATAR_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024  # 5MB


def _remove_file(avatar_path):

    if not avatar_path:
        return

    path = os.path.join(AVATAR_FOLDER, avatar_path)

    if not os.path.exists(path):
        return

    try:
        os.remove(path)
    except OSError:
        # Best-effort: e.g. still momentarily held open by whatever last
        # served it (observed on Windows). Not fatal — the new avatar is
        # what matters, and a leftover old file is harmless.
        pass


def save_avatar(user_id, file):
    """Validates and saves a new profile photo, replacing any previous
    one for this user. Returns (avatar_path, error)."""

    if file is None or not file.filename:
        return None, "No file was provided."

    ext = os.path.splitext(file.filename)[1].lower()

    if ext not in ALLOWED_AVATAR_EXTENSIONS:
        return None, "Only JPG, PNG, and WEBP images are supported."

    file_bytes = file.stream.read()
    file.stream.seek(0)

    # Content-sniffed (attempts a real image decode), not just a
    # filename-extension check — a renamed non-image file is rejected
    # here even though its extension looks fine.
    error = validate_image_upload(file_bytes, ALLOWED_AVATAR_EXTENSIONS, MAX_AVATAR_SIZE_BYTES, label="Image")
    if error:
        return None, error

    os.makedirs(AVATAR_FOLDER, exist_ok=True)

    user = get_user_by_id(user_id)
    old_path = user.get("avatar_path") if user else None

    new_filename = f"user_{user_id}{ext}"

    # A changed extension (e.g. png -> jpg) would otherwise leave the old
    # file behind forever alongside the new one.
    if old_path and old_path != new_filename:
        _remove_file(old_path)

    file.save(os.path.join(AVATAR_FOLDER, new_filename))

    set_user_avatar(user_id, new_filename)

    return new_filename, None


_AVATAR_FILENAME_RE = re.compile(r"^user_(\d+)\.[A-Za-z0-9]+$")


def get_avatar_owner(filename):
    """Resolves which account a requested avatar filename actually
    belongs to, verified against that user's own stored avatar_path —
    not just parsed from the name — so a guessed or stale filename can
    never match. Returns the owning user dict, or None if `filename`
    isn't any current account's avatar. Used by the /account/avatar/
    <filename> route to gate access instead of serving any file in
    AVATAR_FOLDER to any logged-in caller."""

    match = _AVATAR_FILENAME_RE.match(filename or "")

    if not match:
        return None

    user = get_user_by_id(int(match.group(1)))

    if user is None or user.get("avatar_path") != filename:
        return None

    return user


def remove_avatar(user_id):

    user = get_user_by_id(user_id)
    old_path = user.get("avatar_path") if user else None

    if not old_path:
        return False

    _remove_file(old_path)
    set_user_avatar(user_id, None)

    return True
