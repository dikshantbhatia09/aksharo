"""Meta MMS multilingual CTC alignment — **A10 implements this**.

Rung 3 of the `09 §2` chain: the breadth option. MMS covers far more languages
than IndicWav2Vec, at lower accuracy, and it needs a romanisation step for
non-Latin scripts — which is exactly why it sits *below* the Indic heads and
*above* the proportional fallback.
"""

from __future__ import annotations

from worker_ai.alignment.base import Aligner
from worker_ai.providers.base import AlignmentRequest, Word
from worker_ai.vad import SpeechRegion

__all__ = ["MmsAligner"]


class MmsAligner(Aligner):
    """Aligner shell: identity and coverage (A10)."""

    name = "mms-ctc"
    rank = 30
    languages = ()  # multilingual by design

    model = "facebook/mms-300m-1130-forced-aligner"
    licence = "CC-BY-NC-4.0 checkpoints; A10 confirms the commercial variant"

    def available(self) -> str | None:
        return "the Meta MMS aligner lands in A10"

    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        raise NotImplementedError("MMS alignment lands in A10")
