"""`worker_ai.audio_embed` — the deterministic stub embedder (D04a).

`ClapEmbedder` itself needs the real, uncommitted LAION checkpoint (H-22) and
is exercised only by the `slow`-marked test at the bottom, which skips when
`CLAP_MODEL_PATH` is unset — exactly as this machine has it.
"""

from __future__ import annotations

import os
import tempfile

import pytest

from worker_ai.audio_embed import (
    EMBEDDING_DIMS,
    ClapEmbedder,
    ClapModelUnavailableError,
    StubEmbedder,
    embed_text_stub,
)


def _write_temp_wav(data: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        handle.write(data)
        return handle.name


def test_stub_embedder_is_512_dimensional() -> None:
    embedder = StubEmbedder()
    path = _write_temp_wav(b"some fixture audio bytes")
    try:
        vector = embedder.embed_audio(path)
        assert len(vector) == EMBEDDING_DIMS
    finally:
        os.unlink(path)


def test_stub_embedder_is_unit_normalised() -> None:
    embedder = StubEmbedder()
    path = _write_temp_wav(b"another fixture")
    try:
        vector = embedder.embed_audio(path)
        norm = sum(v * v for v in vector) ** 0.5
        assert abs(norm - 1.0) < 1e-6
    finally:
        os.unlink(path)


def test_stub_embedder_is_deterministic() -> None:
    embedder = StubEmbedder()
    path = _write_temp_wav(b"deterministic bytes")
    try:
        first = embedder.embed_audio(path)
        second = embedder.embed_audio(path)
        assert first == second
    finally:
        os.unlink(path)


def test_stub_embedder_distinguishes_different_audio() -> None:
    embedder = StubEmbedder()
    path_a = _write_temp_wav(b"audio A")
    path_b = _write_temp_wav(b"audio B, quite different content")
    try:
        vector_a = embedder.embed_audio(path_a)
        vector_b = embedder.embed_audio(path_b)
        assert vector_a != vector_b
        # Cosine similarity of two unrelated random-ish vectors should be
        # nowhere near 1 (identical) — a loose bound, not an exact one.
        dot = sum(a * b for a, b in zip(vector_a, vector_b, strict=True))
        assert dot < 0.9
    finally:
        os.unlink(path_a)
        os.unlink(path_b)


def test_embed_text_stub_is_deterministic_and_case_insensitive() -> None:
    assert embed_text_stub("Whoosh Transition") == embed_text_stub("whoosh transition")
    assert embed_text_stub("whoosh") != embed_text_stub("boom")


def test_clap_embedder_raises_without_model_path() -> None:
    with pytest.raises(ClapModelUnavailableError):
        ClapEmbedder("")


@pytest.mark.slow
def test_clap_embedder_real_model() -> None:
    model_path = os.environ.get("CLAP_MODEL_PATH", "")
    if not model_path:
        pytest.skip("CLAP_MODEL_PATH not set — no model weights on this machine (H-22)")
    embedder = ClapEmbedder(model_path)
    path = _write_temp_wav(b"RIFF....WAVEfmt ")
    try:
        vector = embedder.embed_audio(path)
        assert len(vector) == EMBEDDING_DIMS
    finally:
        os.unlink(path)
