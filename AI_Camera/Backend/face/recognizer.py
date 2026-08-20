import numpy as np

from face.database import get_database
from error_logging import log_exception

# --- Critical Recognition Investigation (previous) ---
# Live logs showed EVERY low-confidence ("Person: Jegan, Confidence:
# 0.11") failure came from a face at 65-84 deg yaw (near profile) — this
# camera's actual physical mounting angle. Directly verified this is not
# a storage/encoding/model bug: every one of Jegan's 10 stored images,
# re-embedded fresh from disk, matched its own stored vector at exactly
# 1.0000 cosine similarity, and cross-similarity between his own
# (frontal-ish) photos ranged a healthy 0.62-0.94. A frontal live capture
# of the same person separately scored 0.89. ArcFace-family embeddings
# (this app uses buffalo_l/w600k_r50) are trained on frontal-to-moderate
# poses; at near-profile angles the embedding genuinely stops encoding
# reliable identity information — 0.11 is a CORRECT measurement of a
# fundamentally poor input, not corruption. That investigation added a
# SEPARATE, stricter yaw gate here (60 deg) than face/quality.py's own
# general gate (70 deg at the time).
#
# --- Final Production Readiness: Company AI Settings ---
# That split into two independently-hardcoded yaw ceilings was itself a
# real defect — a Company Admin retuning "Maximum Yaw" in Settings >
# AI Settings would only have moved the one in face/quality.py, silently
# leaving recognition governed by a DIFFERENT, still-hardcoded number.
# Consolidated to ONE configurable value (max_yaw, same DB column
# face/quality.py's assess_face_quality() already enforces upstream, in
# camera/frame_processor.py, before recognize() is ever called) —
# defaulted to 60 deg, this investigation's own measured safe ceiling,
# not quality.py's looser 70. recognize() no longer duplicates the pose
# check at all: by the time a face reaches here it has already passed
# the SAME gate, from the SAME setting.
#
# THRESHOLD/MARGIN are likewise no longer hardcoded — both now come from
# this company's own AI Settings (recognition_threshold; margin stays a
# fixed 0.05 internal implementation detail, not in this task's
# configurable list) — see _resolve_settings() below.
DEFAULT_THRESHOLD = 0.50
MARGIN = 0.05

# Per person, average their TOP_K best-matching stored embeddings rather
# than either a single best embedding (noisy) or every embedding
# (drags a good match down by dissimilar-pose shots) — unchanged from
# the original design, just named for clarity.
TOP_K = 5


def _resolve_threshold(customer_id):

    if customer_id is None:
        return DEFAULT_THRESHOLD

    try:
        from api.ai_config import get_ai_config
        return get_ai_config(customer_id)["recognition_threshold"]
    except Exception as e:
        log_exception(e, "AI Settings lookup for recognition threshold")
        return DEFAULT_THRESHOLD


def cosine_similarity(a, b):
    return np.dot(a, b) / (
        np.linalg.norm(a) * np.linalg.norm(b)
    )


def recognize(face, customer_id):

    threshold = _resolve_threshold(customer_id)

    database = get_database(customer_id)

    total_vectors = sum(len(v) for v in database.values())
    print(f"[RECOGNIZE] Registered embeddings loaded: {len(database)} person(s), {total_vectors} total vector(s)")

    if len(database) == 0:
        print("[RECOGNIZE] Recognition cache empty for this customer -> Unknown")
        return "Unknown", 0.0

    # Use embedding directly from detected face — already computed by
    # InsightFace from a landmark-aligned crop, nothing to regenerate.
    live_embedding = face.embedding.astype(np.float32)
    print(f"[RECOGNIZE] Embedding dimension: {live_embedding.shape[0]}")

    # --- CPU Optimization: vectorized per-person scoring ---
    # Previously this called cosine_similarity() once per stored
    # embedding, in a plain Python loop — recomputing np.linalg.norm()
    # for BOTH vectors from scratch on every single call, even though the
    # live embedding's norm never changes across the whole loop and each
    # stored embedding's norm never changes between frames. For a person
    # with N stored embeddings, that's N individual Python-level function
    # calls where one batched (N, 512) @ (512,) matrix-vector product
    # does the exact same math in a single NumPy call. The per-person
    # top-K-average selection logic below is completely unchanged — same
    # TOP_K, same averaging, same accepted/rejected outcome for any given
    # input; only how the raw per-embedding similarity numbers are
    # computed changed.
    live_norm = float(np.linalg.norm(live_embedding))
    live_norm = live_norm if live_norm > 0 else 1e-8

    best_name = "Unknown"
    best_score = -1.0
    second_best_score = -1.0
    person_scores = []  # (person_name, avg_score) for every candidate, for debug logging

    for person_name, embeddings in database.items():

        person_matrix = np.asarray(embeddings, dtype=np.float32)  # (N, 512)

        if person_matrix.size == 0:
            continue

        person_norms = np.linalg.norm(person_matrix, axis=1)
        person_norms[person_norms == 0] = 1e-8

        # Same formula cosine_similarity(live_embedding, embedding) computed
        # per row before — one dot-product-per-row call instead of N.
        scores = (person_matrix @ live_embedding) / (person_norms * live_norm)

        # np.sort ascending, take the top TOP_K from the end, reverse to
        # descending — identical selection to sorted(scores, reverse=True)[:TOP_K].
        top_scores = np.sort(scores)[::-1][:TOP_K]

        avg_score = float(np.mean(top_scores))
        person_scores.append((person_name, avg_score))

        if avg_score > best_score:
            second_best_score = best_score
            best_score = avg_score
            best_name = person_name
        elif avg_score > second_best_score:
            second_best_score = avg_score

    margin_ok = second_best_score < 0 or (best_score - second_best_score) >= MARGIN

    person_scores.sort(key=lambda p: p[1], reverse=True)

    print("--------------------------------")
    print("Similarity scores with Top 5 matches:")
    for name, score in person_scores[:5]:
        print(f"    {name}: {round(score, 4)}")
    print("Recognition threshold:", threshold)
    print("Person :", best_name)
    print("Confidence :", round(best_score, 2))
    if second_best_score >= 0:
        print("Runner-up margin :", round(best_score - second_best_score, 3))

    accepted = best_score >= threshold and margin_ok
    print("Chosen match :", best_name if accepted else "Unknown")
    print("--------------------------------")

    if accepted:
        return best_name, float(best_score)

    return "Unknown", float(best_score)
