"""The provider interface every ASR / alignment / diarisation adapter implements.

A01 defines **signatures only**. A09 adds the mock provider and the serverless
faster-whisper adapter; A10 adds ElevenLabs Scribe v2, Sarvam Saaras v4 (Batch)
and AssemblyAI behind the same interface, plus the routing weights that choose
between them.

Design rules that the interface encodes:

* Word ids are allocated by the caller, never by a provider — ``wid`` is
  ``"<chunkIdx>:<n>"`` and is never reused (CONTRACTS section 2).
* Times are milliseconds (``*Ms``); a provider that returns seconds converts here.
* Every method is ``async`` because every implementation is network- or
  subprocess-bound.
* Providers never write to storage or the database; they return data and the
  caller persists it, so a provider can be swapped or shadow-run for evals (D08).
* Nothing from a provider response is trusted as an instruction: transcript text
  reaches an LLM only inside a delimited data block (THREAT-MODEL T19).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

__all__ = [
    "AlignmentRequest",
    "DiarisationRequest",
    "DiarisedSpeaker",
    "Provider",
    "ProviderCapability",
    "ProviderError",
    "ProviderUsage",
    "TranscriptionRequest",
    "TranscriptionResult",
    "Word",
]

#: What a provider can do. The registry selects adapters by capability.
ProviderCapability = Literal["transcribe", "align", "diarise"]

#: Script variants a word can carry (CONTRACTS section 2).
ScriptName = Literal["roman", "native", "en"]


class ProviderError(RuntimeError):
    """A provider call failed.

    ``retryable`` tells the worker whether to let BullMQ retry (transient network
    or rate-limit failures) or to fail the job immediately (bad audio, rejected
    credentials).
    """

    def __init__(self, message: str, *, provider: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class Word:
    """One transcribed word (CONTRACTS section 2).

    ``wid`` is assigned by the caller after chunking, so a provider returns words
    in order and the caller stamps stable ids onto them.
    """

    #: Start time in milliseconds.
    s: int
    #: End time in milliseconds.
    e: int
    #: Text.
    t: str
    #: Confidence, 0..1.
    c: float | None = None
    #: Speaker id from diarisation.
    sp: str | None = None
    scripts: dict[ScriptName, str] = field(default_factory=dict)
    filler: bool = False


@dataclass(frozen=True, slots=True)
class ProviderUsage:
    """Billing and cost telemetry returned to the API completion callback.

    Mirrors the ``usage`` object in CONTRACTS section 3 so the caller can forward
    it unchanged.
    """

    media_seconds: float | None = None
    provider: str | None = None
    model: str | None = None
    cost_minor: int | None = None


@dataclass(frozen=True, slots=True)
class TranscriptionRequest:
    """Input for :meth:`Provider.transcribe`."""

    #: Signed URL or local path to 16 kHz mono audio produced by worker-media.
    audio_uri: str
    #: BCP-47 tag, or ``None`` to let the provider detect the language.
    language: str | None = None
    #: Ask for word-level timestamps. Always true in the Montaj pipeline.
    word_timestamps: bool = True
    #: Domain terms to boost (glossary, B09).
    hints: tuple[str, ...] = ()
    #: Offset added to every returned timestamp when transcribing a chunk.
    offset_ms: int = 0


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    """Output of :meth:`Provider.transcribe`."""

    words: tuple[Word, ...]
    #: Detected or echoed BCP-47 language tag.
    language: str
    #: Language-identification confidence, 0..1.
    language_confidence: float | None = None
    usage: ProviderUsage | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class AlignmentRequest:
    """Input for :meth:`Provider.align`: force known text onto audio."""

    audio_uri: str
    #: Words to align, in order. Timestamps on the input are ignored.
    words: tuple[str, ...]
    language: str
    offset_ms: int = 0


@dataclass(frozen=True, slots=True)
class DiarisedSpeaker:
    """One speaker turn from :meth:`Provider.diarise`."""

    speaker_id: str
    start_ms: int
    end_ms: int
    confidence: float | None = None


@dataclass(frozen=True, slots=True)
class DiarisationRequest:
    """Input for :meth:`Provider.diarise`."""

    audio_uri: str
    #: Known speaker count, when the user supplied one.
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None


class Provider(ABC):
    """Base class for every speech provider adapter.

    Subclasses declare the subset of methods they support through
    :attr:`capabilities` and raise :class:`NotImplementedError` from the rest;
    the registry never routes a job to a provider that lacks its capability.
    """

    #: Stable identifier used in routing weights, usage records and eval reports.
    name: str = "abstract"

    #: What this adapter can do.
    capabilities: frozenset[ProviderCapability] = frozenset()

    @abstractmethod
    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        """Transcribe audio into words with millisecond timings.

        :raises ProviderError: on any provider-side failure.
        """
        raise NotImplementedError

    @abstractmethod
    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        """Force-align known text onto audio, returning word timings.

        :raises ProviderError: on any provider-side failure.
        """
        raise NotImplementedError

    @abstractmethod
    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        """Segment audio into speaker turns.

        :raises ProviderError: on any provider-side failure.
        """
        raise NotImplementedError

    def supports(self, capability: ProviderCapability) -> bool:
        """True when this adapter implements ``capability``."""
        return capability in self.capabilities
