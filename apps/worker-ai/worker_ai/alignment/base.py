"""Forced alignment: the interface and the per-language registry (decision **D13**).

`09 §2` fixes the order, best first, as amended by decision **D77**:

```
provider word timestamps (Scribe, AssemblyAI, Whisper)
  -> IndicWav2Vec CTC heads    (~11 Indic languages, MIT)
  -> XLSR-53 CTC fine-tunes    (global languages, Apache-2.0)
  -> ElevenLabs Forced Alignment (paid)
  -> proportional distribution refined by VAD boundaries
```

Rung 3 was Meta MMS until **D77**: its common export is CC-BY-NC-4.0, which is
non-commercial, so it is excluded from the product entirely — not disabled, not
flagged off, *removed*, and named in ``routing.NEVER_ROUTE`` so it cannot be
reintroduced by configuration.

The last rung is the one that must never be missing: it needs no model, no
network and no credentials, so alignment is always available. The three above it
are model- or vendor-backed and each reports itself unavailable, by name, when
its checkpoint directory or its credential is absent — which is what keeps an
unconfigured aligner out of the chain instead of failing a job with an import
error halfway through a transcript.

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

    def available_for(self, language: str) -> str | None:
        """Availability for one language.

        A model-backed rung has a checkpoint per language, so "installed" and
        "installed for Tamil" are different questions; the default answers them
        the same way.
        """
        del language
        return self.available()

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

    async def aclose(self) -> None:
        """Release any client or session. Idempotent; the default is a no-op."""
        return None

    def drain_submissions(self) -> tuple[Any, ...]:
        """External calls made since the last drain, and forget them.

        An aligner instance is process-wide (the registry caches it), so a caller
        that only *read* the list would attach one job's submissions to the next
        job's completion. The default has nothing to drain.
        """
        return ()


@dataclass(frozen=True, slots=True)
class AlignerRegistry:
    """The ordered chain, resolved per language."""

    aligners: tuple[Aligner, ...]

    def __post_init__(self) -> None:
        """Refuse a component excluded on licence grounds (D77, D63).

        The same list that stops ``routing.yaml`` naming a forbidden component
        stops one being registered here, so re-adding an excluded aligner fails
        at import rather than at the first job that needs it.
        """
        from worker_ai.routing import NEVER_ROUTE

        for aligner in self.aligners:
            family = getattr(aligner, "family", "")
            for name in (aligner.name, family):
                reason = NEVER_ROUTE.get(name)
                if reason is not None:
                    raise ValueError(
                        "aligner " + repr(aligner.name) + " must not be used: " + reason
                    )

    @classmethod
    def default(cls) -> AlignerRegistry:
        """The chain with nothing configured: only the fallback can actually run.

        The three rungs above it are still *present* so ``GET /providers`` can
        say why each is unavailable — "no checkpoints installed", "no key" —
        rather than pretending they do not exist.
        """
        from worker_ai.alignment.elevenlabs_fa import ElevenLabsForcedAligner
        from worker_ai.alignment.indic_wav2vec import IndicWav2VecAligner
        from worker_ai.alignment.proportional import ProportionalAligner
        from worker_ai.alignment.xlsr import Xlsr53Aligner

        return cls(
            aligners=(
                IndicWav2VecAligner(),
                Xlsr53Aligner(),
                ElevenLabsForcedAligner(),
                ProportionalAligner(),
            )
        )

    @classmethod
    def from_settings(cls, settings: Any) -> AlignerRegistry:
        """The chain a deployment can actually run (`09 §2`, D13).

        Model directories come from ``WORKER_AI_ALIGN_MODEL_DIR`` and the paid
        rung from ``ELEVENLABS_API_KEY`` plus the ``align.elevenlabs`` flag, so a
        pod with no models and no key still aligns — on the proportional rung,
        which needs neither.
        """
        from worker_ai.alignment.elevenlabs_fa import ElevenLabsForcedAligner
        from worker_ai.alignment.indic_wav2vec import IndicWav2VecAligner
        from worker_ai.alignment.proportional import ProportionalAligner
        from worker_ai.alignment.xlsr import Xlsr53Aligner

        model_dir = str(getattr(settings, "align_model_dir", "") or "")
        return cls(
            aligners=(
                IndicWav2VecAligner(model_dir),
                Xlsr53Aligner(model_dir),
                ElevenLabsForcedAligner(
                    str(getattr(settings, "elevenlabs_api_key", "") or ""),
                    enabled=bool(settings.flag("align.elevenlabs", default=True)),
                ),
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
            reason = aligner.available_for(language)
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
                "model": str(getattr(aligner, "model", "") or ""),
                "licence": str(getattr(aligner, "licence", "") or ""),
                "available": aligner.available_for(language) is None,
                "reason": aligner.available_for(language),
            }
            for aligner in self.chain(language)
        )
