"""Shared numpy<->bytes codec for storing InsightFace embeddings in MySQL
LargeBinary (BLOB) columns — raw float32 bytes, never pickle (this app's
storage layer explicitly avoids pickle for application data). InsightFace/
ArcFace embeddings are fixed at 512 dimensions; a vector count for a
multi-embedding blob is derived from byte length, not stored separately."""

import numpy as np

EMBEDDING_DIM = 512


def encode_embeddings(array):
    """(N, 512) or (512,) float32 ndarray -> bytes, for a LargeBinary column."""

    return np.asarray(array, dtype=np.float32).tobytes()


def decode_embeddings(blob):
    """bytes -> (N, 512) float32 ndarray. N is derived from len(blob) —
    no separate count column needed. Empty/None blob -> a (0, 512) array,
    matching "no embeddings yet" rather than raising."""

    if not blob:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    return np.frombuffer(blob, dtype=np.float32).reshape(-1, EMBEDDING_DIM)


def decode_single_embedding(blob):
    """bytes -> (512,) float32 ndarray, or None. For a single-vector
    column (e.g. one unknown-person detection's embedding)."""

    if not blob:
        return None

    return np.frombuffer(blob, dtype=np.float32).reshape(EMBEDDING_DIM)
