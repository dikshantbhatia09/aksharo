"""``ai.transcribe`` — the pipeline of `09 §1`, end to end.

```
audio16k.wav -> VAD -> chunk plan (D14) -> route (D12) -> per-chunk ASR
             -> alignment when the provider gives no word timings (D13)
             -> stable word ids -> post-process hook (A11) -> completion callback
```

**Where the transcript is persisted.** The brief allows either posting chunks to
`POST /internal/transcripts/{transcriptId}/chunks` or completing with the payload
and letting A11 wire persistence. That endpoint does not exist on `main` (A08's
internal surface is jobs and media only), so this processor takes the second
route: the chunks travel in ``result`` on the completion callback, which the API
already stores in ``jobs.result``. A11 changes one function — :func:`_result` —
and nothing else, because the shape below is already the shape of
``transcript_chunks`` (`06`).

**Parallelism.** Chunks run through a semaphore rather than a gather, because ten
minutes of audio per chunk against a per-second GPU is exactly the workload that
turns "fan out everything" into a rate-limit incident (`09 §9`).
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from worker_ai.alignment.base import Aligner
from worker_ai.audio import cut_wav
from worker_ai.callbacks import JobUsage
from worker_ai.chunking import ChunkPlanEntry, plan_chunks
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.processors.media import MediaAudio, load_audio, speech_regions
from worker_ai.providers.base import (
    AlignmentRequest,
    Provider,
    ProviderError,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)
from worker_ai.providers.registry import ProviderUnavailableError
from worker_ai.routing import RoutingDecision, RoutingError, resolve
from worker_ai.transcript import TranscriptChunk, assemble_chunk, identity_post_process
from worker_ai.vad import SpeechRegion

__all__ = ["MAX_CHUNK_PARALLELISM", "process_transcribe", "transcribe_usage"]

_log = get_logger(__name__)

#: Chunks in flight per job. Four ten-minute chunks is 40 minutes of audio being
#: decoded at once, which saturates a serverless instance without queueing on it.
MAX_CHUNK_PARALLELISM = 4


async def process_transcribe(context: JobContext) -> ProcessorOutcome:
    """Transcribe one media asset into :class:`TranscriptChunk` values."""
    await context.progress(2, message="fetching audio")
    audio = load_audio(context)

    plan, regions = _plan(context, audio)
    decision = _route(context)
    provider = await _provider(context, decision)

    _log.info(
        "transcribe routed",
        extra={
            **context.envelope.log_fields(),
            "mediaId": audio.media_id,
            "chunks": len(plan),
            **decision.to_wire(),
        },
    )

    aligner = _aligner(context, decision, _language_hint(context))
    results = await _run_chunks(context, audio, plan, provider, decision, regions, aligner)

    language = _detected_language(results, _language_hint(context))
    chunks = tuple(
        assemble_chunk(
            entry,
            result.words,
            language=language,
            post_process=identity_post_process,
        )
        for entry, result in zip(plan, results, strict=True)
    )

    await context.progress(98, message="assembling transcript")
    return ProcessorOutcome(
        result=_result(context, audio, chunks, decision, results, language),
        usage=transcribe_usage(audio, decision, results),
    )


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------


def _language_hint(context: JobContext) -> str | None:
    """The caller's language hint, if any. Real LID (two-signal, D14) is A10."""
    return context.payload_str("language") or None


def _plan(
    context: JobContext, audio: MediaAudio
) -> tuple[tuple[ChunkPlanEntry, ...], tuple[SpeechRegion, ...]]:
    """Use the plan the payload carries, or run VAD and make one."""
    supplied = context.envelope.payload.get("chunkPlan")
    regions = _supplied_regions(context)
    if isinstance(supplied, list) and supplied:
        return _parse_plan(supplied), regions

    if not regions:
        regions = speech_regions(context, audio)
    plan = plan_chunks(audio.duration_ms, regions)
    if not plan:
        raise JobFailureError("worker/empty_media", "the audio is empty", retryable=False)
    return plan, regions


def _supplied_regions(context: JobContext) -> tuple[SpeechRegion, ...]:
    raw = context.envelope.payload.get("regions")
    if not isinstance(raw, list):
        return ()
    regions: list[SpeechRegion] = []
    for item in raw:
        if isinstance(item, dict) and "startMs" in item and "endMs" in item:
            regions.append(SpeechRegion(start_ms=int(item["startMs"]), end_ms=int(item["endMs"])))
    return tuple(regions)


def _parse_plan(raw: list[Any]) -> tuple[ChunkPlanEntry, ...]:
    entries: list[ChunkPlanEntry] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise JobFailureError(
                "worker/invalid_payload", "chunkPlan entries must be objects", retryable=False
            )
        try:
            entries.append(
                ChunkPlanEntry(
                    chunk_idx=int(item.get("chunkIdx", index)),
                    start_ms=int(item["startMs"]),
                    end_ms=int(item["endMs"]),
                )
            )
        except (KeyError, TypeError, ValueError) as error:
            raise JobFailureError(
                "worker/invalid_payload",
                "a chunkPlan entry is missing startMs or endMs",
                retryable=False,
            ) from error
    return tuple(entries)


def _route(context: JobContext) -> RoutingDecision:
    """Pick a provider from ``routing.yaml`` (D12)."""
    code_mix = bool(context.envelope.payload.get("codeMix", False))
    try:
        return resolve(
            context.services.routing,
            context.services.providers,
            language=_language_hint(context),
            code_mix=code_mix,
        )
    except RoutingError as error:
        raise JobFailureError("worker/no_provider", str(error), retryable=False) from error


async def _provider(context: JobContext, decision: RoutingDecision) -> Provider:
    try:
        return await context.services.providers.get(decision.candidate.provider)
    except ProviderUnavailableError as error:  # pragma: no cover - resolve() already checked
        raise JobFailureError("worker/no_provider", str(error), retryable=False) from error


def _aligner(
    context: JobContext, decision: RoutingDecision, language: str | None
) -> Aligner | None:
    """The aligner to run behind a provider that returns no word timings (D13)."""
    if not decision.needs_alignment:
        return None
    return context.services.aligners.resolve(language or "en")


async def _run_chunks(
    context: JobContext,
    audio: MediaAudio,
    plan: tuple[ChunkPlanEntry, ...],
    provider: Provider,
    decision: RoutingDecision,
    regions: tuple[SpeechRegion, ...],
    aligner: Aligner | None,
) -> tuple[TranscriptionResult, ...]:
    """Transcribe every chunk with bounded parallelism, in plan order."""
    semaphore = asyncio.Semaphore(MAX_CHUNK_PARALLELISM)
    done = 0
    total = len(plan)
    lock = asyncio.Lock()

    async def one(entry: ChunkPlanEntry) -> TranscriptionResult:
        nonlocal done
        async with semaphore:
            result = await _transcribe_chunk(
                context, audio, entry, provider, decision, regions, aligner
            )
        async with lock:
            done += 1
            # 10 % for fetch and plan, 85 % for the chunks, 5 % for assembly.
            await context.progress(
                10 + 85 * done / total, message=f"transcribed {done}/{total} chunks"
            )
        return result

    async def beat() -> None:
        """Keep the lock alive while a ten-minute chunk is in a provider (A08b)."""
        while True:
            await asyncio.sleep(context.heartbeat_interval_s)
            await context.heartbeat(f"transcribing ({done}/{total} chunks done)")

    heartbeat = asyncio.create_task(beat())
    try:
        return tuple(await asyncio.gather(*(one(entry) for entry in plan)))
    finally:
        heartbeat.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat


async def _transcribe_chunk(
    context: JobContext,
    audio: MediaAudio,
    entry: ChunkPlanEntry,
    provider: Provider,
    decision: RoutingDecision,
    regions: tuple[SpeechRegion, ...],
    aligner: Aligner | None,
) -> TranscriptionResult:
    """One chunk: cut it, transcribe it, align it when the provider cannot."""
    audio_uri = str(audio.path)
    if _needs_cutting(entry, audio):
        chunk_path = context.workdir / f"chunk-{entry.chunk_idx:04d}.wav"
        await asyncio.to_thread(
            cut_wav,
            audio.path,
            chunk_path,
            start_ms=entry.start_ms,
            end_ms=entry.end_ms,
        )
        audio_uri = str(chunk_path)

    request = TranscriptionRequest(
        audio_uri=audio_uri,
        language=_language_hint(context),
        word_timestamps=True,
        hints=_hints(context),
        # The provider sees a chunk starting at zero; the caller shifts it back
        # into file time, which is why word ids and timings stay consistent.
        offset_ms=entry.start_ms,
        options=decision.candidate.provider_options(),
    )

    try:
        result = await provider.transcribe(request)
    except ProviderError as error:
        raise JobFailureError(
            "worker/provider_failed",
            f"{error.provider}: {error}",
            retryable=error.retryable,
        ) from error
    except NotImplementedError as error:
        raise JobFailureError(
            "worker/no_provider",
            f"{provider.name} cannot transcribe: {error}",
            retryable=False,
        ) from error

    context.record(result.submissions)

    if result.words:
        return result
    if aligner is None or not result.segments:
        return result
    return await _align_segments(result, aligner, regions, entry)


def _needs_cutting(entry: ChunkPlanEntry, audio: MediaAudio) -> bool:
    """False when the chunk *is* the whole file, so ffmpeg is never invoked for it."""
    return not (entry.start_ms == 0 and entry.end_ms >= audio.duration_ms)


async def _align_segments(
    result: TranscriptionResult,
    aligner: Aligner,
    regions: tuple[SpeechRegion, ...],
    entry: ChunkPlanEntry,
) -> TranscriptionResult:
    """Turn segment-level text into words (the Sarvam path, `09 §1`)."""
    words: list[Word] = []
    for start_ms, end_ms, text in result.segments:
        tokens = tuple(token for token in text.split() if token)
        if not tokens:
            continue
        aligned = await aligner.align(
            AlignmentRequest(
                audio_uri="",
                words=tokens,
                language=result.language,
                start_ms=max(start_ms, entry.start_ms),
                end_ms=min(end_ms, entry.end_ms),
            ),
            regions,
        )
        words.extend(aligned)
    return TranscriptionResult(
        words=tuple(words),
        language=result.language,
        language_confidence=result.language_confidence,
        usage=result.usage,
        segments=result.segments,
        submissions=result.submissions,
        raw={**result.raw, "aligner": aligner.name},
    )


def _hints(context: JobContext) -> tuple[str, ...]:
    """Glossary terms from the payload (B09 supplies them for real)."""
    raw = context.envelope.payload.get("hints")
    if isinstance(raw, list):
        return tuple(str(item) for item in raw if str(item).strip())
    return ()


def _detected_language(results: tuple[TranscriptionResult, ...], hint: str | None) -> str:
    """The language of the chunk with the most words — the file's language."""
    if hint:
        return hint
    best = ""
    best_words = -1
    for result in results:
        if len(result.words) > best_words:
            best = result.language
            best_words = len(result.words)
    return best or "en"


def transcribe_usage(
    audio: MediaAudio, decision: RoutingDecision, results: tuple[TranscriptionResult, ...]
) -> JobUsage:
    """``usage`` for the completion callback: what this job actually consumed."""
    seconds = audio.duration_ms / 1000
    cost = sum(
        result.usage.cost_minor
        for result in results
        if result.usage is not None and result.usage.cost_minor is not None
    )
    return JobUsage(
        media_seconds=seconds,
        provider=decision.candidate.provider,
        model=decision.candidate.model,
        cost_minor=cost,
        egress_bytes=audio.size_bytes,
    )


def _result(
    context: JobContext,
    audio: MediaAudio,
    chunks: tuple[TranscriptChunk, ...],
    decision: RoutingDecision,
    results: tuple[TranscriptionResult, ...],
    language: str,
) -> dict[str, Any]:
    """The completion ``result``. A11 reads this shape into ``transcript_chunks``."""
    transcript_id = context.payload_str("transcriptId")
    payload: dict[str, Any] = {
        "mediaId": audio.media_id,
        "language": language,
        "provider": decision.candidate.provider,
        "model": decision.candidate.model,
        "lane": decision.lane.id,
        "durationMs": audio.duration_ms,
        "wordCount": sum(len(chunk.words) for chunk in chunks),
        "chunks": [chunk.to_wire() for chunk in chunks],
        "providerSubmissions": context.submissions_wire(),
    }
    if transcript_id:
        payload["transcriptId"] = transcript_id
    aligner = next(
        (str(result.raw["aligner"]) for result in results if "aligner" in result.raw), None
    )
    if aligner is not None:
        payload["alignerModel"] = aligner
    return payload
