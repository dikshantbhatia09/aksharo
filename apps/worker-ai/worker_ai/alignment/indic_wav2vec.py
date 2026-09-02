"""AI4Bharat IndicWav2Vec CTC alignment — **A10 implements this**.

Rung 2 of the `09 §2` chain and the one that matters most for the product: the
CTC heads cover roughly eleven Indic languages under an MIT licence, so they are
the cheapest way to reach the ≤ 80 ms Indic onset target behind Sarvam, which
returns no word timings at all.

Roman-script Hinglish aligns on a Devanagari/phonetic projection rather than on
the Roman string (`09 §2`), so A10's implementation needs IndicXlit in front of
it — recorded here so the dependency is not rediscovered later.
"""

from __future__ import annotations

from worker_ai.alignment.base import Aligner
from worker_ai.providers.base import AlignmentRequest, Word
from worker_ai.vad import SpeechRegion

__all__ = ["IndicWav2VecAligner"]


class IndicWav2VecAligner(Aligner):
    """Aligner shell: identity, coverage and licence (A10)."""

    name = "indicwav2vec-ctc"
    rank = 20
    languages = ("hi", "bn", "gu", "kn", "ml", "mr", "or", "pa", "ta", "te", "ur")

    #: AI4Bharat, MIT-licensed checkpoints.
    model = "ai4bharat/indicwav2vec"
    licence = "MIT"

    def available(self) -> str | None:
        return "the IndicWav2Vec CTC aligner lands in A10"

    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        raise NotImplementedError("IndicWav2Vec alignment lands in A10")
