"""Per-customer lock registry — the ONLY thing this module does.

Why this exists as its own module rather than living in
camera/detection_service.py (where it originally did): attendance.py's
mark_attendance() and face/unknown_manager.py's save_unknown() both do a
check-then-write against MySQL with no locking of their own, which is
only safe when each customer's writes are serialized across their
cameras. Previously that serialization was done by holding one big lock
around the ENTIRE process_frame() call (YOLO detection + InsightFace
recognition + these writes) in detection_service.py's processor loop —
which meant two cameras belonging to the same customer could never run
AI inference at the same time, even though inference itself has no
shared-state race at all; only the final DB write does.

Narrowing the lock to wrap only the actual check-then-write section
(inside mark_attendance/save_unknown themselves) requires those modules
to reach the SAME per-customer lock instances detection_service.py's
processor loop used to hold — but attendance.py and face/unknown_
manager.py are both imported (transitively, via camera/frame_processor.
py) BY camera/detection_service.py, so importing the lock registry back
out of detection_service.py would be a circular import. This module has
no dependents of its own (only the stdlib), so every caller can import
it with no cycle."""

import threading

_customer_processing_locks = {}
_customer_locks_guard = threading.Lock()


def get_customer_lock(customer_id):
    """One threading.Lock per customer, created on first use and reused
    for the lifetime of the process — the real serialization boundary
    between two cameras belonging to the same customer writing
    attendance/unknown-person rows at the same instant."""

    with _customer_locks_guard:
        lock = _customer_processing_locks.get(customer_id)
        if lock is None:
            lock = threading.Lock()
            _customer_processing_locks[customer_id] = lock
        return lock
