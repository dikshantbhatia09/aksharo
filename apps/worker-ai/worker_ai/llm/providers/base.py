"""The ``LlmProvider`` interface every text-generation adapter implements."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

__all__ = [
    "LlmError",
    "LlmProvider",
    "LlmRequest",
    "LlmResponse",
    "LlmUsage",
]


class LlmError(RuntimeError):
    """A provider call failed.

    ``retryable`` mirrors ``worker_ai.providers.base.ProviderError``: a 429 or
    5xx is retryable, a rejected key or a bad request is not.
    """

    def __init__(self, message: str, *, provider: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class LlmRequest:
    system: str
    user: str
    max_tokens: int
    temperature: float
    #: Region this call must be pinned to (``region.py``), for adapters that
    #: route to a region-specific endpoint.
    region: str = "in"


@dataclass(frozen=True, slots=True)
class LlmUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cost_minor: int | None = None
    currency: str = "INR"


@dataclass(frozen=True, slots=True)
class LlmResponse:
    text: str
    usage: LlmUsage = field(default_factory=LlmUsage)
    #: The endpoint actually called, for the ``provider_submissions`` row.
    endpoint: str = ""


class LlmProvider(ABC):
    """Base class for every LLM text-generation adapter."""

    #: Stable identifier used in config, usage records and `provider_submissions`.
    name: str = "abstract"

    #: Regions this adapter can serve without crossing a jurisdiction boundary
    #: (brief section 2: "region pinning per workspace jurisdiction").
    supported_regions: frozenset[str] = frozenset()

    #: This provider is contractually configured never to train on submitted
    #: data (brief section 2: "no training enforcement"). Recorded on the
    #: ``provider_submissions`` row's retention class.
    no_training: bool = True

    @abstractmethod
    async def generate(self, request: LlmRequest) -> LlmResponse:
        """Call the model. :raises LlmError: on any provider-side failure."""
        raise NotImplementedError

    def supports_region(self, region: str) -> bool:
        return region in self.supported_regions

    async def aclose(self) -> None:
        return None
