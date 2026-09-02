"""AssemblyAI Universal-2 — **A10 implements this**; A09 fixes the metadata.

The global fallback and a candidate primary for Indian English (`09 §1`, D12) at
₹0.24 per media minute, which is the cheapest vendor lane on the board.
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

__all__ = ["AssemblyAiProvider"]


class AssemblyAiProvider(Provider):
    """Adapter shell: capabilities and price only (A10)."""

    name = "assemblyai"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe", "diarise"}),
        word_timestamps=True,
        diarisation=True,
        max_duration_s=None,
        batch=True,
        languages=("en", "en-IN"),
    )

    #: ₹0.24 per media minute (`05 §12`).
    cost_per_minute_inr = 0.24

    model = "universal-2"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        raise NotImplementedError("AssemblyAI Universal-2 lands in A10")

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("AssemblyAI does not offer standalone alignment")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("AssemblyAI diarisation lands in A10")
