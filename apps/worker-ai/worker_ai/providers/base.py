"""The provider interface every ASR / alignment / diarisation adapter implements.

A01 defined the signatures. **A09** adds the capability record, the cost estimate
and the provider-submission trail, and ships the mock, local faster-whisper and
serverless-GPU adapters. **A10** adds ElevenLabs Scribe v2, Sarvam Saaras v4
(Batch) and AssemblyAI behind this same interface, plus the routing weights that
choose between them.

Design rules that the interface encodes:

* Word ids are allocated by the caller, never by a provider — ``wid`` is
  ``"<chunkIdx>:<n>"`` and is never reused (CONTRACTS section 2).
* Times are milliseconds (``*Ms``); a provider that returns seconds converts here.
* Every method is ``async`` because every implementation is network- or
  subprocess-bound.
* Providers never write to storage or the database; they return data and the
  caller persists it, so a provider can be swapped or shadow-run for evals (D08).
* Every external call is declared as a :class:`ProviderSubmission` so the API can
  write a ``provider_submissions`` row and honour a later erasure request
  (`06 §Invariant 5`).
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
    "ProviderCapabilities",
    "ProviderCapability",
    "ProviderCost",
    "ProviderError",
    "ProviderSubmission",
    "ProviderUsage",
    "ScriptName",
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

    def shifted(self, offset_ms: int) -> Word:
        """The same word moved by ``offset_ms`` — how chunk timings become file timings."""
        return Word(
            s=self.s + offset_ms,
            e=self.e + offset_ms,
            t=self.t,
            c=self.c,
            sp=self.sp,
            scripts=dict(self.scripts),
            filler=self.filler,
        )


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    """What an adapter can do, as data the registry and ``/providers`` can read."""

    #: Which of transcribe / align / diarise this adapter implements.
    supported: frozenset[ProviderCapability] = frozenset()
    #: Returns per-word timings without a separate alignment pass.
    word_timestamps: bool = False
    #: Returns speaker labels.
    diarisation: bool = False
    #: Longest single request the vendor accepts, in seconds (``None`` = unbounded).
    max_duration_s: int | None = None
    #: Submit-and-poll rather than request-response (Sarvam Batch, `09 §1`).
    batch: bool = False
    #: BCP-47 tags or families the adapter covers; empty means "any".
    languages: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "supported": sorted(self.supported),
            "wordTimestamps": self.word_timestamps,
            "diarisation": self.diarisation,
            "maxDurationS": self.max_duration_s,
            "batch": self.batch,
            "languages": list(self.languages),
        }


@dataclass(frozen=True, slots=True)
class ProviderCost:
    """An estimate, in minor units. INR paise for every vendor in `09 §10`."""

    minor: int
    currency: str = "INR"

    def to_wire(self) -> dict[str, Any]:
        return {"minor": self.minor, "currency": self.currency}


@dataclass(frozen=True, slots=True)
class ProviderSubmission:
    """One external call, recorded so the API can write ``provider_submissions``.

    ``artefact`` is what left the building — ``audio16k.wav``, a chunk of it, or a
    transcript — because an erasure request has to be able to find it again.
    """

    provider: str
    endpoint: str
    artefact: str
    external_ref: str | None = None
    region: str | None = None
    retention_class: str | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "provider": self.provider,
            "endpoint": self.endpoint,
            "artefact": self.artefact,
        }
        if self.external_ref is not None:
            wire["externalRef"] = self.external_ref
        if self.region is not None:
            wire["region"] = self.region
        if self.retention_class is not None:
            wire["retentionClass"] = self.retention_class
        return wire


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
    #: Ask for word-level timestamps. Always true in the pipeline.
    word_timestamps: bool = True
    #: Domain terms to boost (glossary, B09).
    hints: tuple[str, ...] = ()
    #: Offset added to every returned timestamp when transcribing a chunk.
    offset_ms: int = 0
    #: Vendor-specific knobs (Sarvam ``mode=codemix``, Whisper ``beam_size``, ...).
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    """Output of :meth:`Provider.transcribe`."""

    words: tuple[Word, ...]
    #: Detected or echoed BCP-47 language tag.
    language: str
    #: Language-identification confidence, 0..1.
    language_confidence: float | None = None
    usage: ProviderUsage | None = None
    #: Segment-level text where the provider gives no word timings (Sarvam REST).
    segments: tuple[tuple[int, int, str], ...] = ()
    submissions: tuple[ProviderSubmission, ...] = ()
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class AlignmentRequest:
    """Input for :meth:`Provider.align`: force known text onto audio."""

    audio_uri: str
    #: Words to align, in order. Timestamps on the input are ignored.
    words: tuple[str, ...]
    language: str
    offset_ms: int = 0
    #: The span the words belong to, when aligning one segment rather than a file.
    start_ms: int = 0
    end_ms: int | None = None


@dataclass(frozen=True, slots=True)
class DiarisedSpeaker:
    """One speaker turn from :meth:`Provider.diarise`."""

    speaker_id: str
    start_ms: int
    end_ms: int
    confidence: float | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "speakerId": self.speaker_id,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
        }
        if self.confidence is not None:
            wire["confidence"] = self.confidence
        return wire


@dataclass(frozen=True, slots=True)
class DiarisationRequest:
    """Input for :meth:`Provider.diarise`."""

    audio_uri: str
    #: Known speaker count, when the user supplied one.
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None
    #: Speech regions from VAD, so a diariser need not run its own.
    regions: tuple[tuple[int, int], ...] = ()


class Provider(ABC):
    """Base class for every speech provider adapter.

    Subclasses declare the subset of methods they support through
    :attr:`capabilities` and raise :class:`NotImplementedError` from the rest;
    the registry never routes a job to a provider that lacks its capability.
    """

    #: Stable identifier used in routing weights, usage records and eval reports.
    name: str = "abstract"

    #: What this adapter can do.
    capabilities: ProviderCapabilities = ProviderCapabilities()

    #: List price in ₹ per media minute (`09 §1`, `05 §12`); 0 for local models.
    cost_per_minute_inr: float = 0.0

    #: False for adapters that synthesise a result and never open the audio file,
    #: which is what lets the eval sets ship before their media does.
    reads_audio: bool = True

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
        return capability in self.capabilities.supported

    def cost_estimate(self, seconds: float) -> ProviderCost:
        """List price for ``seconds`` of media, rounded up to the paisa.

        An estimate, not a bill: it feeds ``usage.costMinor`` for margin analysis
        (`05 §11`) and the eval leaderboard's cost column.
        """
        if seconds < 0:
            raise ValueError("seconds must not be negative")
        paise = self.cost_per_minute_inr * 100.0 * seconds / 60.0
        return ProviderCost(minor=int(paise + 0.999999), currency="INR")

    async def aclose(self) -> None:
        """Release any client the adapter holds. Idempotent; the default is a no-op."""
        return None
