"""Forced alignment: the interface and the per-language registry (decision **D13**).

`09 §2` fixes the order, best first:

```
provider word timestamps (Scribe, AssemblyAI, Whisper)
  -> IndicWav2Vec CTC heads (~11 Indic languages, MIT)
  -> Meta MMS multilingual CTC with romanisation
  -> ElevenLabs Forced Alignment (paid)
  -> proportional distribution refined by VAD boundaries
```

A09 ships the last one, which is the rung that must never be missing: it needs no
model, no network and no credentials, so alignment is always available. A10 fills
in the three above it, and the registry below is what they slot into — a name, an
ordered language list, and a `available()` check that keeps an unconfigured
aligner out of the chain.

The quality bar the chain exists to hit: median absolute word-onset error ≤ 40 ms
(English) and ≤ 80 ms (Indic), with every word snapped inside a VAD speech region.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import AlignmentRequest, Word
from worker_ai.vad import SpeechRegion

__all__ = ["Aligner", "AlignerRegistry", "AlignmentUnavailableError"]

_log = get_logger(__name__)


class AlignmentUnavailableError(RuntimeError):
    """No aligner in the chain can serve a language."""


class Aligner(ABC):
    """Puts word timings on known text."""

    #: Stable identifier, written into ``transcripts.alignerModel``.
    name: str = "abstract"

    #: Languages this aligner covers; empty means "any".
    languages: tuple[str, ...] = ()

    #: Ordering hint: lower runs first. The chain in `09 §2` is 10/20/30/40/100.
    rank: int = 100

    def available(self) -> str | None:
        """``None`` when usable here, otherwise the reason it is not."""
        return None

    def covers(self, language: str) -> bool:
        """True when this aligner claims ``language`` (or claims everything)."""
        if not self.languages:
            return True
        folded = language.strip().casefold()
        base = folded.split("-")[0]
        return any(tag.casefold() in {folded, base} for tag in self.languages)

    @abstractmethod
    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        """Return one :class:`Word` per input word, in order, with ms timings."""
        raise NotImplementedError


@dataclass(frozen=True, slots=True)
class AlignerRegistry:
    """The ordered chain, resolved per language."""

    aligners: tuple[Aligner, ...]

    @classmethod
    def default(cls) -> AlignerRegistry:
        """The A09 chain: the A10 shells, then the always-available fallback."""
        from worker_ai.alignment.elevenlabs_fa import ElevenLabsForcedAligner
        from worker_ai.alignment.indic_wav2vec import IndicWav2VecAligner
        from worker_ai.alignment.mms import MmsAligner
        from worker_ai.alignment.proportional import ProportionalAligner

        return cls(
            aligners=(
                IndicWav2VecAligner(),
                MmsAligner(),
                ElevenLabsForcedAligner(),
                ProportionalAligner(),
            )
        )

    def chain(self, language: str) -> tuple[Aligner, ...]:
        """Every aligner that covers ``language``, best first."""
        return tuple(
            aligner
            for aligner in sorted(self.aligners, key=lambda item: item.rank)
            if aligner.covers(language)
        )

    def resolve(self, language: str) -> Aligner:
        """The best *available* aligner for ``language``.

        :raises AlignmentUnavailableError: when the chain is empty, which can only
            happen if the proportional fallback has been removed.
        """
        skipped: list[str] = []
        for aligner in self.chain(language):
            reason = aligner.available()
            if reason is None:
                return aligner
            skipped.append(f"{aligner.name}: {reason}")
        raise AlignmentUnavailableError(
            f"no aligner available for {language!r} ({'; '.join(skipped) or 'empty chain'})"
        )

    def describe(self, language: str = "en") -> tuple[dict[str, Any], ...]:
        """The chain as data, for ``GET /providers``."""
        return tuple(
            {
                "name": aligner.name,
                "rank": aligner.rank,
                "languages": list(aligner.languages),
                "available": aligner.available() is None,
                "reason": aligner.available(),
            }
            for aligner in self.chain(language)
        )
