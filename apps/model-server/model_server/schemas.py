"""The wire contract, as pydantic models.

These shapes are **not** free to change. Three clients in ``apps/worker-ai`` are
already written against them and a fourth thing — the recorded session in
``worker_ai/fixtures/vendor/gpu-whisper/session.json`` — pins them in a file:

* ``providers/serverless_whisper.py`` → ``POST /transcribe``
* ``diarisation/pyannote.py`` → ``POST /diarise``
* ``lid.py`` (``GpuLanguageIdentifier``) → ``POST /detect-language``
* ``/align`` has no client yet; its word shape is deliberately identical to
  ``/transcribe``'s so the worker's existing ``_words()`` parser reads it
  unchanged when A10b wires the remote rung in.

Two conventions, both inherited rather than chosen:

* **Times are seconds** on every field except ``DetectLanguageRequest.windows``,
  which is ``[[startMs, endMs], …]`` because that is what ``lid.py`` already
  sends. Matching the client beats tidying the contract.
* **Requests ignore unknown fields.** ``ServerlessWhisperProvider`` splats
  ``request.options`` into the body, so a routing table that adds an option must
  not turn into a 422 from a server that has not been redeployed yet. Responses
  are supersets of what the fixtures record: extra keys are safe, missing keys
  are not.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

__all__ = [
    "AlignRequest",
    "AlignResponse",
    "DetectLanguageRequest",
    "DetectLanguageResponse",
    "DiariseRequest",
    "DiariseResponse",
    "LanguageWindow",
    "SpeakerTurnOut",
    "TextSignal",
    "TranscribeRequest",
    "TranscribeResponse",
    "TranscriptSegment",
    "TranscriptWord",
    "Usage",
    "dump",
]


class _Wire(BaseModel):
    """camelCase on the wire, snake_case in Python, extra request keys ignored."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="ignore",
        # `model` is a field name on several of these; without this, pydantic
        # warns about shadowing its own `model_` namespace on every import.
        protected_namespaces=(),
    )


# ---------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------


class TranscriptWord(_Wire):
    """One word, in seconds. The exact shape A10's fixture records."""

    start: float
    end: float
    word: str
    probability: float = 1.0


class TranscriptSegment(_Wire):
    """One utterance. Used by the caller only when ``words`` is empty."""

    start: float
    end: float
    text: str


class Usage(_Wire):
    """Cost accounting, settled by the caller against ``CreditsFacade``.

    ``gpuSeconds`` is the model-call time attributed to this request — for a
    batched call, the group's wall-clock divided by the group size, because the
    card was busy once for all of them and charging each the full duration would
    over-count the bill by the batch factor. That division is the whole reason
    ``batchSize`` is on the wire: without it the number cannot be audited.
    """

    gpu_seconds: float
    audio_seconds: float
    model: str
    batch_size: int


class TextSignal(_Wire):
    """A caller-supplied textual language signal, echoed back untouched."""

    language: str = ""
    confidence: float = 0.0


# ---------------------------------------------------------------------------
# /transcribe
# ---------------------------------------------------------------------------


class TranscribeRequest(_Wire):
    """The body ``ServerlessWhisperProvider.transcribe`` sends."""

    audio: str
    language: str | None = None
    word_timestamps: bool = True
    model: str | None = None
    hints: list[str] = Field(default_factory=list)
    #: Decoding settings, per the brief: beam and temperature come from the request.
    beam_size: Annotated[int, Field(ge=1, le=10)] = 5
    temperature: float | list[float] = 0.0
    initial_prompt: str | None = None
    vad_filter: bool = False
    condition_on_previous_text: bool = False

    def temperatures(self) -> tuple[float, ...]:
        """The temperature fallback ladder, always as a tuple."""
        if isinstance(self.temperature, list):
            return tuple(float(value) for value in self.temperature) or (0.0,)
        return (float(self.temperature),)

    def prompt(self) -> str | None:
        """Glossary hints become Whisper's ``initial_prompt`` (`09 §3`)."""
        if self.initial_prompt:
            return self.initial_prompt
        if self.hints:
            return ", ".join(hint.strip() for hint in self.hints if hint.strip()) or None
        return None


class TranscribeResponse(_Wire):
    """A superset of the recorded fixture: every recorded key, plus usage."""

    language: str
    language_probability: float
    duration_s: float
    model: str
    request_id: str
    words: list[TranscriptWord] = Field(default_factory=list)
    segments: list[TranscriptSegment] = Field(default_factory=list)
    engine_versions: dict[str, str] = Field(default_factory=dict)
    usage: Usage


# ---------------------------------------------------------------------------
# /align
# ---------------------------------------------------------------------------


class AlignRequest(_Wire):
    """Known words plus the span of audio they belong to."""

    audio: str
    words: list[str]
    language: str
    #: The span to align inside the file, in seconds. Defaults to the whole file.
    start_s: float = 0.0
    end_s: float | None = None
    model: str | None = None


class AlignResponse(_Wire):
    """Word timings in **file** time, in the same shape ``/transcribe`` returns."""

    language: str
    model: str
    licence: str
    duration_s: float
    request_id: str
    words: list[TranscriptWord] = Field(default_factory=list)
    #: Words the checkpoint's vocabulary could not represent (`09 §2` projection).
    skipped: list[str] = Field(default_factory=list)
    engine_versions: dict[str, str] = Field(default_factory=dict)
    usage: Usage


# ---------------------------------------------------------------------------
# /diarise
# ---------------------------------------------------------------------------


class DiariseRequest(_Wire):
    """The body ``PyannoteCommunityDiariser.diarise`` sends. Whole file, never a chunk."""

    audio: str
    model: str | None = None
    num_speakers: int | None = Field(default=None, ge=1, le=64)
    min_speakers: int | None = Field(default=None, ge=1, le=64)
    max_speakers: int | None = Field(default=None, ge=1, le=64)


class SpeakerTurnOut(_Wire):
    """One turn. ``speaker`` keeps pyannote's ``SPEAKER_00`` label.

    The worker maps it to the EDG's opaque ``S1``/``S2`` ids — that mapping is
    deliberately the caller's, because ``SPEAKER_00`` is a pyannote implementation
    detail that must never reach a caption, and the caller is the side that knows
    what a caption is.
    """

    speaker: str
    start: float
    end: float
    confidence: float | None = None


class DiariseResponse(_Wire):
    """Turns plus the CC-BY-4.0 attribution D77 requires in ``engineVersions``."""

    model: str
    turns: list[SpeakerTurnOut] = Field(default_factory=list)
    request_id: str
    duration_s: float
    engine_versions: dict[str, str] = Field(default_factory=dict)
    usage: Usage


# ---------------------------------------------------------------------------
# /detect-language
# ---------------------------------------------------------------------------


class DetectLanguageRequest(_Wire):
    """The body ``GpuLanguageIdentifier.identify`` sends.

    ``windows`` is ``[[startMs, endMs], …]`` — **milliseconds**, unlike every
    other time on this wire, because ``lid.py`` already sends it that way.
    """

    audio: str
    windows: list[list[int]] = Field(default_factory=list)
    #: Optional second signal from the caller, echoed back untouched.
    text_signal: TextSignal | None = None

    def window_pairs(self) -> tuple[tuple[int, int], ...]:
        """``windows`` as clean ``(startMs, endMs)`` pairs, dropping malformed ones."""
        pairs: list[tuple[int, int]] = []
        for window in self.windows:
            if len(window) < 2:
                continue
            start, end = int(window[0]), int(window[1])
            if end > start >= 0:
                pairs.append((start, end))
        return tuple(pairs)


class LanguageWindow(_Wire):
    """One window's verdict, so a caller can see the disagreement, not just the pool."""

    start_ms: int
    end_ms: int
    language: str
    probability: float


class DetectLanguageResponse(_Wire):
    """The pooled audio verdict, plus the per-window detail and the echoed text signal.

    ``language`` and ``probability`` are the **audio** verdict and nothing else.
    `09 §1` requires two signals that agree before a code-mix lane is chosen, and
    the agreement rule lives in the caller (``worker_ai.lid``); a server that
    quietly folded the caller's own text signal into its answer would make that
    rule check a number against itself.
    """

    language: str
    probability: float
    model: str
    request_id: str
    windows: list[LanguageWindow] = Field(default_factory=list)
    text_signal: TextSignal | None = None
    engine_versions: dict[str, str] = Field(default_factory=dict)
    usage: Usage


def dump(model: BaseModel) -> dict[str, Any]:
    """Serialise a response by alias, dropping nothing but unset optionals."""
    return model.model_dump(mode="json")
