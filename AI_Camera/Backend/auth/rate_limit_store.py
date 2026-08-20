"""Pluggable rate-limit storage (Phase 2: multi-process rate limiting).

Everything in auth/rate_limit.py — login/camera-test throttling and the
generic `rate_limited` decorator — reads and writes counters through one
of these instead of talking to a module-level dict directly. A bare
in-memory dict is scoped to ONE process: behind Gunicorn with N worker
processes (or N separate EC2 instances), each worker keeps its own
independent counters, so the real effective limit becomes N times the
configured one — the exact gap this module closes for anyone who
configures Redis, while changing nothing for anyone who doesn't.

Backend selection happens once, at import time, from REDIS_URL:
  - unset -> InMemoryStore. Identical behavior to the pre-Phase-2 code —
    correct and sufficient for today's single-process `python main.py`
    deployment, and the default for local development.
  - set   -> RedisStore, after a fail-fast PING at import time. If Redis
    is configured but unreachable, this falls back to InMemoryStore with
    a loud startup warning rather than crashing the app over a rate-limit
    backend — a rate limiter failing open to "single-process limits" is
    far safer than the app failing to start at all.

`redis` is imported lazily, only when REDIS_URL is actually set, so it
stays an OPTIONAL dependency — nothing here requires installing it for a
single-process/single-instance deployment (see requirements.txt).
"""

import os
import threading
import time
import uuid


class RateLimitStore:
    """Two independent primitives, matching exactly what auth/rate_limit.py
    needs: a sliding-window hit counter, and a simple "locked until"
    marker with its own TTL (a lockout is a distinct, longer-lived state
    from the rolling failure count that triggers it — see
    auth/rate_limit.py's own docstring)."""

    def increment(self, key, window_seconds):
        """Record one occurrence of `key` now; return the count of
        occurrences still inside the trailing window_seconds."""
        raise NotImplementedError

    def count(self, key, window_seconds):
        """Same as increment(), but doesn't record anything — a read-only
        peek at today's count."""
        raise NotImplementedError

    def reset_hits(self, key):
        """Clear the recorded occurrences for `key` (does NOT clear an
        active lock — see set_lock/clear_lock)."""
        raise NotImplementedError

    def set_lock(self, key, seconds):
        """Mark `key` locked for the next `seconds`."""
        raise NotImplementedError

    def get_lock_remaining(self, key):
        """Seconds remaining if `key` is currently locked, else None."""
        raise NotImplementedError

    def clear_lock(self, key):
        """Clear an active lock on `key`, if any."""
        raise NotImplementedError

    def reset(self, key):
        """Clear both the hit counter and any active lock for `key` —
        e.g. after a successful login wipes out prior failed attempts."""
        self.reset_hits(key)
        self.clear_lock(key)


class InMemoryStore(RateLimitStore):
    """Single-process, thread-safe sliding window — the same
    {key: [timestamps]} dict-behind-a-lock design auth/rate_limit.py used
    before this file existed, just extracted so it can sit behind the
    same interface as RedisStore."""

    def __init__(self):
        self._lock = threading.Lock()
        self._hits = {}
        self._locks = {}  # key -> unix time the lock expires

    @staticmethod
    def _prune(timestamps, window_seconds, now):
        return [t for t in timestamps if now - t < window_seconds]

    def increment(self, key, window_seconds):
        now = time.time()
        with self._lock:
            timestamps = self._prune(self._hits.get(key, []), window_seconds, now)
            timestamps.append(now)
            self._hits[key] = timestamps
            return len(timestamps)

    def count(self, key, window_seconds):
        now = time.time()
        with self._lock:
            timestamps = self._prune(self._hits.get(key, []), window_seconds, now)
            self._hits[key] = timestamps
            return len(timestamps)

    def reset_hits(self, key):
        with self._lock:
            self._hits.pop(key, None)

    def set_lock(self, key, seconds):
        with self._lock:
            self._locks[key] = time.time() + seconds

    def get_lock_remaining(self, key):
        now = time.time()
        with self._lock:
            until = self._locks.get(key)
            if until and now < until:
                return until - now
            if until:
                self._locks.pop(key, None)
            return None

    def clear_lock(self, key):
        with self._lock:
            self._locks.pop(key, None)


class RedisStore(RateLimitStore):
    """Multi-process sliding window via a Redis sorted set per key (score
    = timestamp, member = a unique token so repeat hits in the same
    millisecond never collide/overwrite each other) — ZREMRANGEBYSCORE to
    expire old entries, ZADD, ZCARD, all in one pipeline so concurrent
    workers/instances never race on the same key. Every process pointed
    at the same Redis instance shares one true count. Locks are a plain
    SETEX key (TTL = the lock duration; TTL itself IS the "remaining
    seconds" — no separate value to read)."""

    def __init__(self, client):
        self._client = client

    @staticmethod
    def _hits_key(key):
        return f"ratelimit:hits:{key}"

    @staticmethod
    def _lock_key(key):
        return f"ratelimit:lock:{key}"

    def increment(self, key, window_seconds):
        now = time.time()
        redis_key = self._hits_key(key)
        member = f"{now}:{uuid.uuid4().hex}"

        pipe = self._client.pipeline()
        pipe.zremrangebyscore(redis_key, 0, now - window_seconds)
        pipe.zadd(redis_key, {member: now})
        pipe.zcard(redis_key)
        pipe.expire(redis_key, int(window_seconds) + 1)
        _, _, count, _ = pipe.execute()
        return count

    def count(self, key, window_seconds):
        now = time.time()
        redis_key = self._hits_key(key)

        pipe = self._client.pipeline()
        pipe.zremrangebyscore(redis_key, 0, now - window_seconds)
        pipe.zcard(redis_key)
        _, count = pipe.execute()
        return count

    def reset_hits(self, key):
        self._client.delete(self._hits_key(key))

    def set_lock(self, key, seconds):
        self._client.setex(self._lock_key(key), int(seconds) + 1, "1")

    def get_lock_remaining(self, key):
        ttl = self._client.ttl(self._lock_key(key))
        # redis-py TTL: -2 = key doesn't exist, -1 = exists with no expiry
        # (never set by this class, but treated as "not locked" defensively).
        if ttl is None or ttl < 0:
            return None
        return float(ttl)

    def clear_lock(self, key):
        self._client.delete(self._lock_key(key))


def _build_store():
    redis_url = os.environ.get("REDIS_URL", "").strip()

    if not redis_url:
        return InMemoryStore()

    try:
        import redis as redis_lib

        client = redis_lib.from_url(
            redis_url, socket_connect_timeout=2, socket_timeout=2, decode_responses=True
        )
        client.ping()
        print("[rate_limit] Using Redis-backed rate limiting (multi-process safe).")
        return RedisStore(client)
    except Exception as exc:
        print(
            f"[rate_limit] WARNING: REDIS_URL is set but Redis is unreachable "
            f"({type(exc).__name__}) -- falling back to in-memory rate limiting. "
            "This is UNSAFE across multiple worker processes/instances (each gets "
            "its own independent limit) -- fix Redis connectivity before running "
            "this behind multiple Gunicorn workers or multiple instances."
        )
        return InMemoryStore()


store = _build_store()
