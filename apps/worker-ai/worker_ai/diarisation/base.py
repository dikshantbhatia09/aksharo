"""Diarisation: the interface and the registry (decision **D13**).

`09 §2` is specific about *how*, not just *what*: diarisation runs **globally over
the whole file** (or chunk-local labels clustered by speaker embeddings) so that
speaker ids survive chunk boundaries. A chunk-local diariser that renumbers
speakers per chunk is worse than none, because the editor would show "Speaker 1"
changing identity every ten minutes.

A09 ships :class:`~worker_ai.diarisation.noop.NoopDiariser`; A10 adds pyannote
community-1 behind the same interface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from worker_ai.providers.base import DiarisationRequest, DiarisedSpeaker

__all__ = ["DiarisationUnavailableError", "Diariser", "DiariserRegistry"]


class DiarisationUnavailableError(RuntimeError):
    """No diariser is available in this deployment."""


class Diariser(ABC):
    """Segments a whole file into speaker turns."""

    #: Written into ``transcripts.diariser``.
    name: str = "abstract"

    #: Lower runs first.
    rank: int = 100

    #: True when the implementation labels the whole file at once (`09 §2`).
    global_labels: bool = True

    def available(self) -> str | None:
        """``None`` when usable here, otherwise the reason it is not."""
        return None

    @abstractmethod
    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        """Speaker turns in file time, in order."""
        raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DiariserRegistry:
    """The ordered chain; ``resolve`` returns the best available."""

    diarisers: tuple[Diariser, ...]

    @classmethod
    def default(cls) -> DiariserRegistry:
        from worker_ai.diarisation.noop import NoopDiariser
        from worker_ai.diarisation.pyannote import PyannoteCommunityDiariser

        return cls(diarisers=(PyannoteCommunityDiariser(), NoopDiariser()))

    def resolve(self) -> Diariser:
        skipped: list[str] = []
        for diariser in sorted(self.diarisers, key=lambda item: item.rank):
            reason = diariser.available()
            if reason is None:
                return diariser
            skipped.append(f"{diariser.name}: {reason}")
        raise DiarisationUnavailableError("; ".join(skipped) or "no diariser is registered")

    def describe(self) -> tuple[dict[str, Any], ...]:
        return tuple(
            {
                "name": diariser.name,
                "rank": diariser.rank,
                "globalLabels": diariser.global_labels,
                "available": diariser.available() is None,
                "reason": diariser.available(),
            }
            for diariser in sorted(self.diarisers, key=lambda item: item.rank)
        )
