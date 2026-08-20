from camera.camera import start_camera

def main():
    print("=" * 50)
    print("      AI CAMERA SURVEILLANCE SYSTEM")
    print("=" * 50)
    print("Loading Camera...")
    print("Press R -> Register Face")
    print("Press Q -> Quit")
    print("=" * 50)

    start_camera()

if __name__ == "__main__":
    main()