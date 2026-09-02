"""The four operations, once, for both the HTTP lane and the RunPod queue lane.

``routes/`` is HTTP plumbing and ``runpod_handler.py`` is queue plumbing; the
work is here, so the two lanes cannot drift into two different contracts. Every
operation follows the same five steps:

1. **Check the backend is resident** — never load one here (``models/registry.py``).
2. **Decode the audio** off the event loop, with a byte cap and a duration cap.
3. **Reserve memory**, or refuse with 503 + ``Retry-After`` (``memory.py``).
4. **Run the model.** ``/transcribe`` goes through the dynamic batcher (D74);
   ``/align`` and ``/diarise`` do not — alignment is milliseconds of Viterbi
   against a chunk already transcribed, and diarisation is one whole-file call
   whose memory footprint makes a second concurrent one a bad idea.
5. **Account for it**: ``usage`` on the response, counters on the registry.

## Attributing GPU seconds inside a batch

A group of four chunks that took 8 s of wall clock did not cost 32 GPU-seconds;
it cost 8, and each request is charged 2. So ``usage.gpuSeconds`` is
``compute_s / batch_size`` and ``usage.batchSize`` is on the wire beside it so the
division can be audited. Charging each request the full group duration would
inflate the COGS-per-credit panel by exactly the batching factor — that is,
precisely the number D74 is trying to measure.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from model_server.audio import Pcm, load_audio
from model_server.batching import Batched, DynamicBatcher
from model_server.errors import ModelUnavailableError, OverloadedError
from model_server.logging_setup import get_logger, safe_uri
from model_server.memory import MemoryGuard
from model_server.metrics import Metrics
from model_server.models.base import (
    AlignJob,
    DetectJob,
    DiariseJob,
    TranscribeJob,
    TranscribeOutput,
)
from model_server.models.registry import ModelRegistry
from model_server.schemas import (
    AlignRequest,
    AlignResponse,
    DetectLanguageRequest,
    DetectLanguageResponse,
    DiariseRequest,
    DiariseResponse,
    LanguageWindow,
    SpeakerTurnOut,
    TranscribeRequest,
    TranscribeResponse,
    TranscriptSegment,
    TranscriptWord,
    Usage,
)
from model_server.settings import Settings

__all__ = ["ModelService", "new_request_id"]

_log = get_logger(__name__)

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

#: Whole-file diarisation holds embeddings over the entire file, so it asks the
#: memory guard for more per audio-second than one Whisper chunk does.
DIARISE_MEMORY_FACTOR = 2.0

#: Forced alignment is a Viterbi pass over an emission matrix: cheap next to ASR.
ALIGN_MEMORY_FACTOR = 0.5


def new_request_id() -> str:
    """A ULID-shaped id: 48 bits of time, 80 bits of randomness, Crockford base32.

    CONTRACTS section 0 says ids are ULIDs. Pulling a dependency in for 15 lines
    of base32 would be the more surprising choice on a per-second GPU image where
    every megabyte of layer is paid for on every cold start.
    """
    value = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")
    out = [""] * 26
    for index in range(25, -1, -1):
        out[index] = _CROCKFORD[value & 0x1F]
        value >>= 5
    return "".join(out)


@dataclass(frozen=True, slots=True)
class _Decoded:
    """Audio plus the memory the guard is holding for it."""

    pcm: Pcm
    audio_seconds: float


class ModelService:
    """Warm models, one batcher, one memory guard — the state a worker holds."""

    def __init__(
        self,
        settings: Settings,
        registry: ModelRegistry,
        metrics: Metrics,
        *,
        guard: MemoryGuard | None = None,
    ) -> None:
        self.settings = settings
        self.registry = registry
        self.metrics = metrics
        self.guard = guard or MemoryGuard(
            budget_bytes=settings.memory_budget_bytes,
            bytes_per_audio_second=settings.memory_bytes_per_audio_second,
            retry_after_s=settings.memory_retry_after_s,
        )
        self.metrics.memory_budget.set(self.guard.budget_bytes)
        self._transcribe_batcher: DynamicBatcher[TranscribeJob, TranscribeOutput] = DynamicBatcher(
            self._run_transcribe_batch,
            max_size=settings.batch_max_size,
            window_s=settings.batch_window_s,
            name="transcribe",
        )
        self.draining = False

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Start the batch consumer. Called from the app's lifespan startup."""
        self._transcribe_batcher.start()

    async def aclose(self) -> None:
        """Drain the batcher and release the models."""
        self.draining = True
        self.metrics.draining.set(1.0)
        await self._transcribe_batcher.aclose()
        self.registry.unload()

    @property
    def device(self) -> str:
        return self.settings.device

    # -- shared helpers -----------------------------------------------------

    async def _decode(self, audio: str) -> _Decoded:
        """Resolve and decode the audio off the event loop."""
        pcm = await asyncio.to_thread(
            load_audio,
            audio,
            max_bytes=self.settings.max_body_bytes,
            max_seconds=self.settings.max_audio_seconds,
        )
        return _Decoded(pcm=pcm, audio_seconds=pcm.duration_s)

    def _require(self, kind: str) -> None:
        """Refuse cleanly when a backend is not resident, with the reason why."""
        backend = self.registry.backends().get(kind)
        if backend is None:
            raise ModelUnavailableError(
                "this worker has no " + kind + " backend configured",
                retry_after_s=self.settings.memory_retry_after_s,
            )
        if not backend.ready:
            status = self.registry.statuses.get(kind)
            reason = (status.error if status else "") or "the model is still loading"
            raise ModelUnavailableError(
                kind + " is not available on this worker: " + reason,
                retry_after_s=self.settings.memory_retry_after_s,
            )

    def _refuse_when_draining(self) -> None:
        if self.draining:
            raise OverloadedError(
                "this worker is draining; retry against another one",
                retry_after_s=max(1, int(self.settings.drain_timeout_s)),
            )

    def _usage(
        self, *, route: str, model: str, audio_seconds: float, compute_s: float, batch_size: int
    ) -> Usage:
        """One request's share of the model call, and the counters that prove it."""
        attributed = round(compute_s / max(1, batch_size), 4)
        self.metrics.observe_usage(
            route=route,
            model=model,
            device=self.device,
            audio_seconds=audio_seconds,
            compute_seconds=attributed,
        )
        self.metrics.batch_size.labels(route=route, model=model).observe(batch_size)
        return Usage(
            gpu_seconds=attributed,
            audio_seconds=round(audio_seconds, 3),
            model=model,
            batch_size=batch_size,
        )

    # -- /transcribe --------------------------------------------------------

    async def _run_transcribe_batch(self, jobs: Sequence[TranscribeJob]) -> list[TranscribeOutput]:
        """The batcher's callback: one hand-off to the ASR backend, off the loop."""
        backend = self.registry.asr
        if backend is None:  # pragma: no cover - guarded by _require before submit
            raise ModelUnavailableError("no ASR backend is configured")
        return await asyncio.to_thread(backend.transcribe, jobs)

    async def transcribe(self, request: TranscribeRequest) -> TranscribeResponse:
        """One VAD-trimmed chunk in, a transcript chunk plus usage out."""
        self._refuse_when_draining()
        self._require("asr")
        decoded = await self._decode(request.audio)
        backend = self.registry.asr
        assert backend is not None  # noqa: S101 - _require proved it a line ago

        job = TranscribeJob(
            samples=decoded.pcm.samples,
            sample_rate=decoded.pcm.sample_rate,
            language=request.language,
            beam_size=request.beam_size,
            temperature=request.temperatures(),
            initial_prompt=request.prompt(),
            word_timestamps=request.word_timestamps,
            vad_filter=request.vad_filter,
            condition_on_previous_text=request.condition_on_previous_text,
        )

        with self.guard.reserve(decoded.audio_seconds):
            self.metrics.memory_reserved.set(self.guard.reserved_bytes)
            batched: Batched[TranscribeOutput] = await self._transcribe_batcher.submit(job)
        self.metrics.memory_reserved.set(self.guard.reserved_bytes)
        self.metrics.batch_wait.labels(route="/transcribe").observe(batched.wait_s)

        output = batched.result
        audio_seconds = output.duration_s or decoded.audio_seconds
        _log.info(
            "transcribed",
            extra={
                "route": "/transcribe",
                "model": backend.model_id,
                "audioSeconds": round(audio_seconds, 2),
                "batchSize": batched.batch_size,
                "wordCount": len(output.words),
                "language": output.language,
                "source": safe_uri(request.audio),
            },
        )
        return TranscribeResponse(
            language=output.language,
            language_probability=output.language_probability,
            duration_s=round(audio_seconds, 3),
            model=backend.model_id,
            request_id=new_request_id(),
            words=[
                TranscriptWord(
                    start=word.start, end=word.end, word=word.word, probability=word.probability
                )
                for word in output.words
            ],
            segments=[
                TranscriptSegment(start=item.start, end=item.end, text=item.text)
                for item in output.segments
            ],
            engine_versions=self.registry.engine_versions(),
            usage=self._usage(
                route="/transcribe",
                model=backend.model_id,
                audio_seconds=audio_seconds,
                compute_s=batched.compute_s,
                batch_size=batched.batch_size,
            ),
        )

    # -- /align -------------------------------------------------------------

    async def align(self, request: AlignRequest) -> AlignResponse:
        """Force known words onto a span of audio (decision **D77**)."""
        self._refuse_when_draining()
        self._require("align")
        aligner = self.registry.aligner
        assert aligner is not None  # noqa: S101 - _require proved it a line ago

        reason = aligner.unavailable_for(request.language)
        if reason is not None:
            raise ModelUnavailableError(
                "no forced aligner for " + (request.language or "(unnamed)") + ": " + reason
            )

        decoded = await self._decode(request.audio)
        span = decoded.pcm.slice_s(request.start_s, request.end_s)
        span_seconds = span.duration_s
        job = AlignJob(
            samples=span.samples,
            sample_rate=span.sample_rate,
            words=tuple(request.words),
            language=request.language,
            start_s=request.start_s,
        )

        started = time.perf_counter()
        with self.guard.reserve(span_seconds, factor=ALIGN_MEMORY_FACTOR):
            self.metrics.memory_reserved.set(self.guard.reserved_bytes)
            output = await asyncio.to_thread(aligner.align, job)
        self.metrics.memory_reserved.set(self.guard.reserved_bytes)
        compute_s = time.perf_counter() - started

        _log.info(
            "aligned",
            extra={
                "route": "/align",
                "model": output.model_id,
                "language": request.language,
                "audioSeconds": round(span_seconds, 2),
                "wordCount": len(output.words),
                "skippedCount": len(output.skipped),
                "source": safe_uri(request.audio),
            },
        )
        return AlignResponse(
            language=request.language,
            model=output.model_id,
            licence=output.licence,
            duration_s=round(span_seconds, 3),
            request_id=new_request_id(),
            words=[
                TranscriptWord(
                    start=word.start, end=word.end, word=word.word, probability=word.probability
                )
                for word in output.words
            ],
            skipped=list(output.skipped),
            engine_versions=self.registry.engine_versions(),
            usage=self._usage(
                route="/align",
                model=output.model_id,
                audio_seconds=span_seconds,
                compute_s=compute_s,
                batch_size=1,
            ),
        )

    # -- /diarise -----------------------------------------------------------

    async def diarise(self, request: DiariseRequest) -> DiariseResponse:
        """Whole-file speaker turns, with the CC-BY-4.0 attribution attached."""
        self._refuse_when_draining()
        self._require("diarise")
        diariser = self.registry.diariser
        assert diariser is not None  # noqa: S101 - _require proved it a line ago

        decoded = await self._decode(request.audio)
        job = DiariseJob(
            samples=decoded.pcm.samples,
            sample_rate=decoded.pcm.sample_rate,
            num_speakers=request.num_speakers,
            min_speakers=request.min_speakers,
            max_speakers=request.max_speakers,
        )

        started = time.perf_counter()
        with self.guard.reserve(decoded.audio_seconds, factor=DIARISE_MEMORY_FACTOR):
            self.metrics.memory_reserved.set(self.guard.reserved_bytes)
            turns = await asyncio.to_thread(diariser.diarise, job)
        self.metrics.memory_reserved.set(self.guard.reserved_bytes)
        compute_s = time.perf_counter() - started

        _log.info(
            "diarised",
            extra={
                "route": "/diarise",
                "model": diariser.model_id,
                "audioSeconds": round(decoded.audio_seconds, 2),
                "turnCount": len(turns),
                "speakerCount": len({turn.speaker for turn in turns}),
                "source": safe_uri(request.audio),
            },
        )
        return DiariseResponse(
            model=diariser.model_id,
            turns=[
                SpeakerTurnOut(
                    speaker=turn.speaker,
                    start=turn.start,
                    end=turn.end,
                    confidence=turn.confidence,
                )
                for turn in turns
            ],
            request_id=new_request_id(),
            duration_s=round(decoded.audio_seconds, 3),
            engine_versions=self.registry.engine_versions(),
            usage=self._usage(
                route="/diarise",
                model=diariser.model_id,
                audio_seconds=decoded.audio_seconds,
                compute_s=compute_s,
                batch_size=1,
            ),
        )

    # -- /detect-language ---------------------------------------------------

    async def detect_language(self, request: DetectLanguageRequest) -> DetectLanguageResponse:
        """Whisper LID over the caller's windows, or the first 30 s by default."""
        self._refuse_when_draining()
        self._require("asr")
        backend = self.registry.asr
        assert backend is not None  # noqa: S101 - _require proved it a line ago

        decoded = await self._decode(request.audio)
        job = DetectJob(
            samples=decoded.pcm.samples,
            sample_rate=decoded.pcm.sample_rate,
            windows=request.window_pairs(),
        )

        started = time.perf_counter()
        with self.guard.reserve(decoded.audio_seconds, factor=ALIGN_MEMORY_FACTOR):
            self.metrics.memory_reserved.set(self.guard.reserved_bytes)
            verdicts = await asyncio.to_thread(backend.detect_language, job)
        self.metrics.memory_reserved.set(self.guard.reserved_bytes)
        compute_s = time.perf_counter() - started

        language, probability = _pool(
            [
                (verdict.language, verdict.probability, verdict.end_ms - verdict.start_ms)
                for verdict in verdicts
            ]
        )
        _log.info(
            "language detected",
            extra={
                "route": "/detect-language",
                "model": backend.model_id,
                "language": language,
                "probability": probability,
                "windowCount": len(verdicts),
                "source": safe_uri(request.audio),
            },
        )
        return DetectLanguageResponse(
            language=language,
            probability=probability,
            model=backend.model_id,
            request_id=new_request_id(),
            windows=[
                LanguageWindow(
                    start_ms=verdict.start_ms,
                    end_ms=verdict.end_ms,
                    language=verdict.language,
                    probability=verdict.probability,
                )
                for verdict in verdicts
            ],
            text_signal=request.text_signal,
            engine_versions=self.registry.engine_versions(),
            usage=self._usage(
                route="/detect-language",
                model=backend.model_id,
                audio_seconds=decoded.audio_seconds,
                compute_s=compute_s,
                batch_size=1,
            ),
        )

    # -- introspection ------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """What ``/readyz`` reports: models, batch depth and the memory ledger."""
        payload = dict(self.registry.status_payload())
        payload["draining"] = self.draining
        payload["batch"] = {
            "depth": self._transcribe_batcher.depth,
            "maxSize": self.settings.batch_max_size,
            "windowMs": self.settings.batch_window_ms,
        }
        payload["memory"] = {
            "reservedBytes": self.guard.reserved_bytes,
            "budgetBytes": self.guard.budget_bytes,
        }
        return payload


def _pool(verdicts: list[tuple[str, float, int]]) -> tuple[str, float]:
    """Pool per-window verdicts into one, weighted by window length.

    `09 §1` identifies language from a 60 s window plus two 15 s windows and
    never lets one of them decide alone. Weighting by duration is what stops a
    confident 2-second window from outvoting a hesitant minute.
    """
    weighted: dict[str, float] = {}
    spans: dict[str, float] = {}
    for language, probability, span_ms in verdicts:
        if not language:
            continue
        weight = max(1.0, float(span_ms))
        weighted[language] = weighted.get(language, 0.0) + probability * weight
        spans[language] = spans.get(language, 0.0) + weight
    if not weighted:
        return "", 0.0
    best = max(weighted, key=lambda key: weighted[key])
    return best, round(weighted[best] / spans[best], 4)
