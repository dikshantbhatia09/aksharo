"""The translation provider interface (`09 §4`, A22).

Segment-preserving by contract: **one segment in, one segment out**, same
order, same count — the caller (`service.py`) enforces this even when a
provider itself is well-behaved, because a silently dropped segment would
misalign every `SetSegmentText` op the completion writes.

Every adapter is a thin wrapper over a vendor call, tested against
``httpx2.MockTransport`` (no vendor key exists — A00-06), mirroring the shape
`worker_ai/providers/*` already uses for the ASR adapters.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from worker_ai.providers.base import ProviderSubmission

__all__ = [
    "TranslatedSegment",
    "TranslationProvider",
    "TranslationRequest",
    "TranslationResult",
    "TranslationSegment",
]


@dataclass(frozen=True, slots=True)
class TranslationSegment:
    """One caption segment on its way to a provider."""

    segment_id: str
    text: str
    #: Set on a retry: ask the provider for a shorter rendering of the same text.
    shorter: bool = False


@dataclass(frozen=True, slots=True)
class TranslationRequest:
    segments: tuple[TranslationSegment, ...]
    #: BCP-47 source and target tags.
    source_language: str
    target_language: str


@dataclass(frozen=True, slots=True)
class TranslatedSegment:
    segment_id: str
    text: str


@dataclass(frozen=True, slots=True)
class TranslationResult:
    #: Same length and order as the request — the provider's own responsibility
    #: to preserve; ``service.py`` also asserts it, because "the provider
    #: promises to" is not a guarantee.
    segments: tuple[TranslatedSegment, ...]
    submissions: tuple[ProviderSubmission, ...] = field(default_factory=tuple)


class TranslationProvider(ABC):
    """What every translation adapter implements."""

    #: Stable identifier used in the job's `usage.provider` and in logs.
    name: str = "abstract"

    @abstractmethod
    async def translate(self, request: TranslationRequest) -> TranslationResult:
        """Translate every segment in `request`, preserving order and count.

        :raises worker_ai.providers.base.ProviderError: on any provider-side
            failure; the chain in ``service.py`` falls through to the next
            provider.
        """
        raise NotImplementedError

    async def aclose(self) -> None:
        return None
