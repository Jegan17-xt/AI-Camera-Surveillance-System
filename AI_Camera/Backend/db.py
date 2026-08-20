import os
from contextlib import contextmanager

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import sessionmaker, declarative_base

# Load Backend/.env by an ABSOLUTE path derived from this file's own
# location — NOT dotenv's default CWD-relative search. dotenv's
# find_dotenv() only walks *upward* from the current working directory;
# it never looks into subdirectories. So launching the app from any CWD
# other than Backend/ itself (a different terminal, a VS Code launch
# config with cwd=workspace-root plus PYTHONPATH=.../Backend, etc.)
# makes the lookup silently fail, every DB_* var falls back to its
# hardcoded default (DB_PASSWORD defaults to ""), and MySQL then
# correctly reports "Access denied ... (using password: NO)" — it's not
# a wrong password, it's truthfully an EMPTY one. Anchoring to
# __file__ makes the lookup independent of CWD entirely.
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(dotenv_path=_ENV_PATH)

# Phase 2 — sensitive log sanitization: verbose startup diagnostics below
# (including anything DB-connection-related) only print in local dev
# (FLASK_DEBUG on), never by default in production.
_verbose_db_startup_log = os.environ.get("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes")


def _mask(value, keep_ends=True):
    """For logging only — never log a secret in full. e.g. 'Sw0rd@Fish!' -> 'S*********!'."""

    if not value:
        return value

    if not keep_ends or len(value) <= 2:
        return "*" * len(value)

    return value[0] + "*" * (len(value) - 2) + value[-1]


def _mask_url(url_obj):
    """user:password@host/db -> user:S*********!@host/db, for safe logging.
    Reads the ALREADY-PARSED components off the URL object instead of
    splitting the string by hand — a raw password containing '@' or ':'
    (e.g. "Sw0rd@Fish!") breaks naive string splitting, since both plain
    Python and a first pass of URL parsing look for the FIRST '@', not
    the one that actually separates credentials from host. The URL
    object already resolved that correctly."""

    port_part = f":{url_obj.port}" if url_obj.port else ""
    db_part = f"/{url_obj.database}" if url_obj.database else ""

    return f"{url_obj.drivername}://{url_obj.username}:{_mask(url_obj.password)}@{url_obj.host}{port_part}{db_part}"


def _build_database_url():
    """DATABASE_URL, if set, wins outright (e.g. a managed MySQL
    provider's full connection string) — and silently overrides every
    individual DB_* piece below, which is worth flagging loudly since
    it's a common source of "I edited DB_PASSWORD but nothing changed"
    confusion. Otherwise the URL is assembled from the individual DB_*
    pieces via URL.create(), NOT an f-string: raw string interpolation
    (f"...://{user}:{password}@{host}...") breaks the instant a
    credential contains '@', ':', or '/' — e.g. a password like
    "Sw0rd@Fish!" — because both the resulting string and SQLAlchemy's
    own parser split on the first '@' they see, mistaking part of the
    password for the start of the host. URL.create
    builds the DSN from already-separated fields, so no such characters
    are ever mis-parsed, and create_engine() accepts a URL object
    directly."""

    raw_override = os.environ.get("DATABASE_URL")

    if raw_override:
        url_obj = make_url(raw_override)
        if _verbose_db_startup_log:
            print("[db.py] DATABASE_URL env var is SET — it overrides DB_HOST/DB_USER/DB_PASSWORD/etc entirely.")
            print(f"[db.py] DATABASE_URL = {_mask_url(url_obj)}")
        return url_obj

    host = os.environ.get("DB_HOST", "localhost")
    port = os.environ.get("DB_PORT", "3306")
    user = os.environ.get("DB_USER", "root")
    password = os.environ.get("DB_PASSWORD", "")
    name = os.environ.get("DB_NAME", "ai_sentinel")

    return URL.create(
        drivername="mysql+pymysql",
        username=user,
        password=password,
        host=host,
        port=int(port),
        database=name,
    )


# Security fix (Phase 2 — sensitive log sanitization): this used to print
# _mask(DB_PASSWORD) — e.g. "S*********!" — directly at every startup.
# That reveals the real first/last character AND exact length of a live
# database credential to anyone who can read the process's stdout/log
# file, which meaningfully cuts the search space for a brute-force guess.
# A masked-but-partial value is not the same thing as "never logged" (see
# the Phase 2 requirement) — only whether it's configured at all is ever
# useful for startup diagnostics, so that's all this prints now. The rest
# of this verbose block is also gated behind FLASK_DEBUG (local dev
# diagnostics only) rather than always printing in every environment,
# production included.
if _verbose_db_startup_log:
    print(f"[db.py] .env path   : {_ENV_PATH}")
    print(f"[db.py] .env exists : {os.path.isfile(_ENV_PATH)}")
    print(f"[db.py] DB_HOST     = {os.environ.get('DB_HOST')!r}")
    print(f"[db.py] DB_PORT     = {os.environ.get('DB_PORT')!r}")
    print(f"[db.py] DB_USER     = {os.environ.get('DB_USER')!r}")
    print(f"[db.py] DB_PASSWORD = {'SET' if os.environ.get('DB_PASSWORD') else 'NOT SET'}")
    print(f"[db.py] DB_NAME     = {os.environ.get('DB_NAME')!r}")

DATABASE_URL = _build_database_url()  # always a sqlalchemy.engine.URL object, both branches

if _verbose_db_startup_log:
    print(f"[db.py] Final DATABASE_URL = {_mask_url(DATABASE_URL)}")

# pool_pre_ping guards against MySQL silently dropping idle connections
# (wait_timeout) — without it, the first query after a period of
# inactivity would raise instead of transparently reconnecting.
#
# pool_size/max_overflow/pool_timeout: this one engine/pool is shared by
# EVERY Flask request thread (app.run(threaded=True) — unbounded
# thread-per-connection) AND every camera worker's own processor thread
# (one per enabled camera, running continuously). Left at SQLAlchemy's
# default (5 + 10 overflow = 15 total), a handful of active cameras plus
# a few concurrent dashboard/report requests can exhaust the pool —
# every caller past the 15th blocks for up to pool_timeout (default 30s)
# then raises "QueuePool limit exceeded". 20 + 20 = 40 max connections
# comfortably covers that load while staying well under this MySQL
# instance's own max_connections (confirmed live: 151) — leaving ~110
# connections of headroom for anything else (admin tools, a second
# environment, etc.) sharing the same server. pool_timeout is lowered
# from the 30s default to 10s so a genuinely exhausted pool fails fast
# with a clear error instead of a request silently hanging for half a
# minute.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=3600,
    pool_size=20,
    max_overflow=20,
    pool_timeout=10,
)

# expire_on_commit=False: existing call sites build and return a dict
# from a row right after committing — with the default (True), every
# attribute access after commit() would trigger a fresh SELECT.
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

Base = declarative_base()


@contextmanager
def get_session():
    """with get_session() as session: ... — commits on a clean exit,
    rolls back and re-raises on any exception, always closes."""

    session = SessionLocal()

    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
