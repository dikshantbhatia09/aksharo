"""ElevenLabs Scribe v2 — **A10 implements this**; A09 fixes the metadata.

Primary lane for pure Hindi, Indian English and 12 Indic languages (`09 §1`,
D12): word timestamps and diarisation are included in the price, which is why it
is the only primary that needs no separate alignment pass.

Commercial terms that A10 must honour when it fills the body in
(`09 §8 Provider contract terms`): the **India endpoint** with **zero retention**,
unqualified no-training, and a certificate of deletion. Until those are wired,
every method raises so a misconfigured routing table fails loudly rather than
quietly sending audio to a default region.
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

__all__ = ["ElevenLabsScribeProvider"]


class ElevenLabsScribeProvider(Provider):
    """Adapter shell: capabilities and price only (A10)."""

    name = "elevenlabs"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe", "align", "diarise"}),
        word_timestamps=True,
        diarisation=True,
        max_duration_s=None,
        batch=False,
        languages=(
            "hi",
            "en-IN",
            "ta",
            "te",
            "kn",
            "ml",
            "bn",
            "mr",
            "gu",
            "or",
            "ne",
            "as",
            "pa",
        ),
    )

    #: ₹0.35 per media minute, word timestamps and diarisation included (`05 §12`).
    cost_per_minute_inr = 0.35

    #: The separate Forced Alignment product, priced per `09 §2`; A10 splits it out.
    alignment_model = "eleven-forced-alignment-v1"
    model = "scribe-v2"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        raise NotImplementedError("ElevenLabs Scribe v2 lands in A10")

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("ElevenLabs Forced Alignment lands in A10")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("ElevenLabs diarisation lands in A10")
