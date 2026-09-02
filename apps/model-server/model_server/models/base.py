"""The three backend interfaces, and the value types that cross them.

Every heavyweight import in this package is lazy and lives behind one of these
abstract classes. That buys two things that matter more than the indirection
costs:

* **The CPU test lane installs no CUDA stack.** A backend whose package is absent
  answers :meth:`Backend.unavailable` with a sentence naming what is missing,
  and the route turns that into a 503 the client can read — never an
  ``ImportError`` raised halfway through a request.
* **The tests drive real routes.** A fake backend implementing the same three
  methods proves batching, the memory guard, auth and every wire shape without a
  model download, and the one test that *does* download proves the fakes are not
  lying about the interface.

Times inside this module are **seconds**, matching the wire and matching every
ASR stack. Milliseconds appear only in ``apps/worker-ai``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

__all__ = [
    "AlignJob",
    "AlignOutput",
    "AlignerBackend",
    "AsrBackend",
    "Backend",
    "DetectJob",
    "DiariseJob",
    "DiariserBackend",
    "LanguageVerdict",
    "SegmentTiming",
    "SpeakerTurn",
    "TranscribeJob",
    "TranscribeOutput",
    "WordTiming",
]


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class WordTiming:
    """One word, in seconds, exactly as it goes on the wire."""

    start: float
    end: float
    word: str
    probability: float = 1.0


@dataclass(frozen=True, slots=True)
class SegmentTiming:
    """One utterance, used when a backend has no word timings to give."""

    start: float
    end: float
    text: str


@dataclass(frozen=True, slots=True)
class SpeakerTurn:
    """One diarisation turn. ``speaker`` keeps pyannote's own label."""

    speaker: str
    start: float
    end: float
    confidence: float | None = None


@dataclass(frozen=True, slots=True)
class LanguageVerdict:
    """One window's language identification."""

    language: str
    probability: float
    start_ms: int = 0
    end_ms: int = 0


@dataclass(frozen=True, slots=True)
class TranscribeJob:
    """One decoded chunk, ready for the ASR backend."""

    samples: NDArray[np.float32]
    sample_rate: int
    language: str | None = None
    beam_size: int = 5
    temperature: tuple[float, ...] = (0.0,)
    initial_prompt: str | None = None
    word_timestamps: bool = True
    vad_filter: bool = False
    condition_on_previous_text: bool = False


@dataclass(frozen=True, slots=True)
class DetectJob:
    """Language identification over one or more windows of one file."""

    samples: NDArray[np.float32]
    sample_rate: int
    #: ``(startMs, endMs)`` pairs, as ``worker_ai.lid.GpuLanguageIdentifier`` sends them.
    windows: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True, slots=True)
class AlignJob:
    """Known text plus the audio span it belongs to."""

    samples: NDArray[np.float32]
    sample_rate: int
    words: tuple[str, ...]
    language: str
    #: Offset of ``samples`` within the file, so the returned times are file times.
    start_s: float = 0.0


@dataclass(frozen=True, slots=True)
class DiariseJob:
    """A whole file — never a chunk (`09 §2`)."""

    samples: NDArray[np.float32]
    sample_rate: int
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None


@dataclass(frozen=True, slots=True)
class TranscribeOutput:
    """What ``/transcribe`` needs from the ASR backend."""

    language: str
    language_probability: float
    duration_s: float
    words: tuple[WordTiming, ...] = ()
    segments: tuple[SegmentTiming, ...] = ()


@dataclass(frozen=True, slots=True)
class AlignOutput:
    """What ``/align`` needs from the aligner."""

    words: tuple[WordTiming, ...]
    model_id: str
    licence: str
    #: Words whose characters the checkpoint's vocabulary does not contain.
    skipped: tuple[str, ...] = ()


# ---------------------------------------------------------------------------
# Interfaces
# ---------------------------------------------------------------------------


class Backend(ABC):
    """Shared lifecycle: load once at startup, stay warm, unload on drain."""

    #: Stable id, reported in ``usage.model`` and in ``engineVersions``.
    model_id: str = "unknown"

    #: Licence string surfaced in ``engineVersions``; CC-BY-4.0 requires it.
    licence: str = ""

    #: Kind, for ``model_server_model_ready``: ``asr``, ``align`` or ``diarise``.
    kind: str = "backend"

    #: Flipped by :meth:`load`; ``/readyz`` reads it through the registry.
    _ready: bool = False

    def unavailable(self) -> str | None:
        """``None`` when this backend can serve, otherwise why it cannot."""
        return None

    @property
    def ready(self) -> bool:
        return self._ready

    @abstractmethod
    def load(self) -> None:
        """Bring the weights into memory. Called once, at startup, never per request."""
        raise NotImplementedError

    def unload(self) -> None:
        """Release the weights. Idempotent; the default just flips the flag."""
        self._ready = False

    def engine_versions(self) -> dict[str, str]:
        """The ``engineVersions`` fragment this backend contributes."""
        versions = {self.kind: self.model_id}
        if self.licence:
            versions[self.kind + ".licence"] = self.licence
        return versions


class AsrBackend(Backend):
    """Whisper: transcription and language identification."""

    kind = "asr"

    @abstractmethod
    def transcribe(self, jobs: Sequence[TranscribeJob]) -> list[TranscribeOutput]:
        """One output per job, in order. Called with a whole batch (D74)."""
        raise NotImplementedError

    @abstractmethod
    def detect_language(self, job: DetectJob) -> list[LanguageVerdict]:
        """One verdict per window, in order."""
        raise NotImplementedError


class AlignerBackend(Backend):
    """CTC forced alignment (decision **D77**: IndicWav2Vec or XLSR-53, never MMS)."""

    kind = "align"

    def unavailable_for(self, language: str) -> str | None:
        """Availability for one language; a per-language checkpoint can be missing."""
        del language
        return self.unavailable()

    @abstractmethod
    def align(self, job: AlignJob) -> AlignOutput:
        """Word timings in file time for ``job.words``."""
        raise NotImplementedError


class DiariserBackend(Backend):
    """pyannote community-1, run over the whole file."""

    kind = "diarise"

    #: CC-BY-4.0 obliges attribution wherever the output is used.
    attribution: str = ""

    def engine_versions(self) -> dict[str, str]:
        versions = super().engine_versions()
        if self.attribution:
            versions[self.kind + ".attribution"] = self.attribution
        return versions

    @abstractmethod
    def diarise(self, job: DiariseJob) -> tuple[SpeakerTurn, ...]:
        """Speaker turns over the whole file, sorted by start time."""
        raise NotImplementedError
