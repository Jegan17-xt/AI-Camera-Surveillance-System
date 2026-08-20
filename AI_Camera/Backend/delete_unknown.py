import os
import shutil

UNKNOWN_FOLDER = "dataset/unknown"
UNKNOWN_EMBEDDING_FOLDER = "dataset/unknown_embeddings"
UNKNOWN_LOG = "dataset/unknown_log.csv"


def delete_unknown():

    # Delete Unknown Images
    if os.path.exists(UNKNOWN_FOLDER):
        shutil.rmtree(UNKNOWN_FOLDER)
        print("Unknown Images Deleted")

    # Delete Unknown Embeddings
    if os.path.exists(UNKNOWN_EMBEDDING_FOLDER):
        shutil.rmtree(UNKNOWN_EMBEDDING_FOLDER)
        print("Unknown Embeddings Deleted")

    # Delete Log File
    if os.path.exists(UNKNOWN_LOG):
        os.remove(UNKNOWN_LOG)
        print("Unknown Log Deleted")

    # Create Empty Folders Again
    os.makedirs(UNKNOWN_FOLDER, exist_ok=True)
    os.makedirs(UNKNOWN_EMBEDDING_FOLDER, exist_ok=True)

    print("\nUnknown Database Reset Successfully.")


if __name__ == "__main__":
    delete_unknown()