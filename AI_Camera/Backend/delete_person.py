import os
import shutil


FACES_FOLDER = "dataset/faces"
EMBEDDINGS_FOLDER = "dataset/embeddings"


def delete_person(person_name):

    face_folder = os.path.join(
        FACES_FOLDER,
        person_name
    )

    embedding_file = os.path.join(
        EMBEDDINGS_FOLDER,
        f"{person_name}.npy"
    )

    deleted = False

    # Delete face folder
    if os.path.exists(face_folder):
        shutil.rmtree(face_folder)
        print(f"Deleted Folder : {face_folder}")
        deleted = True

    # Delete embedding
    if os.path.exists(embedding_file):
        os.remove(embedding_file)
        print(f"Deleted Embedding : {embedding_file}")
        deleted = True

    if deleted:
        print(f"\n{person_name} deleted successfully.")
    else:
        print(f"\nPerson not found.")


if __name__ == "__main__":

    name = input("Enter Person Name : ").strip()

    delete_person(name)