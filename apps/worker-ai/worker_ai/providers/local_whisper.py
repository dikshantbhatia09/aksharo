"""faster-whisper on the CPU: the local lane and the offline fallback.

`09 §1` routes global languages to a self-hosted ``large-v3-turbo`` on serverless
GPU. This adapter is the same model family run in-process, which is what makes a
developer machine, a CI box and the eval harness able to produce a real transcript
with no vendor account at all.

``faster-whisper`` is an **optional** dependency (``pip install -e ".[local-asr]"``,
and the CPU Docker image installs it): it drags in CTranslate2 and downloads model
weights on first use, neither of which belongs in the unit-test path. The import
therefore happens inside :meth:`LocalWhisperProvider._model`, and the adapter is
still fully testable because the model factory is injectable.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable
from typing import Any, Protocol

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderCapabilities,
    ProviderError,
    ProviderSubmission,
    ProviderUsage,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)

__all__ = ["LocalWhisperProvider", "WhisperModel", "words_from_segments"]

_log = get_logger(__name__)


class WhisperModel(Protocol):
    """The slice of ``faster_whisper.WhisperModel`` this adapter uses."""

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Iterable[Any], Any]:
        """Return ``(segments, info)``; segments stream lazily."""
        ...


def _ms(seconds: float | None, offset_ms: int) -> int:
    """Whisper talks in float seconds; the EDG talks in integer milliseconds."""
    return offset_ms + round((seconds or 0.0) * 1000)


def words_from_segments(segments: Iterable[Any], offset_ms: int) -> tuple[Word, ...]:
    """Flatten faster-whisper's segment/word tree into ordered :class:`Word` values.

    Segments without word timings (``word_timestamps=False``, or a segment the
    model could not align) degrade to one word per segment rather than being
    dropped, so a caller always gets something the alignment registry can refine.
    """
    words: list[Word] = []
    for segment in segments:
        segment_words = getattr(segment, "words", None) or []
        if segment_words:
            for word in segment_words:
                text = str(getattr(word, "word", "")).strip()
                if not text:
                    continue
                probability = getattr(word, "probability", None)
                words.append(
                    Word(
                        s=_ms(getattr(word, "start", None), offset_ms),
                        e=_ms(getattr(word, "end", None), offset_ms),
                        t=text,
                        c=round(float(probability), 4) if probability is not None else None,
                    )
                )
            continue
        text = str(getattr(segment, "text", "")).strip()
        if text:
            words.append(
                Word(
                    s=_ms(getattr(segment, "start", None), offset_ms),
                    e=_ms(getattr(segment, "end", None), offset_ms),
                    t=text,
                )
            )
    return tuple(words)


class LocalWhisperProvider(Provider):
    """``faster-whisper`` with word timestamps on, run off the event loop."""

    name = "local-whisper"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe"}),
        word_timestamps=True,
        diarisation=False,
        max_duration_s=None,
        batch=False,
        languages=(),
    )

    #: Self-hosted compute, not a per-minute vendor price (`05 §12` counts it under
    #: the serverless GPU line); a local run costs the developer's own machine.
    cost_per_minute_inr = 0.0

    def __init__(
        self,
        *,
        model_name: str = "small",
        device: str = "cpu",
        compute_type: str = "int8",
        beam_size: int = 5,
        model_factory: Callable[[], WhisperModel] | None = None,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self._model_factory = model_factory
        self._model: WhisperModel | None = None
        self._lock = asyncio.Lock()

    async def _load(self) -> WhisperModel:
        """Load once, under a lock: two concurrent chunks must not both download."""
        async with self._lock:
            if self._model is None:
                self._model = await asyncio.to_thread(self._build)
            return self._model

    def _build(self) -> WhisperModel:
        if self._model_factory is not None:
            return self._model_factory()
        try:
            from faster_whisper import WhisperModel as FasterWhisperModel
        except ImportError as error:  # pragma: no cover - exercised by the slow test
            raise ProviderError(
                'faster-whisper is not installed; run pip install -e ".[local-asr]"',
                provider=self.name,
                retryable=False,
            ) from error
        _log.info(
            "loading faster-whisper",
            extra={"model": self.model_name, "device": self.device},
        )
        model: WhisperModel = FasterWhisperModel(
            self.model_name, device=self.device, compute_type=self.compute_type
        )
        return model

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        model = await self._load()
        options: dict[str, Any] = {
            "beam_size": self.beam_size,
            "word_timestamps": request.word_timestamps,
            "vad_filter": False,  # the worker has already run VAD (D14)
            **request.options,
        }
        if request.language:
            options["language"] = request.language
        if request.hints:
            # Whisper's only hotword mechanism is the decoder prompt (`09 §3`).
            options["initial_prompt"] = ", ".join(request.hints)

        try:
            segments, info = await asyncio.to_thread(model.transcribe, request.audio_uri, **options)
            words = await asyncio.to_thread(words_from_segments, segments, request.offset_ms)
        except ProviderError:
            raise
        except Exception as error:
            raise ProviderError(
                f"faster-whisper failed: {error}", provider=self.name, retryable=True
            ) from error

        language = str(getattr(info, "language", "") or request.language or "en")
        probability = getattr(info, "language_probability", None)
        seconds = float(getattr(info, "duration", 0.0) or 0.0)
        return TranscriptionResult(
            words=words,
            language=language,
            language_confidence=(round(float(probability), 4) if probability is not None else None),
            usage=ProviderUsage(
                media_seconds=seconds,
                provider=self.name,
                model=self.model_name,
                cost_minor=0,
            ),
            submissions=(
                # Local inference: nothing leaves the machine, but the row still
                # exists so an erasure sweep sees a complete picture of the job.
                ProviderSubmission(
                    provider=self.name,
                    endpoint="local://faster-whisper",
                    artefact=request.audio_uri,
                    retention_class="none",
                ),
            ),
            raw={"model": self.model_name, "device": self.device},
        )

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("local-whisper does not do forced alignment")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("local-whisper does not diarise")
