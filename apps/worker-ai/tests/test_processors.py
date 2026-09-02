"""The four implemented processors, plus the stubs for the queues A09 does not own."""

from __future__ import annotations

import asyncio
import time
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest

from worker_ai.alignment import AlignerRegistry
from worker_ai.audio import Pcm, write_wav
from worker_ai.callbacks import CallbackAck, CallbackClient, JobCompletion
from worker_ai.chunking import NOMINAL_CHUNK_MS
from worker_ai.diarisation import DiariserRegistry
from worker_ai.processors import (
    JobContext,
    JobFailureError,
    Services,
    process_align,
    process_diarise,
    process_not_implemented,
    process_transcribe,
    process_vad,
)
from worker_ai.processors.transcribe import MAX_CHUNK_PARALLELISM
from worker_ai.providers.registry import build_registry
from worker_ai.queues import parse_envelope
from worker_ai.routing import load_routing_table
from worker_ai.settings import Settings, load_settings
from worker_ai.storage import ObjectStore, StorageError
from worker_ai.vad import EnergyVad

from .conftest import MEDIA_ID, PROJECT_ID, VALID_ENV, WORKSPACE_ID, clip, envelope

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


class RecordingCallbacks(CallbackClient):
    """A callback client that records instead of posting.

    A real subclass rather than a duck type, so `Services.callbacks` keeps its
    declared type and `mypy --strict` still checks these call sites.
    """

    def __init__(self) -> None:
        super().__init__("http://callbacks.invalid", "r" * 64)
        self.progress_calls: list[tuple[float, str | None]] = []
        self.completions: list[JobCompletion] = []

    async def progress(
        self,
        job_id: str,
        attempt_id: str,
        progress: float,
        *,
        eta_ms: int | None = None,
        message: str | None = None,
    ) -> CallbackAck:
        self.progress_calls.append((progress, message))
        return CallbackAck(applied=True, job_id=job_id, status="running")

    async def complete(
        self, job_id: str, attempt_id: str, completion: JobCompletion
    ) -> CallbackAck:
        self.completions.append(completion)
        return CallbackAck(applied=True, job_id=job_id, status=completion.status)


def recorder(services: Services) -> RecordingCallbacks:
    """The recording client behind `services`, narrowed for the type checker."""
    assert isinstance(services.callbacks, RecordingCallbacks)
    return services.callbacks


def build_services(
    settings: Settings | None = None, *, store: ObjectStore | None = None
) -> Services:
    """Services wired for tests: real registries, a recording callback client."""
    resolved = settings or load_settings(
        {**VALID_ENV, "FEATURE_FLAGS_JSON": '{"asr.local-whisper": false}'}
    )
    return Services(
        settings=resolved,
        callbacks=RecordingCallbacks(),
        providers=build_registry(resolved),
        routing=load_routing_table(),
        aligners=AlignerRegistry.default(),
        diarisers=DiariserRegistry.default(),
        vad=EnergyVad(),
        derived_store=store,
    )


def context_for(queue: str, services: Services | None = None, **payload: Any) -> JobContext:
    return JobContext(
        envelope=parse_envelope(envelope(**payload)),
        queue=queue,
        services=services or build_services(),
        max_attempts=2,
    )


@pytest.fixture
def long_wav(tmp_path: Path) -> Path:
    """25 minutes of speech with a silence either side of each nominal boundary."""
    spans: list[tuple[str, int]] = []
    for _ in range(25):
        spans.append(("speech", 55_000))
        spans.append(("silence", 5_000))
    return write_wav(tmp_path / "long.wav", clip(*spans))


# ---------------------------------------------------------------------------
# ai.vad
# ---------------------------------------------------------------------------


async def test_vad_returns_regions_and_a_chunk_plan(wav_file: Path) -> None:
    context = context_for("ai.vad", mediaId=MEDIA_ID, audioUri=str(wav_file))
    outcome = await process_vad(context)

    assert outcome.result["mediaId"] == MEDIA_ID
    assert outcome.result["backend"] == "energy"
    assert len(outcome.result["regions"]) == 3
    assert outcome.result["chunkPlan"] == [
        {"chunkIdx": 0, "startMs": 0, "endMs": outcome.result["durationMs"]}
    ]
    assert 0 < outcome.result["speechMs"] < outcome.result["durationMs"]
    assert outcome.usage is not None
    assert outcome.usage.cost_minor == 0


async def test_vad_plans_several_chunks_for_a_long_file(long_wav: Path) -> None:
    context = context_for("ai.vad", mediaId=MEDIA_ID, audioUri=str(long_wav))
    outcome = await process_vad(context)

    plan = outcome.result["chunkPlan"]
    assert len(plan) >= 2
    assert plan[0]["startMs"] == 0
    assert plan[-1]["endMs"] == outcome.result["durationMs"]
    # Every boundary landed inside a silence, not on the nominal 10-minute mark.
    assert plan[0]["endMs"] != NOMINAL_CHUNK_MS


async def test_vad_reports_progress_on_the_way(wav_file: Path) -> None:
    services = build_services()
    context = context_for("ai.vad", services, mediaId=MEDIA_ID, audioUri=str(wav_file))
    await process_vad(context)
    calls = recorder(services).progress_calls
    assert [percent for percent, _ in calls] == [5, 35]


# ---------------------------------------------------------------------------
# ai.transcribe
# ---------------------------------------------------------------------------


async def test_transcribe_numbers_words_per_chunk_with_monotonic_timings(
    long_wav: Path,
) -> None:
    context = context_for("ai.transcribe", mediaId=MEDIA_ID, audioUri=str(long_wav))
    outcome = await process_transcribe(context)

    chunks = outcome.result["chunks"]
    assert len(chunks) >= 2
    for index, chunk in enumerate(chunks):
        assert chunk["chunkIdx"] == index
        assert [word["wid"] for word in chunk["words"]] == [
            f"{index}:{n}" for n in range(len(chunk["words"]))
        ]
        previous_end = chunk["startMs"]
        for word in chunk["words"]:
            assert chunk["startMs"] <= word["s"] <= word["e"] <= chunk["endMs"]
            assert word["s"] >= previous_end
            previous_end = word["e"]

    # Chunks are contiguous, so the file's words are globally ordered too.
    for previous, following in pairwise(chunks):
        assert previous["endMs"] == following["startMs"]

    assert outcome.result["provider"] == "mock"
    assert outcome.result["wordCount"] == sum(len(chunk["words"]) for chunk in chunks)
    assert outcome.result["providerSubmissions"][0]["provider"] == "mock"
    # One per chunk, plus the LID probe's own call when it moved the lane (D14).
    # Every call is recorded, discarded or not: an erasure request has to be able
    # to find the audio that actually left (`06 §Invariant 5`).
    assert len(outcome.result["providerSubmissions"]) >= len(chunks)


async def test_transcribe_honours_a_chunk_plan_from_the_payload(wav_file: Path) -> None:
    """A caller that already ran `ai.vad` does not pay for a second pass."""
    context = context_for(
        "ai.transcribe",
        mediaId=MEDIA_ID,
        audioUri=str(wav_file),
        chunkPlan=[
            {"chunkIdx": 0, "startMs": 0, "endMs": 2_000},
            {"chunkIdx": 1, "startMs": 2_000, "endMs": 4_500},
        ],
    )
    outcome = await process_transcribe(context)

    chunks = outcome.result["chunks"]
    assert [chunk["chunkIdx"] for chunk in chunks] == [0, 1]
    assert chunks[0]["endMs"] == 2_000
    assert chunks[1]["words"][0]["wid"] == "1:0"


async def test_transcribe_reports_usage_for_the_credit_settlement(
    wav_file: Path, wav_file_size: int
) -> None:
    context = context_for("ai.transcribe", mediaId=MEDIA_ID, audioUri=str(wav_file))
    outcome = await process_transcribe(context)

    assert outcome.usage is not None
    assert outcome.usage.provider == "mock"
    assert outcome.usage.media_seconds == pytest.approx(4.5, abs=0.1)
    assert outcome.usage.egress_bytes == wav_file_size


async def test_transcribe_passes_the_language_hint_through(wav_file: Path) -> None:
    context = context_for("ai.transcribe", mediaId=MEDIA_ID, audioUri=str(wav_file), language="ta")
    outcome = await process_transcribe(context)
    assert outcome.result["language"] == "ta"
    assert outcome.result["lane"] == "indic-scribe"


async def test_transcribe_records_the_transcript_id_when_the_payload_has_one(
    wav_file: Path,
) -> None:
    context = context_for(
        "ai.transcribe",
        mediaId=MEDIA_ID,
        audioUri=str(wav_file),
        transcriptId="01JBQ8Z2W4N7Y0K3M5P8R1T6VE",
    )
    outcome = await process_transcribe(context)
    assert outcome.result["transcriptId"] == "01JBQ8Z2W4N7Y0K3M5P8R1T6VE"


async def test_transcribe_aligns_segment_only_results(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Sarvam path: no word timings, so the aligner turns segments into words."""
    from worker_ai.providers.base import TranscriptionResult
    from worker_ai.providers.mock import MockProvider
    from worker_ai.routing import RoutingCandidate, RoutingDecision

    async def segments_only(self: Any, request: Any) -> TranscriptionResult:
        return TranscriptionResult(
            words=(),
            language="hi-en",
            segments=((0, 2_000, "toh aaj hum baat karenge"),),
        )

    monkeypatch.setattr(MockProvider, "transcribe", segments_only)

    services = build_services()
    lane = services.routing.lane("hinglish")
    monkeypatch.setattr(
        "worker_ai.processors.transcribe.resolve_chain",
        lambda *args, **kwargs: (
            RoutingDecision(
                lane=lane,
                candidate=RoutingCandidate(
                    provider="mock", model="fixture-v1", alignment="required"
                ),
            ),
        ),
    )

    context = context_for("ai.transcribe", services, mediaId=MEDIA_ID, audioUri=str(wav_file))
    outcome = await process_transcribe(context)

    words = outcome.result["chunks"][0]["words"]
    assert [word["t"] for word in words] == ["toh", "aaj", "hum", "baat", "karenge"]
    assert outcome.result["alignerModel"] == "proportional-vad"


async def test_transcribe_maps_a_provider_failure_onto_its_retryability(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from worker_ai.providers.base import ProviderError
    from worker_ai.providers.mock import MockProvider

    async def explode(self: Any, request: Any) -> None:
        raise ProviderError("429", provider="mock", retryable=True)

    monkeypatch.setattr(MockProvider, "transcribe", explode)
    context = context_for("ai.transcribe", mediaId=MEDIA_ID, audioUri=str(wav_file))

    with pytest.raises(JobFailureError) as raised:
        await process_transcribe(context)
    assert raised.value.code == "worker/provider_failed"
    assert raised.value.retryable is True


async def test_transcribe_refuses_a_malformed_chunk_plan(wav_file: Path) -> None:
    context = context_for(
        "ai.transcribe",
        mediaId=MEDIA_ID,
        audioUri=str(wav_file),
        chunkPlan=[{"chunkIdx": 0}],
    )
    with pytest.raises(JobFailureError) as raised:
        await process_transcribe(context)
    assert raised.value.retryable is False


async def test_transcribe_refuses_a_chunk_plan_of_non_objects(wav_file: Path) -> None:
    context = context_for(
        "ai.transcribe", mediaId=MEDIA_ID, audioUri=str(wav_file), chunkPlan=["nope"]
    )
    with pytest.raises(JobFailureError, match="must be objects"):
        await process_transcribe(context)


async def test_transcribe_fails_when_no_provider_can_serve_the_lane(
    wav_file: Path,
) -> None:
    settings = load_settings({**VALID_ENV, "WORKER_AI_ALLOW_MOCK": "0"})
    services = build_services(settings)
    context = context_for("ai.transcribe", services, mediaId=MEDIA_ID, audioUri=str(wav_file))

    with pytest.raises(JobFailureError) as raised:
        await process_transcribe(context)
    assert raised.value.code == "worker/no_provider"
    assert raised.value.retryable is False


def test_chunk_parallelism_is_bounded() -> None:
    """Unbounded fan-out against a per-second GPU is a rate-limit incident."""
    assert 1 <= MAX_CHUNK_PARALLELISM <= 8


# ---------------------------------------------------------------------------
# ai.align
# ---------------------------------------------------------------------------


async def test_align_places_supplied_segments_inside_their_spans() -> None:
    context = context_for(
        "ai.align",
        language="hi-en",
        regions=[{"startMs": 0, "endMs": 4_000}],
        segments=[
            {"startMs": 0, "endMs": 2_000, "text": "toh aaj hum"},
            {"startMs": 2_000, "endMs": 4_000, "words": ["baat", "karenge"]},
        ],
    )
    outcome = await process_align(context)

    words = outcome.result["words"]
    assert [word["t"] for word in words] == ["toh", "aaj", "hum", "baat", "karenge"]
    assert outcome.result["alignerModel"] == "proportional-vad"
    previous = 0
    for word in words:
        assert 0 <= word["s"] <= word["e"] <= 4_000
        assert word["s"] >= previous
        previous = word["e"]


async def test_align_accepts_a_single_span_payload() -> None:
    context = context_for("ai.align", language="hi", words=["ek", "do"], startMs=0, endMs=1_000)
    outcome = await process_align(context)
    assert len(outcome.result["words"]) == 2


async def test_align_uses_the_media_when_no_regions_are_supplied(wav_file: Path) -> None:
    context = context_for(
        "ai.align",
        mediaId=MEDIA_ID,
        audioUri=str(wav_file),
        language="hi-en",
        segments=[{"startMs": 0, "endMs": 4_500, "text": "toh aaj hum baat"}],
    )
    outcome = await process_align(context)
    assert outcome.usage is not None
    assert outcome.usage.media_seconds == pytest.approx(4.5, abs=0.1)


async def test_align_without_anything_to_align_fails_permanently() -> None:
    context = context_for("ai.align", language="hi")
    with pytest.raises(JobFailureError) as raised:
        await process_align(context)
    assert raised.value.code == "worker/invalid_payload"
    assert raised.value.retryable is False


async def test_align_ignores_segments_that_carry_no_text() -> None:
    context = context_for(
        "ai.align",
        language="hi",
        segments=[{"startMs": 0, "endMs": 500, "text": "  "}, "not an object"],
    )
    with pytest.raises(JobFailureError, match="needs segments"):
        await process_align(context)


# ---------------------------------------------------------------------------
# ai.diarise
# ---------------------------------------------------------------------------


async def test_diarise_labels_the_speech_regions(wav_file: Path) -> None:
    context = context_for("ai.diarise", mediaId=MEDIA_ID, audioUri=str(wav_file))
    outcome = await process_diarise(context)

    assert outcome.result["diariser"] == "noop-single-speaker"
    assert outcome.result["globalLabels"] is True
    assert outcome.result["speakers"] == [{"id": "S1"}]
    assert len(outcome.result["turns"]) == 3


async def test_diarise_ignores_a_nonsense_speaker_count(wav_file: Path) -> None:
    context = context_for(
        "ai.diarise", mediaId=MEDIA_ID, audioUri=str(wav_file), numSpeakers=True, minSpeakers=0
    )
    outcome = await process_diarise(context)
    assert outcome.result["speakers"] == [{"id": "S1"}]


# ---------------------------------------------------------------------------
# The queues A09 does not implement
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("queue", "owner"),
    [
        ("ai.translate", "A12"),
        ("ai.transliterate", "A12"),
        ("ai.clean", "A13"),
        ("ai.pass", "A14"),
        ("ai.llm", "A15"),
    ],
)
async def test_an_unimplemented_queue_fails_fast_and_names_its_owner(
    queue: str, owner: str
) -> None:
    with pytest.raises(JobFailureError) as raised:
        await process_not_implemented(context_for(queue))
    assert raised.value.code == "worker/not_implemented"
    assert owner in raised.value.message
    # Non-retryable, so the hold is released now and the job dead-letters.
    assert raised.value.retryable is False


# ---------------------------------------------------------------------------
# Media loading
# ---------------------------------------------------------------------------


class _FakeS3:
    """A boto3 stand-in that copies a local file, or raises."""

    def __init__(self, source: Path | None) -> None:
        self.source = source
        self.keys: list[str] = []

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
        self.keys.append(Key)
        if self.source is None:
            raise RuntimeError("NoSuchKey")
        Path(Filename).write_bytes(self.source.read_bytes())

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        return {"ContentLength": 42}


async def test_a_processor_reads_the_contracts_derived_key(wav_file: Path) -> None:
    client = _FakeS3(wav_file)
    services = build_services(store=ObjectStore(bucket="derived", client=client))
    context = context_for("ai.vad", services, mediaId=MEDIA_ID)

    await process_vad(context)
    context.cleanup()

    assert client.keys == [f"ws/{WORKSPACE_ID}/p/{PROJECT_ID}/media/{MEDIA_ID}/audio16k.wav"]


async def test_a_missing_object_is_retryable(wav_file: Path) -> None:
    services = build_services(store=ObjectStore(bucket="derived", client=_FakeS3(None)))
    context = context_for("ai.vad", services, mediaId=MEDIA_ID)

    with pytest.raises(JobFailureError) as raised:
        await process_vad(context)
    assert raised.value.code == "worker/storage_unavailable"
    assert raised.value.retryable is True


async def test_an_unconfigured_store_fails_permanently() -> None:
    context = context_for("ai.vad", mediaId=MEDIA_ID)
    with pytest.raises(JobFailureError) as raised:
        await process_vad(context)
    assert raised.value.code == "worker/storage_unconfigured"
    assert raised.value.retryable is False


async def test_a_payload_without_a_media_id_fails_permanently() -> None:
    context = context_for("ai.vad")
    with pytest.raises(JobFailureError) as raised:
        await process_vad(context)
    assert raised.value.code == "worker/invalid_payload"


async def test_a_missing_local_file_fails_permanently(tmp_path: Path) -> None:
    context = context_for("ai.vad", mediaId=MEDIA_ID, audioUri=str(tmp_path / "nothing.wav"))
    with pytest.raises(JobFailureError, match="does not exist"):
        await process_vad(context)


async def test_undecodable_audio_is_not_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    broken = tmp_path / "broken.wav"
    broken.write_bytes(b"RIFFnope")
    monkeypatch.setenv("FFMPEG_BIN", str(tmp_path / "no-such-ffmpeg"))

    context = context_for("ai.vad", mediaId=MEDIA_ID, audioUri=str(broken))
    with pytest.raises(JobFailureError) as raised:
        await process_vad(context)
    assert raised.value.code == "worker/undecodable_audio"
    assert raised.value.retryable is False


async def test_a_job_without_a_project_id_cannot_build_a_derived_key(
    wav_file: Path,
) -> None:
    services = build_services(store=ObjectStore(bucket="derived", client=_FakeS3(wav_file)))
    payload = envelope(mediaId=MEDIA_ID)
    del payload["projectId"]
    context = JobContext(envelope=parse_envelope(payload), queue="ai.vad", services=services)

    with pytest.raises(JobFailureError, match="projectId"):
        await process_vad(context)


def test_the_store_wraps_a_head_failure(wav_file: Path) -> None:
    class _Failing:
        def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
            raise RuntimeError("boom")

        def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
            raise RuntimeError("boom")

    store = ObjectStore(bucket="derived", client=_Failing())
    with pytest.raises(StorageError, match="could not stat"):
        store.size_bytes("key")


# ---------------------------------------------------------------------------
# JobContext
# ---------------------------------------------------------------------------


def test_the_scratch_directory_is_created_lazily_and_removed() -> None:
    context = context_for("ai.vad", mediaId=MEDIA_ID)
    assert context._workdir is None
    workdir = context.workdir
    assert workdir.is_dir()
    context.cleanup()
    assert not workdir.exists()
    context.cleanup()  # idempotent


def test_final_attempt_follows_bullmqs_own_arithmetic() -> None:
    context = context_for("ai.vad")
    context.attempts_made, context.max_attempts = 0, 2
    assert context.final_attempt is False
    context.attempts_made = 1
    assert context.final_attempt is True


async def test_progress_is_throttled_but_always_reports_completion() -> None:
    services = build_services()
    context = context_for("ai.vad", services)
    await context.progress(10)
    await context.progress(10.2)  # too small a step, and too soon
    await context.progress(40)
    await context.progress(100)
    assert [percent for percent, _ in recorder(services).progress_calls] == [
        10,
        40,
        100,
    ]


async def test_a_failing_progress_callback_never_fails_the_job() -> None:
    class _Broken(RecordingCallbacks):
        async def progress(
            self,
            job_id: str,
            attempt_id: str,
            progress: float,
            *,
            eta_ms: int | None = None,
            message: str | None = None,
        ) -> CallbackAck:
            raise RuntimeError("the API is down")

    services = build_services()
    object.__setattr__(services, "callbacks", _Broken())
    context = context_for("ai.vad", services)
    await context.progress(10)  # must not raise


def test_the_clip_helper_produces_the_expected_duration() -> None:
    pcm: Pcm = clip(("speech", 500), ("silence", 500))
    assert pcm.duration_ms == 1_000


# ---------------------------------------------------------------------------
# The heartbeat (A08b): the progress callback is what keeps the lock alive
# ---------------------------------------------------------------------------


def _skip_ahead(monkeypatch: pytest.MonkeyPatch, seconds: float = 10_000) -> None:
    """Move the context's clock forward without touching the real one."""
    now = time.monotonic()
    monkeypatch.setattr("worker_ai.processors.context.time.monotonic", lambda: now + seconds)


def test_the_heartbeat_interval_follows_the_queues_lock() -> None:
    assert context_for("ai.transcribe").heartbeat_interval_s == 200.0
    assert context_for("ai.transcribe").lock_duration_ms == 600_000
    assert context_for("ai.vad").heartbeat_interval_s == 40.0


async def test_a_heartbeat_is_skipped_while_the_interval_has_not_elapsed() -> None:
    """Calling it in a loop is free; only the clock decides when a beat is posted."""
    services = build_services()
    context = context_for("ai.transcribe", services)
    await context.progress(10)
    await context.heartbeat()
    await context.heartbeat()
    assert [percent for percent, _ in recorder(services).progress_calls] == [10]


async def test_a_heartbeat_after_the_interval_reposts_the_last_percentage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    services = build_services()
    context = context_for("ai.transcribe", services)
    await context.progress(42)

    _skip_ahead(monkeypatch)
    await context.heartbeat("still transcribing")

    calls = recorder(services).progress_calls
    assert [percent for percent, _ in calls] == [42, 42]
    assert calls[-1][1] == "still transcribing"


async def test_a_heartbeat_before_any_progress_reports_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    services = build_services()
    context = context_for("ai.transcribe", services)
    _skip_ahead(monkeypatch)
    await context.heartbeat()
    assert recorder(services).progress_calls == [(0.0, "still working")]


async def test_transcribe_beats_while_a_chunk_is_in_flight(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ten-minute chunk in a vendor must not let the lock expire."""
    from worker_ai.providers.mock import MockProvider

    original = MockProvider.transcribe

    async def slow(self: Any, request: Any) -> Any:
        await asyncio.sleep(0.05)
        return await original(self, request)

    monkeypatch.setattr(MockProvider, "transcribe", slow)
    # A heartbeat every 10 ms, so the 50 ms chunk sees several.
    monkeypatch.setattr(JobContext, "heartbeat_interval_s", property(lambda self: 0.01))

    services = build_services()
    context = context_for("ai.transcribe", services, mediaId=MEDIA_ID, audioUri=str(wav_file))
    await process_transcribe(context)

    messages = [message for _, message in recorder(services).progress_calls]
    assert any(message is not None and "chunks done" in message for message in messages)
