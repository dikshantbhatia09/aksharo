"""CLAP audio embeddings behind the `Embedder` protocol (D04a, H-22).

The frozen LAION CLAP checkpoint (Apache-2.0) is a model weight: never
committed, provisioned by an env path (`CLAP_MODEL_PATH`), and absent on this
machine. `ClapEmbedder` loads it lazily — importing this module never touches
`laion_clap` or the filesystem — so every test that does not ask for the real
model runs against `StubEmbedder`, a deterministic, dependency-free stand-in
with the same 512-dim output shape. Tests that do exercise `ClapEmbedder`
against a real checkpoint are marked `slow` and skip when `CLAP_MODEL_PATH`
is unset (`tests/test_audio_embed.py`).
"""

from __future__ import annotations

import hashlib
import math
from typing import Protocol, runtime_checkable

__all__ = [
    "EMBEDDING_DIMS",
    "ClapEmbedder",
    "ClapModelUnavailableError",
    "Embedder",
    "StubEmbedder",
    "embed_text_stub",
]

EMBEDDING_DIMS = 512


@runtime_checkable
class Embedder(Protocol):
    """CLAP-shaped embedder: audio (and, for stub-mode text queries, text) to
    a 512-dim vector. `ingest-audio-pack.ts` and `worker_ai.passes.sfx` both
    code against this shape, never against a concrete model."""

    def embed_audio(self, file_path: str) -> list[float]: ...

    def embed_text(self, text: str) -> list[float]: ...


def _stub_vector(seed_bytes: bytes) -> list[float]:
    """SHA-256-derived, L2-normalised 512-dim vector: deterministic in the
    seed bytes, so identical audio (or identical text) always embeds
    identically, and retrieval ranking is reproducible without a real model."""
    base = hashlib.sha256(seed_bytes).digest()
    raw: list[float] = []
    for i in range(EMBEDDING_DIMS):
        block = hashlib.sha256(base + i.to_bytes(2, "big")).digest()
        value = int.from_bytes(block[:4], "big") / 0xFFFFFFFF
        raw.append(value * 2 - 1)
    norm = math.sqrt(sum(v * v for v in raw)) or 1.0
    return [v / norm for v in raw]


def embed_text_stub(text: str) -> list[float]:
    """Module-level helper so callers that only need a text query (the SFX
    pass's cue → text query step) don't have to construct a `StubEmbedder`."""
    return _stub_vector(text.strip().lower().encode("utf-8"))


class StubEmbedder:
    """Deterministic `Embedder`: reads the file's bytes (audio) or the raw
    string (text) and hashes them into a unit vector. No model, no I/O beyond
    the read itself, safe to instantiate anywhere including CI."""

    def embed_audio(self, file_path: str) -> list[float]:
        with open(file_path, "rb") as handle:
            data = handle.read()
        return _stub_vector(data)

    def embed_text(self, text: str) -> list[float]:
        return embed_text_stub(text)


class ClapModelUnavailableError(RuntimeError):
    """Raised when `ClapEmbedder` is used but `CLAP_MODEL_PATH` is unset or the
    `laion_clap` package (or its weights) cannot be loaded."""


class ClapEmbedder:
    """The real embedder: LAION CLAP, loaded lazily from `CLAP_MODEL_PATH`.

    Not importable-safe by accident: constructing this class does the load,
    so a caller that never constructs it never pays the import cost, and a
    test that does construct it earns the `slow` marker honestly.
    """

    def __init__(self, model_path: str) -> None:
        if not model_path:
            raise ClapModelUnavailableError("CLAP_MODEL_PATH is not set")
        try:
            # Codes differ by machine: import-not-found when the optional
            # local-clap extra isn't installed, import-untyped when it is
            # (laion_clap ships no py.typed marker) — a bare ignore covers
            # both without going unused in either environment.
            import laion_clap  # type: ignore
        except ImportError as error:
            raise ClapModelUnavailableError(
                "laion_clap is not installed on this machine"
            ) from error

        self._model = laion_clap.CLAP_Module(enable_fusion=False)
        # `laion_clap.load_ckpt` calls `torch.load` with its default
        # `weights_only`. Torch >= 2.6 defaults that to True, which rejects the
        # numpy scalar globals pickled into LAION's published checkpoints —
        # not a laion_clap bug, a torch default that changed after those
        # checkpoints were published. `model_path` is never attacker-supplied
        # (it is `CLAP_MODEL_PATH`, an operator-provisioned local file whose
        # SHA-256 is pinned in docs/models/LOCAL-MODELS.md — H-22), so
        # trusting its pickle for the scope of this one load is the same
        # trust decision `weights_only=False` documents, applied narrowly.
        import torch

        original_load = torch.load
        torch.load = lambda *args, **kwargs: original_load(
            *args, **{**kwargs, "weights_only": False}
        )
        try:
            self._model.load_ckpt(model_path)
        finally:
            torch.load = original_load

    def embed_audio(self, file_path: str) -> list[float]:
        embedding = self._model.get_audio_embedding_from_filelist(
            x=[file_path], use_tensor=False
        )
        return list(embedding[0])

    def embed_text(self, text: str) -> list[float]:
        embedding = self._model.get_text_embedding([text], use_tensor=False)
        return list(embedding[0])
