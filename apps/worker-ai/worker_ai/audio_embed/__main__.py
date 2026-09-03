"""`python -m worker_ai.audio_embed <file_path>` — prints `{"embedding": [...]}`
as one line of JSON on stdout. `ingest-audio-pack.ts`'s `ClapSubprocessEmbedder`
shells out to exactly this (H-22: ingestion is an offline CLI, not a queued
job, so this is a subprocess call rather than a BullMQ round trip).

Uses `ClapEmbedder` when `CLAP_MODEL_PATH` is set, otherwise `StubEmbedder` —
the same fallback `ingest-audio-pack.ts` documents on its own TS-side default.
"""

from __future__ import annotations

import json
import os
import sys

from worker_ai.audio_embed import ClapEmbedder, Embedder, StubEmbedder


def _build_embedder() -> Embedder:
    model_path = os.environ.get("CLAP_MODEL_PATH", "")
    if model_path:
        return ClapEmbedder(model_path)
    return StubEmbedder()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m worker_ai.audio_embed <file_path>", file=sys.stderr)
        return 1
    file_path = argv[1]
    embedder = _build_embedder()
    embedding = embedder.embed_audio(file_path)
    print(json.dumps({"embedding": embedding}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
