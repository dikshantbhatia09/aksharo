#!/usr/bin/env python3
"""Download and export every weight into the image, at build time only.

Replaces X05's ``infra/gpu/runpod/bake_models.py``, which baked one aligner named
by a placeholder and lived outside the app it bakes for. It is here instead so the
Dockerfile's build context is ``apps/model-server`` — the brief's build command —
and so one script serves both providers: ``infra/gpu/modal/app.py`` runs this same
file (Modal builds from the repository root).

Nothing here executes at inference time. The server loads from the local cache
with ``HF_HUB_OFFLINE=1``, and failing loudly here is the point: a missing weight
must break the build, not become a 40-second surprise download on the first
production request.

## What gets baked

* **ASR and LID** - ``faster-whisper large-v3-turbo`` (CTranslate2), MIT.
* **Alignment, Indic** - ``ai4bharat/indicwav2vec-*``, MIT.
* **Alignment, global** - ``jonatasgrosman/wav2vec2-large-xlsr-53-*``, Apache-2.0.
* **Diarisation** - ``pyannote/speaker-diarization-community-1``, CC-BY-4.0.

**MMS is absent and must stay absent** (decision D77):
``facebook/mms-300m-1130-forced-aligner`` is CC-BY-NC-4.0. :func:`_refuse_mms`
fails the build if any argument names it, so the licence decision cannot be undone
by a passing ``--build-arg``.

## Why the aligners are exported to ONNX

The server runs the CTC heads through onnxruntime, in the layout
``apps/worker-ai/worker_ai/alignment/ctc.py`` also reads:

```
<align-dir>/<family>/<language>/model.onnx
<align-dir>/<family>/<language>/vocab.json
<align-dir>/<family>/<language>/config.json
```

``transformers`` and ``torch`` are needed for the export and not for inference, so
the conversion happens here, once, and the runtime never imports either for
alignment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, NoReturn

CACHE_ROOT = Path(os.environ.get("HF_HOME", "/models/hf"))

#: Decision D77. Anything matching this is refused, whatever it is passed as.
FORBIDDEN_SUBSTRINGS = ("mms-300m", "mms-1b", "/mms")


def _die(message: str) -> NoReturn:
    print("bake_models: " + message, file=sys.stderr)
    raise SystemExit(1)


def _refuse_mms(*models: str) -> None:
    """D77: the CC-BY-NC-4.0 MMS export never ships, not even by build argument."""
    for model in models:
        lowered = model.casefold()
        if any(marker in lowered for marker in FORBIDDEN_SUBSTRINGS):
            _die(
                model + " is a Meta MMS checkpoint. The widely distributed export is "
                "CC-BY-NC-4.0, which is non-commercial; decision D77 removes it from "
                "the alignment ladder. Use an IndicWav2Vec (MIT) or XLSR-53 "
                "(Apache-2.0) checkpoint."
            )


def bake_whisper(model: str) -> None:
    """faster-whisper keeps its CTranslate2 weights in the same HF cache."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:  # pragma: no cover - build-time only
        _die("faster-whisper is not installed; check requirements-gpu.lock")

    print("bake_models: fetching whisper " + model)
    # Instantiating on CPU is enough to populate the cache; there is no GPU
    # inside a Docker build.
    WhisperModel(model, device="cpu", compute_type="int8", download_root=str(CACHE_ROOT))


def export_aligner(model: str, *, family: str, language: str, align_dir: Path) -> None:
    """Export one wav2vec2 CTC head to ONNX, with its vocabulary beside it."""
    try:
        import torch
        from transformers import AutoModelForCTC, AutoProcessor
    except ImportError:  # pragma: no cover - build-time only
        _die("transformers and torch are needed for the aligner export")

    print("bake_models: exporting " + family + "/" + language + " from " + model)
    processor = AutoProcessor.from_pretrained(model, cache_dir=str(CACHE_ROOT))
    head = AutoModelForCTC.from_pretrained(model, cache_dir=str(CACHE_ROOT))
    head.eval()

    target = align_dir / family / language
    target.mkdir(parents=True, exist_ok=True)

    # One second of 16 kHz silence is enough to trace the graph; the exported
    # model takes a dynamic-length axis so a real chunk of any length runs.
    example = torch.zeros(1, 16_000, dtype=torch.float32)
    torch.onnx.export(
        head,
        (example,),
        str(target / "model.onnx"),
        input_names=["input_values"],
        output_names=["logits"],
        dynamic_axes={"input_values": {1: "samples"}, "logits": {1: "frames"}},
        opset_version=17,
    )

    vocabulary: dict[str, int] = _vocabulary(processor)
    (target / "vocab.json").write_text(json.dumps(vocabulary, ensure_ascii=False), encoding="utf-8")
    # 16 kHz wav2vec2 has a 320-sample stride; stated rather than assumed, because
    # the server reads it and a checkpoint with a different stride would drift.
    (target / "config.json").write_text(
        json.dumps({"frameMs": 20, "source": model}), encoding="utf-8"
    )


def _vocabulary(processor: Any) -> dict[str, int]:
    """The tokenizer's character vocabulary, in the shape the server reads."""
    tokenizer = getattr(processor, "tokenizer", processor)
    raw = tokenizer.get_vocab()
    if not isinstance(raw, dict) or not raw:  # pragma: no cover - build-time only
        _die("the processor for this checkpoint exposed no vocabulary")
    return {str(key): int(value) for key, value in raw.items()}


def bake_diariser(model: str, token: str | None) -> None:
    """pyannote community-1: gated, CC-BY-4.0, attribution surfaced by the server."""
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

    print("bake_models: fetching diariser " + model)
    pipeline = Pipeline.from_pretrained(model, use_auth_token=token)
    if pipeline is None:
        _die(
            model + " returned no pipeline. The usual cause is an unaccepted licence on "
            "the Hugging Face model page."
        )
    print(
        "bake_models: " + model + " is CC-BY-4.0; the server surfaces the "
        "attribution in engineVersions on every diarised job (D77)."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Bake model weights into the image.")
    parser.add_argument("--whisper", required=True)
    parser.add_argument("--aligner-indic", required=True)
    parser.add_argument("--aligner-global", required=True)
    parser.add_argument("--diariser", required=True)
    parser.add_argument("--align-dir", default="/models/align")
    parser.add_argument(
        "--indic-language",
        default="hi",
        help="Language directory for the Indic head; one head per language (D77).",
    )
    parser.add_argument("--global-language", default="en")
    args = parser.parse_args()

    _refuse_mms(args.aligner_indic, args.aligner_global)

    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    align_dir = Path(args.align_dir)
    align_dir.mkdir(parents=True, exist_ok=True)

    token = os.environ.get("HF_TOKEN") or None

    bake_whisper(args.whisper)
    export_aligner(
        args.aligner_indic,
        family="indicwav2vec",
        language=args.indic_language,
        align_dir=align_dir,
    )
    export_aligner(
        args.aligner_global,
        family="xlsr53",
        language=args.global_language,
        align_dir=align_dir,
    )
    bake_diariser(args.diariser, token)

    for root in (CACHE_ROOT, align_dir):
        total = sum(item.stat().st_size for item in root.rglob("*") if item.is_file())
        print("bake_models: " + str(root) + " holds " + format(total / 1e9, ".2f") + " GB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
