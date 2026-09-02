"""ElevenLabs Forced Alignment — **A10 implements this**.

Rung 4 of the `09 §2` chain: the paid fallback, used when a self-hosted CTC head
cannot serve the language and the proportional fallback would miss the onset
target. It is the only rung with a per-minute price, so routing reaches it last.
"""

from __future__ import annotations

from worker_ai.alignment.base import Aligner
from worker_ai.providers.base import AlignmentRequest, Word
from worker_ai.vad import SpeechRegion

__all__ = ["ElevenLabsForcedAligner"]


class ElevenLabsForcedAligner(Aligner):
    """Aligner shell: identity and price (A10)."""

    name = "elevenlabs-fa"
    rank = 40
    languages = ()

    model = "eleven-forced-alignment-v1"
    #: ₹0.03 per media minute alongside a Saaras transcript (`09 §1`).
    cost_per_minute_inr = 0.03

    def available(self) -> str | None:
        return "the ElevenLabs Forced Alignment adapter lands in A10"

    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        raise NotImplementedError("ElevenLabs Forced Alignment lands in A10")
