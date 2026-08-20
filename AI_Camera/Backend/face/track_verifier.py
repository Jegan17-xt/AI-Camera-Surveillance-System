import threading
import time
from collections import deque

import numpy as np

# Lightweight multi-frame consensus — no tracking-model dependency. A
# face barely moves between consecutive frames at video framerate, so a
# simple bounding-box IoU match is enough to associate this frame's
# detection with the same physical face seen in recent frames, without
# pulling in a real tracker (DeepSORT/ByteTrack etc.) that would add a
# real performance/dependency cost for no accuracy benefit here.
#
# Tracks are keyed by "tracking key" — normally a camera_id (each camera
# is a physically distinct view, so its tracks must never mix with
# another camera's), falling back to a customer-scoped key only for the
# one caller that has no camera_id (the standalone CLI script).

# Was 2.0, then 5.0, then 12.0 — each raised after live evidence showed
# real processing-cycle gaps exceeding the previous ceiling, silently
# resetting consensus before it could reach CONFIRM_MIN_AGREEMENT (the
# exact "name shown on screen, attendance never recorded" symptom this
# constant has caused twice before). Registered-Person Attendance
# Investigation: reproduced a THIRD time, now with an RTSP camera
# (heavier per-frame cost: larger source resolution, more faces per
# frame, decode competing with the AI thread for the same CPU) running
# alongside the earlier webcam scenario. Live [CONSENSUS] logs for the
# SAME correctly-recognized person, same session: one track needed 9.5s
# and then another 11.3s between consecutive votes — both individual
# gaps already within a hair of the old 12.0s ceiling — while a sibling
# track never got a second vote at all before being pruned, so
# "sometimes confirms, sometimes doesn't" was not a fluke, it was this
# ceiling being right at the edge of real measured gaps. 30.0 gives
# real headroom over the worst individual inter-vote gap actually
# measured (11.3s) — comfortably above it without making a track linger
# absurdly long after a person genuinely leaves frame.
TRACK_TIMEOUT_SECONDS = 30.0        # drop a track unmatched for this long

# --- Critical Production Fix: "Pending — awaiting multi-frame
# consensus" that never resolved ---
# Root cause: _find_match only ever accepted a strict bounding-box IoU
# match. PROCESSING_FPS_CAP (camera/detection_service.py) intentionally
# only runs AI on 1 frame every ~200ms — by design, to leave CPU
# headroom — so consecutive PROCESSED frames of a person who is walking,
# or just turning their head, can easily shift enough that IoU drops
# under 0.3 even though it is obviously still the same face. Every time
# that happened, _find_match found no track, update_track silently
# started a BRAND NEW one, and "attempts"/"votes" reset to zero — so a
# real, repeatedly-matching face could vote "Jegan" 20 times in a row
# and still never reach CONFIRM_MIN_AGREEMENT, because no single track
# ever accumulated more than one vote. This was the actual root cause of
# "recognition never completes" — not the vote count, not the timeout.
# Fixed with a fallback: also accept a match when the box CENTER moved
# only a modest fraction of the face's own size and the face is roughly
# the same size as before — normal head/walking motion between two
# ~200ms-apart samples, while still correctly rejecting an unrelated
# face (or a same-size face that jumped across the frame) that just
# happens to be nearby.
IOU_MATCH_THRESHOLD = 0.3          # min overlap to call two boxes "the same face" (primary test)
CENTER_DISTANCE_TOLERANCE = 0.6    # fallback: center may drift up to this fraction of the box diagonal
MIN_SIZE_RATIO = 0.5               # fallback: box area must stay within 2x of what it was

# --- Critical Bug Fix: Track IDs still churning (track21 -> track22 ->
# track24), consensus still never reaching 3/3 ---
# Live logs showed the geometric fallback above STILL failing on almost
# every single processed frame for a real moving person — "new track"
# printed dozens of times in a row instead of "matched existing track".
# Root cause: PROCESSING_FPS_CAP is a ceiling, not a guarantee — actual
# AI inference in this environment costs ~1-2+ seconds per cycle, so two
# CONSECUTIVE PROCESSED frames of a walking person are genuinely 1-2+
# real seconds apart, not ~200ms. Over that real gap, a person can move
# far enough across a 2560x1440 frame that BOTH the IoU test and the
# geometric center-distance/size-ratio fallback legitimately fail — this
# was never a bug in the geometry checks themselves, it's that pure
# geometry cannot bridge a multi-second gap for a moving subject.
#
# Fixed with a third signal that doesn't depend on position at all:
# face IDENTITY. detect_faces() already computes an embedding for every
# face in the same pass that produces its bbox — comparing THAT against
# each track's last-seen embedding (cosine similarity) answers "is this
# plausibly the same physical face" directly, completely independent of
# how far it moved on screen. 0.40 is deliberately looser than
# recognition_threshold (a DIFFERENT question — "is this the same face
# I was just tracking a moment ago" is a much lower bar than "is this a
# specific registered person"), while still far above what two different
# people's faces score against each other in practice.
EMBEDDING_MATCH_THRESHOLD = 0.40

# Verified against the example in the fix request (3 consecutive
# matching frames -> Confirmed): CONFIRM_WINDOW=5, CONFIRM_MIN_AGREEMENT
# =3 already implements EXACTLY "3 stable frames -> confirmed" — that
# was never the wrong number; tracks just never survived long enough to
# reach it (see above). Left unchanged.
CONFIRM_WINDOW = 5                 # how many recent attempts we remember per track
CONFIRM_MIN_AGREEMENT = 3          # votes needed among the window to confirm a name
UNKNOWN_CONFIRM_MIN_ATTEMPTS = 3   # attempts needed, with zero name agreement, to confirm Unknown

_lock = threading.Lock()
_tracks = {}  # tracking_key -> list of track dicts
_next_track_id = 1  # module-global, unique across every camera/customer — simplest to reason about in logs


def drop_tracks(tracking_key):
    """Releases this camera's active multi-frame consensus tracks — call
    this when a camera is genuinely DELETED, same "never on disable/
    restart" rule as detection/detector.py's drop_model(). Safe to call
    for a tracking_key with no tracks (no-op)."""

    with _lock:
        _tracks.pop(tracking_key, None)


def _iou(box_a, box_b):
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)

    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h

    if inter_area == 0:
        return 0.0

    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter_area

    return inter_area / union if union > 0 else 0.0


def _prune_stale(tracks, now):
    return [t for t in tracks if now - t["last_seen"] <= TRACK_TIMEOUT_SECONDS]


def _center_and_diagonal(box):
    x1, y1, x2, y2 = box
    center = ((x1 + x2) / 2.0, (y1 + y2) / 2.0)
    diagonal = max(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5, 1.0)
    area = max(0, x2 - x1) * max(0, y2 - y1)
    return center, diagonal, area


def _cosine_similarity(a, b):
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / denom) if denom > 0 else 0.0


def _match_score(box_a, box_b, embedding_a=None, embedding_b=None):
    """Returns (matched, rank_score) — rank_score lets _find_match pick
    the BEST candidate when several tracks could plausibly match (rare,
    but matters once embedding similarity is in play), not just the
    first one encountered. IoU is the primary test, the geometric
    fallback handles modest movement, and embedding similarity (see
    module docstring) handles a real multi-second gap where the subject
    moved far enough that geometry alone can no longer bridge it."""

    iou = _iou(box_a, box_b)

    if iou >= IOU_MATCH_THRESHOLD:
        return True, iou

    center_a, diag_a, area_a = _center_and_diagonal(box_a)
    center_b, diag_b, area_b = _center_and_diagonal(box_b)

    distance = ((center_a[0] - center_b[0]) ** 2 + (center_a[1] - center_b[1]) ** 2) ** 0.5
    size_ratio = min(area_a, area_b) / max(area_a, area_b, 1.0)
    geometric_ok = distance <= max(diag_a, diag_b) * CENTER_DISTANCE_TOLERANCE and size_ratio >= MIN_SIZE_RATIO

    similarity = 0.0
    if embedding_a is not None and embedding_b is not None:
        similarity = _cosine_similarity(embedding_a, embedding_b)

    if geometric_ok or similarity >= EMBEDDING_MATCH_THRESHOLD:
        return True, max(iou, similarity)

    return False, max(iou, similarity)


def _find_match(tracks, bbox, embedding=None):
    best_track = None
    best_score = -1.0

    for track in tracks:
        matched, score = _match_score(track["bbox"], bbox, track.get("embedding"), embedding)
        if matched and score > best_score:
            best_score = score
            best_track = track

    return best_track


def _new_track(bbox, now, embedding=None):
    global _next_track_id

    track = {
        "track_id": _next_track_id,
        "bbox": bbox,
        "embedding": embedding,     # most recent embedding seen for this track — used to bridge large position deltas
        "created_at": now,          # Track lifetime = now - created_at
        "last_seen": now,
        "votes": deque(maxlen=CONFIRM_WINDOW),
        "attempts": 0,
        "status": "pending",        # pending | confirmed | unknown_confirmed
        "confirmed_name": None,
        "last_score": 0.0,
        "attendance_marked": False,
        "unknown_saved": False,
    }
    _next_track_id += 1
    return track


def peek_track(tracking_key, bbox, embedding=None):
    """Read-only lookup — does NOT create, mutate, vote on, or prune any
    track. Lets a caller (camera/frame_processor.py) check "have I
    already confirmed who this physical face is" BEFORE paying for a
    fresh recognize() comparison — "do not repeatedly recognize the same
    face" from a track that's already settled. Returns the matching
    track dict, or None if this bbox doesn't currently match anything
    tracked for this key (a genuinely new face, or nothing being
    tracked at all)."""

    now = time.time()

    with _lock:
        tracks = _tracks.get(tracking_key, [])
        tracks = [t for t in tracks if now - t["last_seen"] <= TRACK_TIMEOUT_SECONDS]
        return _find_match(tracks, bbox, embedding)


def update_track(tracking_key, bbox, name, score, embedding=None):
    """Call once per detected face per frame. Returns:
      ("confirmed", name)          — this identity is verified across
                                      multiple recent frames; safe to
                                      mark attendance.
      ("unknown_confirmed", None)  — repeated attempts, no name ever
                                      agreed on; safe to save as Unknown.
      ("pending", None)            — still gathering evidence; do not
                                      commit either way yet.

    `embedding` (optional): this frame's face embedding, used ONLY for
    track continuity (see EMBEDDING_MATCH_THRESHOLD) — never compared
    against the registered-persons database here, that's recognize()'s
    job. Omitting it just falls back to geometry-only matching.
    """

    now = time.time()

    with _lock:

        tracks = _tracks.setdefault(tracking_key, [])
        tracks[:] = _prune_stale(tracks, now)

        track = _find_match(tracks, bbox, embedding)

        is_new_track = track is None

        if track is None:
            track = _new_track(bbox, now, embedding)
            tracks.append(track)

        track["bbox"] = bbox
        if embedding is not None:
            track["embedding"] = embedding
        track["last_seen"] = now
        track["last_score"] = score
        track["attempts"] += 1
        track["votes"].append(name)

        counts = {}
        for vote in track["votes"]:
            if vote != "Unknown":
                counts[vote] = counts.get(vote, 0) + 1

        best_candidate = None
        best_count = 0

        for candidate_name, count in counts.items():
            if count > best_count:
                best_candidate = candidate_name
                best_count = count

        track_label = "new track" if is_new_track else "matched existing track"
        print(
            f"[CONSENSUS] track#{track['track_id']} ({tracking_key}): {track_label}, attempt {track['attempts']}, "
            f"lifetime={now - track['created_at']:.1f}s, vote={name!r}, "
            f"progress={best_count}/{CONFIRM_MIN_AGREEMENT} for {best_candidate or 'no candidate yet'}"
        )

        if best_candidate is not None and best_count >= CONFIRM_MIN_AGREEMENT:
            track["status"] = "confirmed"
            track["confirmed_name"] = best_candidate
            print(f"[CONSENSUS] track#{track['track_id']}: CONFIRMED -> {best_candidate}")
            return "confirmed", best_candidate

        if track["attempts"] >= UNKNOWN_CONFIRM_MIN_ATTEMPTS and best_count == 0:
            track["status"] = "unknown_confirmed"
            print(f"[CONSENSUS] track#{track['track_id']}: UNKNOWN CONFIRMED (no agreement after {track['attempts']} attempts)")
            return "unknown_confirmed", None

        return "pending", None
