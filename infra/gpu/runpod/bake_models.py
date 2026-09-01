#!/usr/bin/env python3
"""Download the ASR, alignment and diarisation weights into the image.

Run at Docker build time only (see Dockerfile). Nothing here executes at
inference time; the model server loads from the local cache with
``HF_HUB_OFFLINE=1``.

Failing loudly here is the point: a missing weight must break the build, not
turn into a 40-second surprise download on the first production request.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("HF_HOME", "/models/hf"))


def _die(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"bake_models: {message}", file=sys.stderr)
    raise SystemExit(1)


def bake_whisper(model: str) -> None:
    """faster-whisper keeps CTranslate2 weights in the same HF cache."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:  # pragma: no cover - build-time only
        _die("faster-whisper is not installed; check requirements-gpu.lock")

    print(f"bake_models: fetching whisper {model}")
    # Instantiating on CPU is enough to populate the cache; the GPU is not
    # available inside a Docker build.
    WhisperModel(model, device="cpu", compute_type="int8", download_root=str(CACHE_ROOT))


def bake_aligner(model: str) -> None:
    try:
        from transformers import AutoModelForCTC, AutoProcessor
    except ImportError:  # pragma: no cover - build-time only
        _die("transformers is not installed; check requirements-gpu.lock")

    print(f"bake_models: fetching aligner {model}")
    AutoProcessor.from_pretrained(model, cache_dir=str(CACHE_ROOT))
    AutoModelForCTC.from_pretrained(model, cache_dir=str(CACHE_ROOT))


def bake_diariser(model: str, token: str | None) -> None:
    if not token:
        _die(
            "pyannote community-1 is a gated repository: pass the Hugging Face "
            "token as a BuildKit secret (--secret id=hf_token,src=...). "
            "The token is never stored in a layer."
        )

    try:
        from pyannote.audio import Pipeline
    except ImportError:  # pragma: no cover - build-time only
        _die("pyannote.audio is not installed; check requirements-gpu.lock")

    print(f"bake_models: fetching diariser {model}")
    pipeline = Pipeline.from_pretrained(model, use_auth_token=token)
    if pipeline is None:
        _die(
            f"{model} returned no pipeline. The usual cause is an unaccepted "
            "licence on the Hugging Face model page."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--whisper", required=True)
    parser.add_argument("--aligner", required=True)
    parser.add_argument("--diariser", required=True)
    args = parser.parse_args()

    CACHE_ROOT.mkdir(parents=True, exist_ok=True)

    token = os.environ.get("HF_TOKEN") or None

    bake_whisper(args.whisper)
    bake_aligner(args.aligner)
    bake_diariser(args.diariser, token)

    total = sum(f.stat().st_size for f in CACHE_ROOT.rglob("*") if f.is_file())
    print(f"bake_models: cache is {total / 1e9:.2f} GB at {CACHE_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
