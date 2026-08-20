import cv2
import numpy as np

# Shipped inside the installed insightface package itself (not written for
# this app) — a weighted 0-1 composite of detector confidence, face-to-
# image size ratio, sharpness, frontal pose (from the 5-point landmarks),
# and exposure. Reused as-is for RANKING candidate images against each
# other; see rank_face_quality() below. Import-light by the library's own
# design (no GUI/Qt dependency pulled in).
from insightface.gui.core.quality import score_face as _score_face
from error_logging import log_exception

# Every check here reuses data the detector already computed (bbox,
# det_score, pose) or is a cheap pixel-level statistic (blur, brightness)
# — nothing here re-runs detection or generates a new embedding, so the
# cost added per face is negligible next to the detection/recognition
# calls that already happen.
#
# --- Face Quality Validation optimization (see debug logging below) ---
# The original values below (kept in comments for reference) were tuned
# as conservative "lab" starting points and turned out to reject a large
# share of ordinary, recognizable footage in real deployments — RTSP/
# webcam H.264 compression alone softens a face crop well past a
# Laplacian-variance floor of 60, and a person not staring straight at
# the camera routinely exceeds 35 deg yaw. These are realistic
# production values instead: loose enough to accept "reasonably clear,
# reasonably sharp, large enough" faces (the bar both Unknown Person
# Detection and Registered Person upload should apply), while still
# hard-rejecting what's genuinely unusable — near-zero detector
# confidence, a tiny crop, heavy motion blur, or a face that's mostly
# turned away. Re-tune again only against real measured footage, not
# guesswork — see the debug rejection log this module now prints.
MIN_FACE_SIZE_PX = 32      # was 40   — mirrors Settings' ai_min_face_size, still a real floor
MIN_DET_SCORE = 0.40       # was 0.55 — buffalo_l scores partially-angled/occluded real faces well under 0.55
BLUR_VARIANCE_MIN = 25.0   # was 60.0 — 60 rejected ordinary compressed-video softness, not just real blur
BRIGHTNESS_MIN = 25.0      # was 40.0 — allow dimmer indoor/night footage through
BRIGHTNESS_MAX = 235.0     # was 215.0 — allow brighter outdoor/backlit footage through
# MAX_YAW_DEGREES was raised again, from 50.0 to 70.0, after live-camera
# debug logging (Critical AI Pipeline Debug) showed this exact camera's
# real mounted angle consistently produces well-detected, sharp faces
# (det_score 0.83+, blur 150+) at 57-80 deg yaw — 100% of that camera's
# rejections, every single one, were this rule alone. A face turned to
# the side is still a real, usable detection per this task's own
# "truly unusable" list (which never included angle) — 90 deg would be
# a pure profile with no frontal information left; 70 leaves real room
# before that while no longer silently discarding this camera's entire
# traffic.
MAX_YAW_DEGREES = 70.0     # was 50.0, before that 35.0
MAX_ROLL_DEGREES = 45.0    # was 30.0 — head tilt alone rarely breaks recognition; unchanged this round, live data showed roll was never the cause of a rejection

# --- Final Production Readiness: Company AI Settings ---
# Every threshold above is now also a per-company DB column
# (customer_ai_settings, see api/ai_config.py) editable from Settings >
# AI Settings with no code deploy. The module constants above are NOT
# dead: they're what DEFAULT_AI_CONFIG seeds a brand-new company's
# row with, and the fallback used whenever no customer_id is available
# (there's no other reasonable default to fall back to). MIN_DET_SCORE
# stays a fixed constant — it was never in this task's configurable
# list, and det_score is more a "did the detector see a face at all"
# floor than an image-quality knob a Company Admin would ever want to
# retune per deployment.
def _resolve_thresholds(customer_id):

    if customer_id is None:
        return {
            "min_face_size": MIN_FACE_SIZE_PX,
            "blur_threshold": BLUR_VARIANCE_MIN,
            "brightness_min": BRIGHTNESS_MIN,
            "brightness_max": BRIGHTNESS_MAX,
            "max_yaw": MAX_YAW_DEGREES,
            "max_roll": MAX_ROLL_DEGREES,
        }

    try:
        from api.ai_config import get_ai_config
        cfg = get_ai_config(customer_id)
        return {
            "min_face_size": cfg["min_face_size"],
            "blur_threshold": cfg["blur_threshold"],
            "brightness_min": cfg["brightness_min"],
            "brightness_max": cfg["brightness_max"],
            "max_yaw": cfg["max_yaw"],
            "max_roll": cfg["max_roll"],
        }
    except Exception as e:
        log_exception(e, "AI Settings lookup for face quality")
        return _resolve_thresholds(None)


# --- Temporary debug logging (Face Quality Validation optimization) ---
# Prints every rejected face's full metric set plus the exact threshold
# it failed, so a real deployment's rejection pattern (which single rule
# is actually doing most of the rejecting) can be read straight from the
# logs instead of guessed at. Remove once the values above are confirmed
# correct against real footage.
LOG_REJECTIONS = True


def _quality_score(frame, face):
    """The same composite 0-1 heuristic rank_face_quality() uses for
    ranking (insightface.gui.core.quality.score_face) — computed here
    too, purely for the debug log below, so a rejected face's log line
    carries the same "Quality Score" a human reviewing borderline
    registration photos would see. Never used as a pass/fail gate itself
    (see module docstring / rank_face_quality) — a single opaque
    composite number can hide exactly which real thing was wrong, which
    is the opposite of what this investigation needs."""

    try:
        score, _flags = _score_face(frame, face.bbox, kps=getattr(face, "kps", None), det_score=getattr(face, "det_score", 0.0))
        return round(float(score), 4)
    except Exception as e:
        log_exception(e, "quality score computation (debug log only, non-fatal)")
        return None


def _log_rejection(frame, face, metrics, reason, thresholds=None):
    if not LOG_REJECTIONS:
        return

    t = thresholds or _resolve_thresholds(None)

    quality_score = metrics.get("quality_score")
    if quality_score is None:
        quality_score = _quality_score(frame, face)

    print("Rejected:")
    print(f"  Face Size      : {metrics.get('width', '?')}x{metrics.get('height', '?')}px (min {t['min_face_size']}px)")
    print(f"  Detection      : {metrics.get('det_score', '?')} (min {MIN_DET_SCORE})")
    print(f"  Blur Score     : {metrics.get('blur_score', '?')} (min {t['blur_threshold']})")
    print(f"  Sharpness      : {metrics.get('blur_score', '?')}  (same Laplacian-variance measurement as Blur Score)")
    print(f"  Brightness     : {metrics.get('brightness', '?')} (range {t['brightness_min']}-{t['brightness_max']})")
    print(f"  Face Angle     : yaw={metrics.get('yaw', '?')} roll={metrics.get('roll', '?')} (max yaw {t['max_yaw']}, max roll {t['max_roll']})")
    print(f"  Quality Score  : {quality_score if quality_score is not None else 'N/A'}")
    print(f"  Reason         : {reason}")


def assess_face_quality(frame, face, customer_id=None):
    """Returns (ok, reason, metrics). `reason` is "" when ok=True.
    `metrics` always has whatever was computed before any rejection, for
    debug logging — e.g. {"width":.., "det_score":.., "blur_score":..}.
    Every rejection is also printed in full (see _log_rejection) so a
    real deployment's actual rejection pattern is visible in the logs.

    `customer_id` (optional): when given, every threshold is read from
    that company's own AI Settings (api/ai_config.py) instead of this
    module's hardcoded defaults — Settings > AI Settings takes effect
    immediately, no code deploy. Omitted only by callers with no
    customer context (there currently are none in this app; kept
    optional rather than required so this function still has a sane
    standalone behavior for tests/tools)."""

    thresholds = _resolve_thresholds(customer_id)
    ok, reason, metrics = _evaluate_face_quality(frame, face, thresholds)

    if not ok:
        _log_rejection(frame, face, metrics, reason, thresholds)

    return ok, reason, metrics


def _evaluate_face_quality(frame, face, thresholds):

    metrics = {}

    x1, y1, x2, y2 = face.bbox.astype(int)
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(frame.shape[1], x2)
    y2 = min(frame.shape[0], y2)

    width = x2 - x1
    height = y2 - y1
    metrics["width"] = int(width)
    metrics["height"] = int(height)

    if width <= 0 or height <= 0:
        return False, "No visible face region.", metrics

    # ---- visibility (detector confidence) ----
    det_score = float(getattr(face, "det_score", 1.0) or 0.0)
    metrics["det_score"] = round(det_score, 3)

    if det_score < MIN_DET_SCORE:
        return False, f"Face not clearly visible (detector confidence {det_score:.2f}).", metrics

    # ---- size ----
    min_face_size = thresholds["min_face_size"]

    if width < min_face_size or height < min_face_size:
        return False, f"Face too small ({width}x{height}px, need at least {min_face_size}px).", metrics

    face_crop = frame[y1:y2, x1:x2]
    gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)

    # ---- blur ----
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    metrics["blur_score"] = round(blur_score, 1)

    if blur_score < thresholds["blur_threshold"]:
        return False, f"Face image too blurry (sharpness {blur_score:.1f}).", metrics

    # ---- brightness ----
    brightness = float(np.mean(gray))
    metrics["brightness"] = round(brightness, 1)

    if brightness < thresholds["brightness_min"]:
        return False, f"Face too dark (brightness {brightness:.0f}).", metrics

    if brightness > thresholds["brightness_max"]:
        return False, f"Face too bright/overexposed (brightness {brightness:.0f}).", metrics

    # ---- rotation / pose ----
    # buffalo_l includes a 3D landmark sub-model, so InsightFace already
    # computes face.pose ([pitch, yaw, roll], degrees) — reused here, not
    # recomputed. Guarded defensively: pose is a bonus check, not a
    # required one, so a missing/unexpected value never breaks the
    # pipeline over a single skipped check.
    try:
        pose = getattr(face, "pose", None)
        if pose is not None:
            pitch, yaw, roll = [float(v) for v in pose]
            metrics["yaw"] = round(yaw, 1)
            metrics["roll"] = round(roll, 1)

            if abs(yaw) > thresholds["max_yaw"]:
                return False, f"Face turned too far to the side (yaw {yaw:.0f} deg).", metrics

            if abs(roll) > thresholds["max_roll"]:
                return False, f"Head tilted too much (roll {roll:.0f} deg).", metrics
    except Exception as e:
        log_exception(e, "pose/angle check (non-fatal, skipped for this face)")

    return True, "", metrics


def rank_face_quality(frame, face, faces_in_image, customer_id=None):
    """Extends assess_face_quality with what's needed to SELECT the best
    N images out of a larger uploaded batch, rather than just accepting
    or rejecting each one in isolation:

    1. A "more than one face in this photo" hard-reject. A registration
       photo with a bystander in frame is bad training data for a
       single-person embedding even if the main face itself would
       otherwise pass every check — the caller passes in every face
       detect_faces() found in the image, not just the best one, so this
       can see that.
    2. A continuous 0-1 ranking SCORE for images that pass every hard
       gate, so the best N can be chosen by an actual measurement
       instead of upload order or random sampling. Reuses
       insightface.gui.core.quality.score_face — a heuristic already
       shipped inside the installed InsightFace library, not a new,
       untested formula invented for this app.

    The accept/reject boundary is otherwise IDENTICAL to
    assess_face_quality's existing thresholds — this never lets a
    borderline image pass that used to fail; it only adds a ranking on
    top of the same pass/fail decision, so registration accuracy is not
    affected by this function existing.

    Returns (passed, reason, metrics, score). score is 0.0 when
    passed=False."""

    if len(faces_in_image) > 1:
        reason = f"Multiple faces detected in image ({len(faces_in_image)})."
        _log_rejection(frame, face, {}, reason, _resolve_thresholds(customer_id))
        return False, reason, {}, 0.0

    ok, reason, metrics = assess_face_quality(frame, face, customer_id)

    if not ok:
        return False, reason, metrics, 0.0

    score, flags = _score_face(frame, face.bbox, kps=face.kps, det_score=face.det_score)
    metrics["quality_score"] = round(score, 4)

    if flags:
        metrics["quality_flags"] = flags

    return True, "", metrics, score
