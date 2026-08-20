import threading

from sqlalchemy import select

from db import get_session
from auth.models import RegisteredPerson
from face.embedding_codec import decode_embeddings


def load_database(customer_id):
    """Reads every registered person's embedding blob for this customer
    from MySQL and returns {person_name: (N,512) float32 ndarray}. A
    person with no embedding yet (status "Incomplete") is excluded, same
    as before when their .npy file simply didn't exist."""

    database = {}

    with get_session() as session:
        rows = session.scalars(
            select(RegisteredPerson).where(RegisteredPerson.customer_id == customer_id)
        ).all()

        for row in rows:

            if not row.face_embedding:
                continue

            embeddings = decode_embeddings(row.face_embedding)
            database[row.person_name] = embeddings

            print(f"Loaded : {row.person_name} ({len(embeddings)} embeddings)")

    print(f"\nDatabase Loaded Successfully ({len(database)} Person(s))")

    return database


# ===============================
# In-memory cache
# ===============================
# Querying MySQL for every recognized face/frame is expensive. We cache
# each customer's database in memory (keyed by customer_id — a single
# shared cache would let one customer's recognized faces leak into
# another customer's live-camera matching) and only reload a given
# customer's entry when explicitly asked to (e.g. right after that
# customer registers a new person).
_database_cache = {}  # customer_id -> {person_name: embeddings}

# Multiple per-camera capture threads for the same customer (see
# camera/stream.py) can call get_database() around the same moment a
# registration request on the Flask thread calls reload_database() for
# that same customer_id — without this lock, that's an unguarded
# check-then-write race on a plain dict that could hand back a stale or
# partially-reloaded database right after a new registration (a "just
# registered but shows Unknown" symptom).
_cache_lock = threading.Lock()


def reload_database(customer_id):
    """Force a fresh read from MySQL and refresh the in-memory cache for
    this customer only. Call this right after registering a new person
    so recognition picks up the new face without needing to restart the
    app."""

    database = load_database(customer_id)

    with _cache_lock:
        _database_cache[customer_id] = database

    return database


def get_database(customer_id):
    """Return this customer's cached database, loading it from MySQL the
    first time it's needed. Use this instead of load_database() in hot
    paths — this is the only function the per-frame recognition loop
    (face/recognizer.py) calls, and it must never do MySQL I/O itself."""

    with _cache_lock:
        if customer_id in _database_cache:
            return _database_cache[customer_id]

    # load_database() does DB I/O — deliberately done outside the lock
    # so one customer's (possibly slow, first-ever) load never blocks
    # another customer's concurrent cache read.
    database = load_database(customer_id)

    with _cache_lock:
        _database_cache.setdefault(customer_id, database)
        return _database_cache[customer_id]
