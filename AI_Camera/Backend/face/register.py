import os
import cv2

from face.face_detector import detect_faces
from face.embedding_generator import generate_embeddings
from face.database import reload_database

# Standalone local dev/test tool (run directly via camera/camera.py, not
# part of the Flask app) — there is no logged-in session here to derive a
# customer_id from, so it operates against a fixed placeholder customer id
# instead.
DEV_CUSTOMER_ID = 1


def create_person_folder(name):
    folder = os.path.join("dataset", "customers", str(DEV_CUSTOMER_ID), "faces", name)
    os.makedirs(folder, exist_ok=True)
    return folder


def save_face(folder, face_image, count):
    filename = os.path.join(folder, f"{count:03}.jpg")
    cv2.imwrite(filename, face_image)
    print(f"[{count}/30] Saved : {filename}")


def register_person(camera):
    print(">>> register_person() ENTERED <<<")
    name = input("\nEnter Person Name : ").strip()

    if not name:
        print("Invalid Name!")
        return

    folder = create_person_folder(name)

    print("\nLook at the Camera...")
    print("Capturing 30 Face Images...\n")

    count = 0

    while count < 30:

        success, frame = camera.read()

        if not success:
            print("Camera Error")
            break

        faces = detect_faces(frame)

        if len(faces) == 0:

            cv2.putText(
                frame,
                "No Face Detected",
                (20, 40),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 0, 255),
                2,
            )

            cv2.imshow("AI Camera", frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("\nRegistration Cancelled.")
                return

            continue

        face = max(faces, key=lambda x: x.det_score)

        x1, y1, x2, y2 = face.bbox.astype(int)

        margin = 100

        x1 = max(0, x1 - margin)
        y1 = max(0, y1 - margin)
        x2 = min(frame.shape[1], x2 + margin)
        y2 = min(frame.shape[0], y2 + margin)

        face_crop = frame[y1:y2, x1:x2]

        if face_crop.size == 0:
            continue

        save_face(folder, face_crop, count + 1)

        cv2.rectangle(
            frame,
            (x1, y1),
            (x2, y2),
            (0, 255, 0),
            2,
        )

        cv2.putText(
            frame,
            f"{count + 1}/30",
            (x1, y1 - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 255, 0),
            2,
        )

        cv2.imshow("AI Camera", frame)

        # Allow cancelling mid-capture too (previously Q only worked
        # while no face was detected).
        if cv2.waitKey(300) & 0xFF == ord("q"):
            print("\nRegistration Cancelled.")
            return

        count += 1

    if count == 0:
        print("\nNo face images captured. Registration aborted.")
        return

    # ------------------------------
    # Generate embeddings from the saved images using the same
    # pipeline used for standalone regeneration, so registration
    # never produces embeddings through a different, inconsistent
    # code path.
    # ------------------------------
    print("\nGenerating Embeddings...")
    generate_embeddings(DEV_CUSTOMER_ID, name)

    # ------------------------------
    # Reload the face database so the newly registered person is
    # recognized immediately, without restarting the app.
    # ------------------------------
    print("\nReloading Face Database...")
    reload_database(DEV_CUSTOMER_ID)

    print("\n===================================")
    print("Registration Completed Successfully")
    print("===================================")
    print(f"Person        : {name}")
    print(f"Images Saved  : {count}")
    print("===================================")
