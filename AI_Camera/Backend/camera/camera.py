import cv2
import platform
import time

from face.register import register_person
from camera.frame_processor import process_frame

# Standalone local dev/test tool (run directly, not part of the Flask
# app) — there is no logged-in session here to derive a customer_id from,
# so it operates against a fixed placeholder customer id instead.
DEV_CUSTOMER_ID = 1


def start_camera():

    if platform.system() == "Windows":
        camera = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    else:
        camera = cv2.VideoCapture(0)

    if not camera.isOpened():
        print("Camera not found")
        return

    prev_time = time.time()

    while True:

        success, frame = camera.read()

        if not success:
            break

        # Existing YOLO + InsightFace + recognition + attendance +
        # unknown-detection pipeline — unchanged, now shared with the
        # Flask MJPEG stream via camera/frame_processor.py instead of
        # being duplicated here.
        annotated_frame = process_frame(frame, DEV_CUSTOMER_ID)

        # ---------------- FPS ----------------
        current_time = time.time()
        fps = 1 / max(current_time - prev_time, 0.001)
        prev_time = current_time

        cv2.putText(
            annotated_frame,
            f"FPS : {int(fps)}",
            (10, 60),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 255),
            2
        )

        cv2.putText(
            annotated_frame,
            "R = Register    Q = Quit",
            (10, 90),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (255, 255, 0),
            2
        )

        cv2.imshow("AI Camera", annotated_frame)

        key = cv2.waitKey(1) & 0xFF

        if key == ord("r"):

            cv2.destroyAllWindows()
            register_person(camera)

        elif key == ord("q"):

            break

    camera.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    start_camera()