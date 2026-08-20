import os
from datetime import datetime

import cv2
import numpy as np
from sqlalchemy import select

from face.face_detector import get_app
from face.quality import assess_face_quality
from face.embedding_codec import encode_embeddings
from db import get_session
from auth.models import RegisteredPerson


def generate_embeddings(customer_id, person_name):
    """Reads every image in this person's faces/ folder, computes a
    quality-gated embedding per image, and writes the stacked (N,512)
    array into that person's RegisteredPerson.face_embedding blob —
    get-or-create by (customer_id, person_name), so this works whether
    the caller already created the row (api/registered.py's web upload
    flow) or not (face/register.py's standalone CLI tool)."""

    folder = os.path.join("dataset", "customers", str(customer_id), "faces", person_name)

    if not os.path.exists(folder):
        print("Person folder not found.")
        return

    embeddings = []

    image_files = sorted([
        file for file in os.listdir(folder)
        if file.lower().endswith((".jpg", ".jpeg", ".png"))
    ])

    print(f"\nProcessing {len(image_files)} Images...\n")

    for file in image_files:

        image_path = os.path.join(folder, file)

        image = cv2.imread(image_path)

        if image is None:
            print(f"Cannot Read : {file}")
            continue

        # Try original image
        detection_image = image
        faces = get_app().get(image)

        # Retry with larger image if face not detected
        if len(faces) == 0:
            image_large = cv2.resize(image, (1120, 1120))
            faces = get_app().get(image_large)
            if faces:
                detection_image = image_large

        # Retry again with medium size
        if len(faces) == 0:
            image_medium = cv2.resize(image, (800, 800))
            faces = get_app().get(image_medium)
            if faces:
                detection_image = image_medium

        if len(faces) == 0:
            print(f"Face Not Detected : {file}")
            continue

        best_face = max(faces, key=lambda x: x.det_score)

        # Authoritative quality gate — runs regardless of entry point
        # (web upload, which pre-filters via api/registered.py, or the
        # standalone CLI tool, which doesn't), so a poor-quality
        # embedding can never end up saved either way.
        ok, reason, metrics = assess_face_quality(detection_image, best_face)

        if not ok:
            print(f"Skipped (low quality) : {file} - {reason}")
            continue

        embeddings.append(best_face.embedding.astype(np.float32))

        print(f"Embedding Generated : {file} (det_score={metrics.get('det_score')})")

    if len(embeddings) == 0:
        print("\nNo embeddings generated.")
        return

    embeddings = np.array(embeddings, dtype=np.float32)
    blob = encode_embeddings(embeddings)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with get_session() as session:

        row = session.scalar(
            select(RegisteredPerson).where(
                RegisteredPerson.customer_id == customer_id,
                RegisteredPerson.person_name == person_name,
            )
        )

        if row is None:
            row = RegisteredPerson(
                customer_id=customer_id,
                admin_id=customer_id,
                person_name=person_name,
                status="Active",
                created_at=now,
                updated_at=now,
            )
            session.add(row)

        row.face_embedding = blob
        row.status = "Active"
        row.updated_at = now

        if image_files:
            row.face_image_path = image_files[0]

    print("\n==============================")
    print("Embedding Generation Completed")
    print("==============================")
    print("Person :", person_name)
    print("Embeddings :", len(embeddings))
