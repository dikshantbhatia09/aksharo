"""faster-whisper ``large-v3-turbo`` (CTranslate2) — ``/transcribe`` and the LID half.

Decision **D15** names the checkpoint and RR-07 names the runtime: faster-whisper
over CTranslate2 rather than whisper.cpp, because the server lane wants batched
GPU throughput and the desktop lane (C03) wants a single-file CPU binary. They
are different products with the same weights.

## What "batched" means here, precisely

``DynamicBatcher`` hands this backend a group of chunks as one call. CTranslate2
batches *within* one audio through ``BatchedInferencePipeline`` — its public API
takes one audio at a time — so the group is executed inside a single hand-off
under a single model lock, with ``batch_size`` set to the group size so the card
stays saturated across each item's internal VAD segments.

What that does and does not buy is worth being exact about, because ``COST.md``
depends on the answer:

* **It does buy** the elimination of per-request lock and context churn, an
  encoder warm-up amortised across the group, and a GPU that is not idle between
  two requests that arrived 5 ms apart.
* **It does not buy** cross-request tensor fusion. faster-whisper exposes no way
  to concatenate two *different* audios into one decoder call, and forcing it by
  padding them into one array would corrupt the timings that are the entire point
  of this endpoint.

``model_server_batch_size`` measures what actually happened, so the first real
GPU run replaces this paragraph's reasoning with a number (``cost.md``).

## Compute type

``float16`` on a card, ``int8`` on CPU. int8 on CPU is not a quality choice, it
is the only setting under which ``tiny`` finishes a five-second clip fast enough
to sit in a test suite; the CUDA image never uses it.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Sequence
from typing import Any

import numpy as np
from numpy.typing import NDArray

from model_server.logging_setup import get_logger
from model_server.models.base import (
    AsrBackend,
    DetectJob,
    LanguageVerdict,
    SegmentTiming,
    TranscribeJob,
    TranscribeOutput,
    WordTiming,
)

__all__ = ["FasterWhisperAsr"]

_log = get_logger(__name__)

#: `09 §1` identifies language from a 60 s window plus two 15 s windows; when the
#: caller names no window at all the brief's default is the first 30 s.
DEFAULT_LID_WINDOW_S = 30.0


class FasterWhisperAsr(AsrBackend):
    """The real ASR backend. Imports faster-whisper lazily, loads once at startup."""

    kind = "asr"
    licence = "MIT (faster-whisper); OpenAI Whisper weights, MIT"

    def __init__(
        self,
        model_id: str = "large-v3-turbo",
        *,
        device: str = "cuda",
        compute_type: str = "float16",
        download_root: str = "",
        cpu_threads: int = 0,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.compute_type = compute_type
        self.download_root = download_root
        self.cpu_threads = cpu_threads
        self._model: Any = None
        self._pipeline: Any = None
        # CTranslate2 is thread-safe per model, but one lock keeps a batch's items
        # contiguous on the card instead of interleaved with another batch's.
        self._lock = threading.Lock()

    # -- lifecycle ----------------------------------------------------------

    def unavailable(self) -> str | None:
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return (
                "faster-whisper is not installed; install the 'asr' extra "
                "(pip install -r requirements.lock)"
            )
        return None

    def load(self) -> None:
        """Instantiate the model. Called once, at startup, from the baked cache."""
        reason = self.unavailable()
        if reason is not None:
            raise RuntimeError(reason)
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        started = time.perf_counter()
        options: dict[str, Any] = {"device": self.device, "compute_type": self.compute_type}
        if self.download_root:
            options["download_root"] = self.download_root
        if self.cpu_threads:
            options["cpu_threads"] = self.cpu_threads
        self._model = WhisperModel(self.model_id, **options)
        self._pipeline = BatchedInferencePipeline(model=self._model)
        self._ready = True
        _log.info(
            "whisper loaded",
            extra={
                "model": self.model_id,
                "device": self.device,
                "computeType": self.compute_type,
                "loadSeconds": round(time.perf_counter() - started, 3),
            },
        )

    def unload(self) -> None:
        self._ready = False
        self._pipeline = None
        self._model = None

    # -- transcription ------------------------------------------------------

    def transcribe(self, jobs: Sequence[TranscribeJob]) -> list[TranscribeOutput]:
        """The whole group, in one lock hold, in submission order."""
        if not jobs:
            return []
        if self._model is None:
            raise RuntimeError("the ASR model is not loaded")
        with self._lock:
            return [self._transcribe_one(job, batch_size=len(jobs)) for job in jobs]

    def _transcribe_one(self, job: TranscribeJob, *, batch_size: int) -> TranscribeOutput:
        audio = _as_float32(job.samples)
        options: dict[str, Any] = {
            "word_timestamps": job.word_timestamps,
            "beam_size": job.beam_size,
            "temperature": list(job.temperature),
            "condition_on_previous_text": job.condition_on_previous_text,
        }
        if job.language:
            options["language"] = job.language
        if job.initial_prompt:
            options["initial_prompt"] = job.initial_prompt

        # The batched pipeline needs its own VAD to find segments to batch; when
        # the caller has already VAD-trimmed the chunk (`09 §1`), the sequential
        # path is both correct and faster.
        if job.vad_filter and self._pipeline is not None and batch_size > 1:
            segments, info = self._pipeline.transcribe(
                audio, vad_filter=True, batch_size=batch_size, **options
            )
        else:
            segments, info = self._model.transcribe(audio, vad_filter=job.vad_filter, **options)

        words: list[WordTiming] = []
        utterances: list[SegmentTiming] = []
        for segment in segments:
            text = str(getattr(segment, "text", "") or "").strip()
            if text:
                utterances.append(
                    SegmentTiming(
                        start=float(getattr(segment, "start", 0.0) or 0.0),
                        end=float(getattr(segment, "end", 0.0) or 0.0),
                        text=text,
                    )
                )
            for word in getattr(segment, "words", None) or ():
                token = str(getattr(word, "word", "") or "").strip()
                if not token:
                    continue
                words.append(
                    WordTiming(
                        start=float(getattr(word, "start", 0.0) or 0.0),
                        end=float(getattr(word, "end", 0.0) or 0.0),
                        word=token,
                        probability=round(float(getattr(word, "probability", 1.0) or 0.0), 4),
                    )
                )

        duration = float(getattr(info, "duration", 0.0) or 0.0)
        if duration <= 0 and job.sample_rate > 0:
            duration = len(audio) / job.sample_rate
        return TranscribeOutput(
            language=str(getattr(info, "language", "") or job.language or "en"),
            language_probability=round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
            duration_s=round(duration, 3),
            words=tuple(words),
            segments=tuple(utterances),
        )

    # -- language identification -------------------------------------------

    def detect_language(self, job: DetectJob) -> list[LanguageVerdict]:
        """One verdict per requested window, or one over the first 30 s."""
        if self._model is None:
            raise RuntimeError("the ASR model is not loaded")
        audio = _as_float32(job.samples)
        rate = job.sample_rate or 16_000
        total_ms = round(1000 * len(audio) / rate)
        windows = job.windows or ((0, min(total_ms, int(DEFAULT_LID_WINDOW_S * 1000))),)

        verdicts: list[LanguageVerdict] = []
        with self._lock:
            for start_ms, end_ms in windows:
                begin = max(0, int(start_ms * rate / 1000))
                stop = min(len(audio), max(begin, int(end_ms * rate / 1000)))
                span = audio[begin:stop]
                if len(span) == 0:
                    verdicts.append(
                        LanguageVerdict(
                            language="", probability=0.0, start_ms=start_ms, end_ms=end_ms
                        )
                    )
                    continue
                language, probability = _detect(self._model, span)
                verdicts.append(
                    LanguageVerdict(
                        language=language,
                        probability=round(probability, 4),
                        start_ms=start_ms,
                        end_ms=min(end_ms, total_ms),
                    )
                )
        return verdicts


def _detect(model: Any, span: NDArray[np.float32]) -> tuple[str, float]:
    """One ``detect_language`` call, shape-tolerant because the API has changed.

    faster-whisper has returned a 2-tuple, a 3-tuple and a dict across versions;
    ``apps/worker-ai/worker_ai/lid.py`` carries the same tolerance for the same
    reason, and neither place is the right one to pin a vendor's return shape.
    """
    result = model.detect_language(span)
    if isinstance(result, tuple | list) and len(result) >= 2:
        return str(result[0] or ""), float(result[1] or 0.0)
    if isinstance(result, dict):
        return str(result.get("language") or ""), float(result.get("probability") or 0.0)
    return str(result or ""), 1.0


def _as_float32(samples: NDArray[np.float32]) -> NDArray[np.float32]:
    """CTranslate2 wants a contiguous float32 array; a view is not enough."""
    return np.ascontiguousarray(samples, dtype=np.float32)
