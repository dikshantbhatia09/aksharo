"""Sarvam Saaras v4 — **A10 implements this**; A09 fixes the metadata.

The Hinglish / code-mix primary (`09 §1`, D12), and the only lane for the ten
languages Scribe does not cover.

Two constraints shape the adapter A10 will write, and both are recorded here so
the routing table can be trusted before the code exists:

* **Batch API only.** The REST endpoint caps at 30 s of audio and returns
  chunk-level timestamps, so every production call goes through the Batch API
  (≤ 2 h per file) with its own latency budget (`09 §1`, D14).
* **Alignment is mandatory.** Saaras returns no word timings, so a Saaras result
  is always refined by the alignment registry before it becomes an EDG word list.
"""

from __future__ import annotations

from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderCapabilities,
    TranscriptionRequest,
    TranscriptionResult,
)

__all__ = ["SarvamSaarasProvider"]


class SarvamSaarasProvider(Provider):
    """Adapter shell: capabilities and price only (A10)."""

    name = "sarvam"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe"}),
        # Chunk-level only — this False is the reason the Hinglish lane pairs the
        # provider with a forced aligner in `routing.yaml`.
        word_timestamps=False,
        diarisation=False,
        max_duration_s=2 * 60 * 60,
        batch=True,
        languages=(
            "hi-en",
            "hi",
            "ur",
            "sd",
            "kok",
            "ks",
            "sa",
            "sat",
            "mni",
            "brx",
            "mai",
            "doi",
        ),
    )

    #: ₹0.50 per media minute plus ₹0.03 for the mandatory alignment (`09 §1`).
    cost_per_minute_inr = 0.53

    model = "saaras-v4"
    #: `mode=codemix` is what makes the Hinglish lane a code-mix lane.
    default_mode = "codemix"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        raise NotImplementedError("Sarvam Saaras v4 (Batch) lands in A10")

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("Sarvam does not offer forced alignment")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("Sarvam does not offer diarisation")
