"""``ai.transcribe`` — the pipeline of `09 §1`, end to end.

```
audio16k.wav -> VAD -> chunk plan (D14) -> provisional route (D12)
             -> probe the first chunk -> two-signal LID (D14) -> final route
             -> per-chunk ASR (or one Batch job) with the cache in front
             -> alignment where the provider gives no word timings (D13)
             -> diarisation, globally, unless the provider already labelled words
             -> stable word ids -> post-process hook (A11) -> completion callback
```

Four things here are decisions rather than plumbing, and each is worth a
paragraph.

**Routing is a chain, not a choice.** ``resolve_chain`` returns every candidate
this deployment can run, primary first. A chunk that fails with a
:class:`ProviderError` — a 429 that outlasted its backoff, a vendor rejecting the
audio, an outage — advances to the next candidate and is retried there, once per
candidate, and the fallback is counted. Only an exhausted chain fails the job.

**LID costs one chunk, not one extra vendor call.** The first chunk is
transcribed on the provisional lane and *that result is the acoustic signal*
(D14's "provider LID"); the local classifier reads its text. If the two signals
move the job to a different provider, the chunk is transcribed again on the new
lane and the first result is discarded — one wasted chunk, once, and only when
the language was not what the hint said. If the decision does not change the
provider, the probe result is kept and nothing is wasted.

**Sarvam is whole-file.** A lane marked ``api: batch`` sends the entire file (≤ 2
h) as one vendor job and splits the returned chunk-level segments back across the
D14 chunk boundaries — because Sarvam's REST endpoint caps at 30 s and its Batch
endpoint is per file, not per chunk (RR-02 F1). Everything else fans out over
chunks, bounded by the vendor's rate limit.

**No overlap de-duplication.** D14 cuts chunks at silence, so chunks do not
overlap and the merge is a concatenation. There is no Levenshtein pass here and
there must never be one.

Where the transcript is persisted: `POST /internal/transcripts/...` does not exist
on ``main``, so the chunks travel in ``result`` on the completion callback, which
the API stores in ``jobs.result``. A11 changes one function — :func:`_result`.
"""

from __future__ import annotations

import asyncio
import hashlib
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from worker_ai.alignment.base import Aligner, AlignmentUnavailableError
from worker_ai.audio import cut_wav
from worker_ai.cache import cache_key
from worker_ai.callbacks import JobUsage
from worker_ai.chunking import ChunkPlanEntry, plan_chunks
from worker_ai.diarisation.base import DiarisationUnavailableError
from worker_ai.diarisation.mapping import assign_speakers, speaker_ids
from worker_ai.diarisation.pyannote import PYANNOTE_ATTRIBUTION, PyannoteCommunityDiariser
from worker_ai.highlights.text import filter_hallucination_loops
from worker_ai.hints import prepare_hints
from worker_ai.languages import base_tag, is_code_mix_tag
from worker_ai.lid import (
    IndicLidClassifier,
    LanguageSignal,
    LidDecision,
    ProviderLanguageIdentifier,
    decide_language,
    lid_windows,
    pinned_language,
)
from worker_ai.logging_setup import get_logger
from worker_ai.metrics import METRICS, MetricKey
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.processors.media import MediaAudio, load_audio, load_track_audio, speech_regions
from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderError,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)
from worker_ai.providers.local_whisper import ENGLISH_FAMILY, weights_label
from worker_ai.providers.registry import ProviderUnavailableError
from worker_ai.routing import RoutingDecision, RoutingError, resolve_chain
from worker_ai.transcript import TranscriptChunk, assemble_chunk, identity_post_process
from worker_ai.vad import SpeechRegion

__all__ = [
    "MAX_CHUNK_PARALLELISM",
    "process_transcribe",
    "split_segments",
    "transcribe_usage",
]

_log = get_logger(__name__)

#: Chunks in flight per job, before a vendor's own limit is applied. Four
#: ten-minute chunks is 40 minutes of audio being decoded at once, which
#: saturates a serverless instance without queueing on it.
MAX_CHUNK_PARALLELISM = 4

#: Providers whose own language answer is the acoustic signal: a local Whisper
#: detects the language of the very chunk it transcribes — trusted only from
#: its general weights (see `_acoustic_signal`).
_SELF_IDENTIFYING = frozenset({"local-whisper"})


@dataclass(slots=True)
class _Progress:
    """How many chunks are done, shared with the heartbeat task."""

    total: int
    done: int = 0


@dataclass(slots=True)
class _Run:
    """One job's mutable state: the chain it is on, and what it produced."""

    chain: tuple[RoutingDecision, ...]
    decision: RoutingDecision
    provider: Provider
    lid: LidDecision | None = None
    #: The language the caller's hint pins (:func:`~worker_ai.lid.pinned_language`),
    #: or ``None`` for "auto". Sent with the LID probe, which otherwise goes out
    #: before there is a decision to send.
    pinned: str | None = None
    cache_hits: int = 0
    fallbacks: tuple[tuple[str, str], ...] = ()
    #: Paise already spent on work that was discarded — the LID probe when it
    #: moved the lane. Charged for, so counted (`05 §11`).
    discarded_cost_minor: int = 0


async def process_transcribe(context: JobContext) -> ProcessorOutcome:
    """Transcribe one media asset into :class:`TranscriptChunk` values."""
    raw_tracks = context.envelope.payload.get("audioTracks") or context.envelope.payload.get("audio_tracks")
    if isinstance(raw_tracks, list) and raw_tracks:
        dialogue_tracks = [
            t for t in raw_tracks
            if isinstance(t, dict) and t.get("isDialogue", True) is not False
        ]
        if dialogue_tracks:
            return await _process_multitrack_transcribe(context, dialogue_tracks)

    await context.progress(2, message="fetching audio")
    audio = load_audio(context)

    plan, regions = _plan(context, audio)
    hint = _language_hint(context)
    run = await _open(context, language=hint, code_mix=is_code_mix_tag(hint))
    run.pinned = pinned_language(hint)

    # One heartbeat for the whole vendor phase. Every call from here to the end
    # of `_transcribe_all` can sit inside a provider for minutes — the LID probe
    # included — and a job that goes quiet for longer than its lock is handed to
    # a second worker while the first is still paying a vendor (A08b).
    progress = _Progress(total=len(plan))
    heartbeat = asyncio.create_task(_beat(context, progress))
    try:
        probe, run = await _probe_and_route(context, audio, plan, regions, run, hint)
        progress.done = 1 if probe is not None else 0
        results = await _transcribe_all(context, audio, plan, regions, run, probe, progress)
    finally:
        heartbeat.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat

    language = _detected_language(run, results, hint)
    aligner, results = await _align_results(context, run, results, regions, language)
    words_by_chunk = [list(result.words) for result in results]
    diarisation = await _diarise(context, audio, regions, run, words_by_chunk)

    chunks = tuple(
        assemble_chunk(
            entry,
            words,
            language=language,
            post_process=identity_post_process,
        )
        for entry, words in zip(plan, words_by_chunk, strict=True)
    )

    await context.progress(98, message="assembling transcript")
    return ProcessorOutcome(
        result=_result(context, audio, chunks, run, results, language, aligner, diarisation),
        usage=transcribe_usage(audio, run, results),
    )


async def _process_multitrack_transcribe(
    context: JobContext,
    dialogue_tracks: list[dict[str, Any]],
) -> ProcessorOutcome:
    """Transcribe isolated dialogue tracks, assign ground-truth speakers, and merge."""
    await context.progress(2, message="fetching audio tracks")

    hint = _language_hint(context)
    run = await _open(context, language=hint, code_mix=is_code_mix_tag(hint))
    run.pinned = pinned_language(hint)

    # Base audio for duration / sizing / metadata fallback
    try:
        base_audio = load_audio(context)
    except Exception:
        base_audio = load_track_audio(context, dialogue_tracks[0], 0)

    all_words: list[Word] = []
    track_results: list[TranscriptionResult] = []
    detected_languages: list[str] = []
    aligners: list[Aligner | None] = []
    all_regions: list[SpeechRegion] = []
    max_duration_ms = base_audio.duration_ms

    for track_idx, track_info in enumerate(dialogue_tracks):
        speaker_id = str(
            track_info.get("speakerLabel")
            or track_info.get("label")
            or f"SPEAKER_{track_idx:02d}"
        )
        track_audio = load_track_audio(context, track_info, track_idx)
        if track_audio.duration_ms > max_duration_ms:
            max_duration_ms = track_audio.duration_ms

        pct = int(5 + (track_idx / len(dialogue_tracks)) * 85)
        await context.progress(
            pct,
            message=f"transcribing track {track_idx + 1}/{len(dialogue_tracks)} ({speaker_id})",
        )

        # Detect speech regions on this track
        regions = _supplied_regions(context)
        if not regions:
            regions = speech_regions(context, track_audio)
        if not regions:
            _log.info(
                "dialogue track has no speech regions; skipping",
                extra={
                    **context.envelope.log_fields(),
                    "speaker": speaker_id,
                    "trackIndex": track_idx,
                },
            )
            continue
        all_regions.extend(regions)

        track_plan = plan_chunks(track_audio.duration_ms, regions)
        if not track_plan:
            continue

        progress = _Progress(total=len(track_plan))
        heartbeat = asyncio.create_task(_beat(context, progress))
        try:
            probe: TranscriptionResult | None = None
            if run.lid is None:
                probe, run = await _probe_and_route(
                    context, track_audio, track_plan, regions, run, hint
                )
                progress.done = 1 if probe is not None else 0

            results = await _transcribe_all(
                context, track_audio, track_plan, regions, run, probe, progress
            )
        finally:
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat

        track_lang = _detected_language(run, results, hint)
        detected_languages.append(track_lang)

        aligner, results = await _align_results(context, run, results, regions, track_lang)
        if aligner is not None:
            aligners.append(aligner)

        for result in results:
            track_results.append(result)
            for w in result.words:
                tagged_word = Word(
                    s=w.s,
                    e=w.e,
                    t=w.t,
                    c=w.c,
                    sp=speaker_id,
                    scripts=w.scripts,
                    filler=w.filler,
                )
                all_words.append(tagged_word)

    if not all_words and not track_results:
        raise JobFailureError(
            "worker/empty_media", "no dialogue audio found across tracks", retryable=False
        )

    all_words.sort(key=lambda w: (w.s, w.e))
    language = detected_languages[0] if detected_languages else (hint or "en")
    chosen_aligner = aligners[0] if aligners else None

    # Determine master chunk plan
    supplied = context.envelope.payload.get("chunkPlan")
    if isinstance(supplied, list) and supplied:
        master_plan = _parse_plan(supplied)
    else:
        master_plan = plan_chunks(max_duration_ms, tuple(all_regions))
        if not master_plan:
            master_plan = (
                ChunkPlanEntry(chunk_idx=0, start_ms=0, end_ms=max_duration_ms),
            )

    # Partition words into master plan chunks
    chunks: list[TranscriptChunk] = []
    for entry in master_plan:
        is_last = entry.chunk_idx == len(master_plan) - 1
        chunk_words = [
            w
            for w in all_words
            if entry.start_ms <= w.s and (w.s < entry.end_ms or is_last)
        ]
        chunks.append(
            assemble_chunk(
                entry,
                chunk_words,
                language=language,
                post_process=identity_post_process,
            )
        )

    # Build turns per speaker from the tagged words
    turns = _turns_from_words([all_words])
    diarisation = _Diarisation(
        diariser="multitrack-demux",
        turns=turns,
        speakers=speaker_ids(turns),
        attribution="ground-truth-isolated-channels",
    )

    await context.progress(98, message="assembling transcript")
    results_tuple = tuple(track_results)
    return ProcessorOutcome(
        result=_result(
            context,
            base_audio,
            tuple(chunks),
            run,
            results_tuple,
            language,
            chosen_aligner,
            diarisation,
        ),
        usage=transcribe_usage(base_audio, run, results_tuple),
    )


# ---------------------------------------------------------------------------
# Planning and routing
# ---------------------------------------------------------------------------


def _language_hint(context: JobContext) -> str | None:
    """The caller's language hint, if any. It always wins over LID (`09 §1.1`).

    ``"auto"`` is not one (:func:`~worker_ai.lid.pinned_language`): it routes
    the probe to the default lane, lets both LID signals decide, and the
    transcript reports what they decided — never ``"auto"``. A real hint is
    returned as sent (``hi-Latn`` stays ``hi-Latn``), because the transcript
    reports the hint verbatim and the API reads the script subtag from it.
    """
    raw = context.payload_str("language")
    return raw if pinned_language(raw) is not None else None


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


async def _open(
    context: JobContext, *, language: str | None, code_mix: bool
) -> _Run:
    """Resolve the routing chain and instantiate its primary."""
    try:
        chain = resolve_chain(
            context.services.routing,
            context.services.providers,
            language=language,
            code_mix=code_mix,
        )
    except RoutingError as error:
        raise JobFailureError("worker/no_provider", str(error), retryable=False) from error
    decision = chain[0]
    return _Run(chain=chain, decision=decision, provider=await _provider(context, decision))


async def _provider(context: JobContext, decision: RoutingDecision) -> Provider:
    try:
        return await context.services.providers.get(decision.candidate.provider)
    except ProviderUnavailableError as error:  # pragma: no cover - resolve already checked
        raise JobFailureError("worker/no_provider", str(error), retryable=False) from error


# ---------------------------------------------------------------------------
# LID (D14)
# ---------------------------------------------------------------------------


async def _probe_and_route(
    context: JobContext,
    audio: MediaAudio,
    plan: tuple[ChunkPlanEntry, ...],
    regions: tuple[SpeechRegion, ...],
    run: _Run,
    hint: str | None,
) -> tuple[TranscriptionResult | None, _Run]:
    """Transcribe the first chunk, decide the language, and re-route if needed.

    Returns the probe result when it is still usable — that is, when LID left the
    job on the lane it was already on — and ``None`` when the lane moved and every
    chunk has to be transcribed again.

    **The comparison is on the lane, not on the provider.** If the probe itself
    fell through to a fallback because the primary was down, the run it produced
    already knows that; re-opening the chain would send the very next chunk back
    to the vendor that just failed.
    """
    await context.progress(6, message="identifying language")
    probe = await _transcribe_chunk(context, audio, plan[0], regions, run)

    acoustic = await _acoustic_signal(context, audio, regions, run, probe)
    textual = _textual_signal(context, probe)
    decision = decide_language(acoustic=acoustic, textual=textual, hint=hint)
    run.lid = decision

    rerouted = await _open(
        context,
        language=decision.language or hint,
        code_mix=decision.code_mix,
    )
    rerouted.lid = decision
    rerouted.pinned = run.pinned
    rerouted.cache_hits = run.cache_hits
    rerouted.fallbacks = run.fallbacks

    same_lane = rerouted.decision.lane.id == run.decision.lane.id
    chosen = run if same_lane else rerouted
    _log.info(
        "transcribe routed",
        extra={
            **context.envelope.log_fields(),
            "mediaId": audio.media_id,
            "chunks": len(plan),
            "lid": decision.to_wire(),
            **chosen.decision.to_wire(),
        },
    )

    if same_lane:
        return probe, run
    if probe.usage is not None and probe.usage.cost_minor:
        rerouted.discarded_cost_minor += int(probe.usage.cost_minor)
    _log.info(
        "re-routing after LID",
        extra={
            **context.envelope.log_fields(),
            "fromLane": run.decision.lane.id,
            "toLane": rerouted.decision.lane.id,
            "provider": rerouted.decision.candidate.provider,
            "language": decision.language,
            "codeMix": decision.code_mix,
        },
    )
    return None, rerouted


async def _acoustic_signal(
    context: JobContext,
    audio: MediaAudio,
    regions: tuple[SpeechRegion, ...],
    run: _Run,
    probe: TranscriptionResult,
) -> LanguageSignal:
    """Signal 1: a dedicated LID model when one is installed, else the provider.

    Not when the probe ran on ``local-whisper``: its answer already *is* a
    Whisper detection over this audio. The dedicated identifier is a CPU copy of
    the default weights (``runtime.build_language_identifier``), which here is
    the Hinglish fine-tune that calls every language English — and it has
    failed every call on faster-whisper 1.2 (``clip_timestamps`` is not a
    ``detect_language`` argument there) after spending the load anyway.

    And the local answer counts only when the general weights gave it
    (``raw["family"] == "en"``). The same fine-tune serves the English lanes
    whenever ``WORKER_AI_WHISPER_MODEL_EN`` is unset or will not load, and its
    "en at 1.0" about Hinglish audio would, as the acoustic signal, send every
    auto-detected Hinglish job down the English lane labelled English. Its
    answer is recorded as no opinion instead, and the text signal decides.
    """
    provider = run.decision.candidate.provider
    if provider in _SELF_IDENTIFYING:
        if probe.raw.get("family") == ENGLISH_FAMILY:
            return await ProviderLanguageIdentifier(
                probe.language, probe.language_confidence, provider=provider
            ).identify(str(audio.path), ())
        return LanguageSignal(
            source="provider",
            language="",
            detail={
                "provider": provider,
                "ignored": "the default weights report every language as English",
                "weights": weights_label(str(probe.raw.get("model") or "")),
            },
        )
    identifier = context.services.language_id
    if identifier is not None and identifier.available() is None:
        windows = lid_windows(audio.duration_ms, regions)
        try:
            signal = await identifier.identify(str(audio.path), windows)
        except Exception as error:  # a missing signal must not fail a transcript
            _log.warning(
                "acoustic LID failed; falling back to the provider's own answer",
                extra={"reason": str(error)[:200]},
            )
        else:
            if signal.present:
                return signal
    return await ProviderLanguageIdentifier(
        probe.language,
        probe.language_confidence,
        provider=provider,
    ).identify(str(audio.path), ())


def _textual_signal(context: JobContext, probe: TranscriptionResult) -> LanguageSignal:
    """Signal 2: the local classifier over the first chunk's text (D14)."""
    text = " ".join(word.t for word in probe.words) or " ".join(
        segment[2] for segment in probe.segments
    )
    classifier = context.services.text_lid or IndicLidClassifier()
    return classifier.classify(text)


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------


async def _transcribe_all(
    context: JobContext,
    audio: MediaAudio,
    plan: tuple[ChunkPlanEntry, ...],
    regions: tuple[SpeechRegion, ...],
    run: _Run,
    probe: TranscriptionResult | None,
    progress: _Progress,
) -> tuple[TranscriptionResult, ...]:
    """Every chunk, either as one Batch job or as a bounded parallel fan-out."""
    if _use_batch(run, audio):
        return await _transcribe_batch(context, audio, plan, regions, run)

    lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(_parallelism(context, run))

    async def one(entry: ChunkPlanEntry) -> TranscriptionResult:
        async with semaphore:
            result = await _transcribe_chunk(context, audio, entry, regions, run)
        async with lock:
            progress.done += 1
            # 10 % for fetch, plan and LID, 85 % for the chunks, 5 % for assembly.
            await context.progress(
                10 + 85 * progress.done / progress.total,
                message="transcribed "
                + str(progress.done)
                + "/"
                + str(progress.total)
                + " chunks",
            )
        return result

    pending = plan[1:] if probe is not None else plan
    rest = await asyncio.gather(*(one(entry) for entry in pending))
    return ((probe, *rest) if probe is not None else tuple(rest))


async def _beat(context: JobContext, progress: _Progress) -> None:
    """Keep the BullMQ lock alive while a chunk or a batch job is in flight (A08b)."""
    while True:
        await asyncio.sleep(context.heartbeat_interval_s)
        await context.heartbeat(
            "transcribing ("
            + str(progress.done)
            + "/"
            + str(progress.total)
            + " chunks done)"
        )


def _use_batch(run: _Run, audio: MediaAudio) -> bool:
    """True when the lane says batch and the file fits the vendor's ceiling."""
    if not run.decision.candidate.batch or not run.provider.capabilities.batch:
        return False
    ceiling = run.provider.capabilities.max_duration_s
    return ceiling is None or audio.duration_ms <= ceiling * 1000


def _parallelism(context: JobContext, run: _Run) -> int:
    """Chunks in flight: the lane's limit, then the adapter's, then ours."""
    lane_limit = run.decision.candidate.max_parallel_chunks
    if lane_limit > 0:
        return min(MAX_CHUNK_PARALLELISM, lane_limit)
    adapter = context.services.providers.max_parallel_requests(run.decision.candidate.provider)
    if adapter > 0:
        return min(MAX_CHUNK_PARALLELISM, adapter)
    return MAX_CHUNK_PARALLELISM


async def _transcribe_batch(
    context: JobContext,
    audio: MediaAudio,
    plan: tuple[ChunkPlanEntry, ...],
    regions: tuple[SpeechRegion, ...],
    run: _Run,
) -> tuple[TranscriptionResult, ...]:
    """One vendor job for the whole file, split back across the chunk plan."""
    await context.progress(12, message="submitting the batch job")
    whole = ChunkPlanEntry(chunk_idx=0, start_ms=0, end_ms=audio.duration_ms)
    result = await _transcribe_chunk(context, audio, whole, regions, run, whole_file=True)

    await context.progress(80, message="splitting the batch result")
    return split_segments(result, plan)


def split_segments(
    result: TranscriptionResult, plan: tuple[ChunkPlanEntry, ...]
) -> tuple[TranscriptionResult, ...]:
    """Split one whole-file result across the D14 chunk boundaries.

    A word or a segment belongs to the chunk it **starts** in, which is the same
    rule ``transcript.assemble_chunk`` uses for the word ids — so a sentence that
    straddles a boundary stays whole in the earlier chunk rather than being cut in
    two. Usage rides on the first chunk so the cost is counted once.
    """
    per_chunk: list[tuple[list[Word], list[tuple[int, int, str]]]] = [([], []) for _ in plan]

    def index_for(start_ms: int) -> int:
        for index, entry in enumerate(plan):
            if entry.start_ms <= start_ms < entry.end_ms:
                return index
        return len(plan) - 1 if start_ms >= plan[-1].start_ms else 0

    for word in result.words:
        per_chunk[index_for(word.s)][0].append(word)
    for segment in result.segments:
        per_chunk[index_for(segment[0])][1].append(segment)

    return tuple(
        TranscriptionResult(
            words=tuple(words),
            language=result.language,
            language_confidence=result.language_confidence,
            usage=result.usage if index == 0 else None,
            segments=tuple(segments),
            submissions=result.submissions if index == 0 else (),
            raw=dict(result.raw) if index == 0 else {},
        )
        for index, (words, segments) in enumerate(per_chunk)
    )


async def _transcribe_chunk(
    context: JobContext,
    audio: MediaAudio,
    entry: ChunkPlanEntry,
    regions: tuple[SpeechRegion, ...],
    run: _Run,
    *,
    whole_file: bool = False,
) -> TranscriptionResult:
    """One chunk: cache, then the chain until something answers."""
    audio_uri = str(audio.path)
    if not whole_file and _needs_cutting(entry, audio):
        chunk_path = context.workdir / ("chunk-" + str(entry.chunk_idx).zfill(4) + ".wav")
        await asyncio.to_thread(
            cut_wav, audio.path, chunk_path, start_ms=entry.start_ms, end_ms=entry.end_ms
        )
        audio_uri = str(chunk_path)

    last: ProviderError | None = None
    # Whether any candidate failed in a way a later attempt could fix. The job
    # is retried on that, not on the last candidate's error alone: a Hinglish
    # chunk that met a Sarvam 429 and then a local-whisper refusal would
    # otherwise be failed for good, although Sarvam would answer on retry.
    retryable = False
    start_rank = run.decision.rank
    for decision in run.chain[start_rank:]:
        provider = run.provider if decision is run.decision else await _provider(context, decision)
        # The cache is keyed on the candidate that would answer, not on the lane's
        # primary: a result produced by a fallback is a *different transcript* and
        # must never be served back for the provider that was down at the time.
        key = _cache_key(context, audio, entry, run, decision, provider)
        if key is not None:
            cached = await context.services.cache.get(key)
            METRICS.record_cache(hit=cached is not None)
            if cached is not None:
                run.cache_hits += 1
                _log.info(
                    "transcription served from cache",
                    extra={
                        **context.envelope.log_fields(),
                        "chunkIdx": entry.chunk_idx,
                        "provider": decision.candidate.provider,
                    },
                )
                # The provider is adopted with the decision, so the next chunk
                # never calls the old primary with the fallback's options.
                _adopt(run, decision, provider=provider)
                return cached

        request = TranscriptionRequest(
            audio_uri=audio_uri,
            language=_request_language(run),
            word_timestamps=True,
            hints=_hints(context),
            # The provider sees a chunk starting at zero; the caller shifts it
            # back into file time, which keeps word ids and timings consistent.
            offset_ms=entry.start_ms,
            options=decision.candidate.provider_options(),
        )
        metric = MetricKey(
            provider=decision.candidate.provider,
            language=base_tag(_request_language(run)) or "auto",
            lane=decision.lane.id,
        )
        try:
            result = await provider.transcribe(request)
        except ProviderError as error:
            last = error
            retryable = retryable or error.retryable
            METRICS.record_call(metric, outcome="error")
            _log.warning(
                "provider failed; advancing the routing chain",
                extra={
                    **context.envelope.log_fields(),
                    "provider": decision.candidate.provider,
                    "chunkIdx": entry.chunk_idx,
                    "retryable": error.retryable,
                    "reason": str(error)[:200],
                },
            )
            continue
        except NotImplementedError as error:
            raise JobFailureError(
                "worker/no_provider",
                provider.name + " cannot transcribe: " + str(error),
                retryable=False,
            ) from error

        _adopt(run, decision, provider=provider)

        METRICS.record_call(
            metric,
            outcome="ok",
            media_seconds=(result.usage.media_seconds or 0.0) if result.usage else 0.0,
            cost_minor=(result.usage.cost_minor or 0) if result.usage else 0,
        )
        context.record(result.submissions)
        if key is not None:
            # Stored under the weights that actually answered, which differ
            # from the ones the lookup assumed when the English weights failed
            # to load during this very call and the default weights stood in.
            served = _cache_key(context, audio, entry, run, decision, provider, served=result)
            await context.services.cache.set(served or key, result)
        return result

    del regions
    message = str(last) if last is not None else "every routed provider refused the chunk"
    raise JobFailureError("worker/provider_failed", message, retryable=retryable)


def _adopt(run: _Run, decision: RoutingDecision, *, provider: Provider | None) -> None:
    """Record that ``decision`` served the job, counting the fallback if it is one."""
    if decision is run.decision:
        return
    METRICS.record_fallback(
        from_provider=run.decision.candidate.provider,
        to_provider=decision.candidate.provider,
    )
    run.fallbacks = (
        *run.fallbacks,
        (run.decision.candidate.provider, decision.candidate.provider),
    )
    run.decision = decision
    if provider is not None:
        run.provider = provider


def _cache_key(
    context: JobContext,
    audio: MediaAudio,
    entry: ChunkPlanEntry,
    run: _Run,
    decision: RoutingDecision,
    provider: Provider,
    *,
    served: TranscriptionResult | None = None,
) -> str | None:
    if context.services.cache.name == "none":
        return None
    if bool(context.envelope.payload.get("retranscribe")) or bool(
        context.envelope.payload.get("force")
    ):
        return None
    digest = context.payload_str("contentHash")
    if not digest:
        digest = context.content_digest(audio.path)
    if not digest:
        return None
    return cache_key(
        content=digest,
        language=_request_language(run) or "",
        provider=decision.candidate.provider,
        model=_cache_model(decision, provider, _request_language(run), served)
        + _hints_variant(context),
        mode=decision.candidate.mode or "",
        offset_ms=entry.start_ms,
        duration_ms=entry.end_ms - entry.start_ms,
    )


def _cache_model(
    decision: RoutingDecision,
    provider: Provider,
    language: str | None,
    served: TranscriptionResult | None = None,
) -> str:
    """The cache's "model": the table's name, plus the weights a local model runs.

    ``local-whisper`` resolves a lane's ``model`` to one of two sets of weights,
    and with ``WORKER_AI_WHISPER_MODEL_EN`` unset the English name runs the
    Hinglish fine-tune. Keyed on the name alone, a fine-tune transcript made
    then would be served back for 30 days after the English weights arrived.
    A lookup can only predict the weights; a result names the ones that ran.
    """
    model = decision.candidate.model
    weights_for = getattr(provider, "weights_for", None)
    if not callable(weights_for):
        return model
    ran = served.raw.get("model") if served is not None else None
    if ran:
        return model + "@" + str(ran)
    routed = decision.candidate.provider_options().get("model")
    return model + "@" + str(weights_for(language=language, routed_model=routed))


def _hints_variant(context: JobContext) -> str:
    """A short digest of the job's hints, or ``""`` when it has none.

    Every adapter turns the hints into decoding bias (Whisper's
    ``initial_prompt``, Scribe's ``keyterms``, AssemblyAI's ``word_boost``), and
    they carry the workspace's glossary. Left out of the key, a second workspace
    repurposing the same YouTube video would be served a transcript biased by
    the first workspace's private terms. A job without hints keeps the key it
    always had, so the shared cache still works for the audio alone.
    """
    hints = _hints(context)
    if not hints:
        return ""
    digest = hashlib.sha256("\n".join(hints).encode("utf-8")).hexdigest()
    return "#hints=" + digest[:16]


def _request_language(run: _Run) -> str | None:
    """What to tell the provider: the LID answer, the pin, or nothing (detect).

    The probe goes out before LID has decided, so without the pin it would be
    a detection even on a job whose language the user fixed — and, the pin
    keeping the lane, that probe is *kept*. On a real multilingual model that
    is the whole first chunk (up to ten minutes, or the entire transcript of a
    short video) of an ``en-IN`` job decoded as Hindi or Urdu when the accent
    tips detection, while every later chunk is pinned to English. A pinned job's
    decision is its pin whatever the probe hears, so pinning the probe loses
    nothing; only "auto" probes with no language.
    """
    if run.lid is not None and run.lid.language:
        return run.lid.language
    return run.pinned


def _needs_cutting(entry: ChunkPlanEntry, audio: MediaAudio) -> bool:
    """False when the chunk *is* the whole file, so ffmpeg is never invoked for it."""
    return not (entry.start_ms == 0 and entry.end_ms >= audio.duration_ms)


def _hints(context: JobContext) -> tuple[str, ...]:
    """Glossary terms from the payload, shaped by `prepare_hints()` (B09/B09b, `09 §3`).

    The API assembles `params.hints` at enqueue from request-time hints plus the
    workspace's consented `memory_entries` glossary/spelling terms
    (`transcripts.service.ts::buildHints`), capped at 200 there. This is the one
    shared dedupe/trim/cap step every provider adapter needs done before it shapes
    its own vocabulary parameter (`word_boost`, `vocabulary`, `keyterms`,
    `initial_prompt`) — see `worker_ai/hints/glossary.py`.
    """
    raw = context.envelope.payload.get("hints")
    if isinstance(raw, list):
        return prepare_hints(str(item) for item in raw if str(item).strip())
    return ()


def _detected_language(
    run: _Run, results: tuple[TranscriptionResult, ...], hint: str | None
) -> str:
    """The file's language: the hint, then LID, then the busiest chunk's answer."""
    if hint:
        return hint
    if run.lid is not None and run.lid.language:
        return run.lid.language
    best = ""
    best_words = -1
    for result in results:
        if len(result.words) > best_words:
            best = result.language
            best_words = len(result.words)
    return best or "en"


# ---------------------------------------------------------------------------
# Alignment (D13)
# ---------------------------------------------------------------------------


async def _align_results(
    context: JobContext,
    run: _Run,
    results: tuple[TranscriptionResult, ...],
    regions: tuple[SpeechRegion, ...],
    language: str,
) -> tuple[Aligner | None, tuple[TranscriptionResult, ...]]:
    """Turn segment-level text into words where the provider gave none.

    Mandatory behind Sarvam (``alignment: required``) and a no-op behind Scribe,
    AssemblyAI and Whisper, which return word timings themselves — which is the
    whole reason D12 prefers them. Returns the aligner that ran (``None`` when
    none was needed) and the results with their words filled in.
    """
    needs = run.decision.needs_alignment or any(
        not result.words and result.segments for result in results
    )
    if not needs:
        return None, results

    try:
        aligner = context.services.aligners.resolve(language or "en")
    except AlignmentUnavailableError as error:  # pragma: no cover - proportional always resolves
        raise JobFailureError("worker/no_aligner", str(error), retryable=False) from error

    await context.progress(90, message="aligning with " + aligner.name)
    aligned: list[TranscriptionResult] = []
    for result in results:
        if result.words:
            cleaned_words = tuple(filter_hallucination_loops(result.words))
            if len(cleaned_words) != len(result.words):
                result = TranscriptionResult(
                    words=cleaned_words,
                    language=result.language,
                    language_confidence=result.language_confidence,
                    usage=result.usage,
                    segments=result.segments,
                    submissions=result.submissions,
                    raw=result.raw,
                )
        if result.words or not result.segments:
            aligned.append(result)
            continue
        aligned.append(await _align_one(result, aligner, regions, language))
    context.record(aligner.drain_submissions())
    return aligner, tuple(aligned)


async def _align_one(
    result: TranscriptionResult,
    aligner: Aligner,
    regions: tuple[SpeechRegion, ...],
    language: str,
) -> TranscriptionResult:
    """Align one chunk's segments into words (the Sarvam path, `09 §1`)."""
    words: list[Word] = []
    for start_ms, end_ms, text in result.segments:
        tokens = tuple(token for token in text.split() if token)
        if not tokens:
            continue
        try:
            aligned = await aligner.align(
                AlignmentRequest(
                    audio_uri="",
                    words=tokens,
                    language=language or result.language,
                    start_ms=start_ms,
                    end_ms=max(end_ms, start_ms),
                ),
                regions,
            )
        except (ProviderError, ValueError) as error:
            raise JobFailureError(
                "worker/alignment_failed",
                aligner.name + " could not align a segment: " + str(error)[:200],
                retryable=False,
            ) from error
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


# ---------------------------------------------------------------------------
# Diarisation (D13)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Diarisation:
    """What ran, and what it produced."""

    diariser: str
    turns: tuple[DiarisedSpeaker, ...]
    speakers: tuple[str, ...]
    attribution: str = ""

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "diariser": self.diariser,
            "speakers": [{"id": speaker} for speaker in self.speakers],
            "turns": [turn.to_wire() for turn in self.turns],
        }
        if self.attribution:
            wire["attribution"] = self.attribution
        return wire


async def _diarise(
    context: JobContext,
    audio: MediaAudio,
    regions: tuple[SpeechRegion, ...],
    run: _Run,
    words_by_chunk: list[list[Word]],
) -> _Diarisation | None:
    """Label words with speakers, globally (`09 §2`).

    When the primary already returned per-word speakers — Scribe does, and it is
    priced in — that labelling is kept and **pyannote does not run**. Otherwise
    diarisation happens only when the payload asks for it, because `09 §9` bills
    it as an on-request stage.
    """
    if any(word.sp for words in words_by_chunk for word in words):
        turns = _turns_from_words(words_by_chunk)
        return _Diarisation(
            diariser=run.decision.candidate.provider,
            turns=turns,
            speakers=speaker_ids(turns),
        )

    if not _wants_diarisation(context):
        return None

    try:
        diariser = context.services.diarisers.resolve()
    except DiarisationUnavailableError as error:  # pragma: no cover - noop always resolves
        raise JobFailureError("worker/no_diariser", str(error), retryable=False) from error

    await context.progress(94, message="diarising with " + diariser.name)
    try:
        turns = await diariser.diarise(
            DiarisationRequest(
                audio_uri=str(audio.path),
                num_speakers=_optional_int(context, "numSpeakers"),
                min_speakers=_optional_int(context, "minSpeakers"),
                max_speakers=_optional_int(context, "maxSpeakers"),
                regions=tuple((region.start_ms, region.end_ms) for region in regions),
            )
        )
    except ProviderError as error:
        # A missing speaker label is a degraded transcript, not a failed one.
        _log.warning(
            "diarisation failed; the transcript keeps its words",
            extra={**context.envelope.log_fields(), "reason": str(error)[:200]},
        )
        return None

    for index, words in enumerate(words_by_chunk):
        words_by_chunk[index] = list(assign_speakers(tuple(words), turns).words)
    context.record(diariser.drain_submissions())
    return _Diarisation(
        diariser=diariser.name,
        turns=turns,
        speakers=speaker_ids(turns),
        attribution=(
            PYANNOTE_ATTRIBUTION if isinstance(diariser, PyannoteCommunityDiariser) else ""
        ),
    )


def _turns_from_words(words_by_chunk: list[list[Word]]) -> tuple[DiarisedSpeaker, ...]:
    """Collapse per-word speakers into turns, across chunk boundaries."""
    turns: list[DiarisedSpeaker] = []
    for words in words_by_chunk:
        for word in words:
            if word.sp is None:
                continue
            if turns and turns[-1].speaker_id == word.sp:
                previous = turns[-1]
                turns[-1] = DiarisedSpeaker(
                    speaker_id=word.sp,
                    start_ms=previous.start_ms,
                    end_ms=max(previous.end_ms, word.e),
                )
                continue
            turns.append(DiarisedSpeaker(speaker_id=word.sp, start_ms=word.s, end_ms=word.e))
    return tuple(turns)


def _wants_diarisation(context: JobContext) -> bool:
    """`09 §9` prices diarisation as an on-request stage, so it is opt-in."""
    return bool(context.envelope.payload.get("diarise", False))


def _optional_int(context: JobContext, key: str) -> int | None:
    value = context.envelope.payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value > 0 else None


# ---------------------------------------------------------------------------
# Completion
# ---------------------------------------------------------------------------


def transcribe_usage(
    audio: MediaAudio, run: _Run, results: tuple[TranscriptionResult, ...]
) -> JobUsage:
    """``usage`` for the completion callback: what this job actually consumed."""
    seconds = audio.duration_ms / 1000
    cost = run.discarded_cost_minor + sum(
        result.usage.cost_minor
        for result in results
        if result.usage is not None and result.usage.cost_minor is not None
    )
    return JobUsage(
        media_seconds=seconds,
        provider=run.decision.candidate.provider,
        model=run.decision.candidate.model,
        cost_minor=cost,
        egress_bytes=audio.size_bytes,
        cached=run.cache_hits > 0,
    )


def _result(
    context: JobContext,
    audio: MediaAudio,
    chunks: tuple[TranscriptChunk, ...],
    run: _Run,
    results: tuple[TranscriptionResult, ...],
    language: str,
    aligner: Aligner | None,
    diarisation: _Diarisation | None,
) -> dict[str, Any]:
    """The completion ``result``. A11 reads this shape into ``transcript_chunks``."""
    transcript_id = context.payload_str("transcriptId")
    engine_versions: dict[str, str] = {
        "asr": run.decision.candidate.provider + "/" + run.decision.candidate.model,
    }
    if run.decision.candidate.mode:
        engine_versions["asrMode"] = run.decision.candidate.mode
    weights = _served_weights(results)
    if weights:
        engine_versions["asrWeights"] = weights
    if aligner is not None:
        engine_versions["aligner"] = aligner.name
        model = str(getattr(aligner, "model", "") or "")
        if model:
            engine_versions["alignerModel"] = model
    if diarisation is not None:
        engine_versions["diariser"] = diarisation.diariser
    if run.lid is not None:
        engine_versions["lid"] = ",".join(
            signal.source for signal in run.lid.signals if signal.present
        )

    payload: dict[str, Any] = {
        "mediaId": audio.media_id,
        "language": language,
        "provider": run.decision.candidate.provider,
        "model": run.decision.candidate.model,
        "lane": run.decision.lane.id,
        "durationMs": audio.duration_ms,
        "wordCount": sum(len(chunk.words) for chunk in chunks),
        "chunks": [chunk.to_wire() for chunk in chunks],
        "providerSubmissions": context.submissions_wire(),
        "routing": run.decision.to_wire(),
        "engineVersions": engine_versions,
        "cached": run.cache_hits > 0,
    }
    if run.fallbacks:
        payload["fallbacks"] = [
            {"from": source, "to": target} for source, target in run.fallbacks
        ]
    if transcript_id:
        payload["transcriptId"] = transcript_id
    if run.lid is not None:
        payload["lid"] = run.lid.to_wire()
        if run.lid.low_confidence:
            payload["lowConfidence"] = True
    if aligner is not None:
        payload["alignerModel"] = aligner.name
    if diarisation is not None:
        payload["diarisation"] = diarisation.to_wire()
    return payload


def _served_weights(results: tuple[TranscriptionResult, ...]) -> str:
    """The local weights that actually transcribed the job, in chunk order.

    ``asr`` and ``model`` name the routing table's choice (``large-v3-turbo``),
    which is not what ran when ``WORKER_AI_WHISPER_MODEL_EN`` is unset or its
    weights would not load — the default weights stand in. This is the record
    that says so, as each directory's last component (never a full path, with
    a user's home in it). Two names means the weights changed mid-job, e.g.
    the English ones failed after the first chunk. Empty for a vendor, which
    names no weights.
    """
    names: list[str] = []
    for result in results:
        weights = result.raw.get("model") if "family" in result.raw else None
        if weights:
            label = weights_label(str(weights))
            if label not in names:
                names.append(label)
    return ",".join(names)
