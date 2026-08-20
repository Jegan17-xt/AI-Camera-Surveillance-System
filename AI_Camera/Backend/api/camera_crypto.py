import os

from cryptography.fernet import Fernet

from auth.database import AUTH_FOLDER

# Kept in its own file, separate from auth/secret.key (the Flask session
# signing key) — rotating/losing the session secret must never also
# make every stored camera password undecryptable, and vice versa.
CAMERA_SECRET_FILE = os.path.join(AUTH_FOLDER, "camera_secret.key")

_fernet = None


def _get_fernet():
    """Lazily loaded, persisted-to-disk Fernet key — same
    generate-once-and-reuse-forever pattern as
    auth.database.get_or_create_secret_key()."""

    global _fernet

    if _fernet is not None:
        return _fernet

    os.makedirs(AUTH_FOLDER, exist_ok=True)

    if os.path.exists(CAMERA_SECRET_FILE):
        with open(CAMERA_SECRET_FILE, "rb") as f:
            key = f.read().strip()
    else:
        key = Fernet.generate_key()
        with open(CAMERA_SECRET_FILE, "wb") as f:
            f.write(key)

    _fernet = Fernet(key)

    return _fernet


def encrypt_password(plain_password):
    return _get_fernet().encrypt(plain_password.encode("utf-8")).decode("utf-8")


def decrypt_password(encrypted_password):
    return _get_fernet().decrypt(encrypted_password.encode("utf-8")).decode("utf-8")