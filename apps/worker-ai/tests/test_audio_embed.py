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


def _write_temp_sine_wav() -> str:
    """One second of real, decodable 16 kHz mono PCM (a quiet sine tone),
    for the real-model test — `StubEmbedder` just hashes bytes, but
    `ClapEmbedder` decodes the file as audio and rejects a fake WAV header."""
    import math
    import struct
    import wave

    sample_rate = 16_000
    samples = [
        int(3000 * math.sin(2 * math.pi * 440 * t / sample_rate)) for t in range(sample_rate)
    ]
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        path = handle.name
    with wave.open(path, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


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
# laion_clap's HTSAT backbone calls `torch.meshgrid` without `indexing=`, which
# is a real, harmless UserWarning under the pinned torch — but the repo's
# `filterwarnings = ["error"]` turns it into an exception, which a bare
# `except:` inside laion_clap then re-raises as a misleading "model not
# found" RuntimeError. Silencing just this third-party deprecation, only in
# this test, keeps the repo-wide "warnings are errors" policy intact.
@pytest.mark.filterwarnings("ignore:torch.meshgrid:UserWarning")
def test_clap_embedder_real_model() -> None:
    model_path = os.environ.get("CLAP_MODEL_PATH", "")
    if not model_path:
        pytest.skip("CLAP_MODEL_PATH not set — no model weights on this machine (H-22)")
    embedder = ClapEmbedder(model_path)
    # Unlike `StubEmbedder` (raw bytes hashed, content irrelevant), the real
    # model decodes the file as audio — a fake WAV header with no PCM frames
    # is not decodable, so this needs one second of real, valid (silent) PCM.
    path = _write_temp_sine_wav()
    try:
        vector = embedder.embed_audio(path)
        assert len(vector) == EMBEDDING_DIMS
    finally:
        os.unlink(path)
