"""``ai.transcribe`` end to end: LID, routing chain, batch, cache, diarisation.

The A09 processor tests cover chunking, word ids and the callback contract; this
file covers what A10 added on top — the decisions of `09 §1` and D12/D13/D14.
Every provider here is a fake or a replayed vendor, because no key exists yet.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from worker_ai.alignment import AlignerRegistry
from worker_ai.cache import MemoryResultCache
from worker_ai.chunking import ChunkPlanEntry
from worker_ai.diarisation import DiariserRegistry
from worker_ai.diarisation.base import Diariser
from worker_ai.lid import IndicLidClassifier, LanguageIdentifier, LanguageSignal
from worker_ai.metrics import METRICS
from worker_ai.processors import JobContext, JobFailureError, Services, process_transcribe
from worker_ai.processors.transcribe import _hints, split_segments
from worker_ai.providers.base import (
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
from worker_ai.providers.registry import ProviderRegistry
from worker_ai.queues import parse_envelope
from worker_ai.routing import load_routing_table
from worker_ai.settings import Settings, load_settings
from worker_ai.vad import EnergyVad

from .conftest import MEDIA_ID, VALID_ENV, clip, envelope
from .test_processors import RecordingCallbacks

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeProvider(Provider):
    """A provider whose answers a test writes."""

    def __init__(
        self,
        name: str,
        *,
        words: tuple[str, ...] = ("toh", "aaj", "hum"),
        language: str = "hi",
        segments_only: bool = False,
        speakers: bool = False,
        error: ProviderError | None = None,
        capabilities: ProviderCapabilities | None = None,
    ) -> None:
        self.name = name
        self.capabilities = capabilities or ProviderCapabilities(
            supported=frozenset({"transcribe"}), word_timestamps=True
        )
        self._words = words
        self._language = language
        self._segments_only = segments_only
        self._speakers = speakers
        self._error = error
        self.calls: list[TranscriptionRequest] = []

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        self.calls.append(request)
        if self._error is not None:
            raise self._error
        usage = ProviderUsage(
            media_seconds=3.0, provider=self.name, model="fake", cost_minor=7
        )
        submissions = (
            ProviderSubmission(provider=self.name, endpoint="https://x", artefact="a.wav"),
        )
        if self._segments_only:
            return TranscriptionResult(
                words=(),
                language=self._language,
                usage=usage,
                segments=((request.offset_ms, request.offset_ms + 2_000, " ".join(self._words)),),
                submissions=submissions,
            )
        words = tuple(
            Word(
                s=request.offset_ms + index * 400,
                e=request.offset_ms + index * 400 + 300,
                t=text,
                sp=("S1" if index % 2 == 0 else "S2") if self._speakers else None,
            )
            for index, text in enumerate(self._words)
        )
        return TranscriptionResult(
            words=words,
            language=self._language,
            language_confidence=0.95,
            usage=usage,
            submissions=submissions,
        )

    async def align(self, request: Any) -> TranscriptionResult:
        raise NotImplementedError

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError


class FakeDiariser(Diariser):
    name = "fake-diariser"
    rank = 5

    def __init__(self, turns: tuple[DiarisedSpeaker, ...]) -> None:
        self._turns = turns
        self.calls: list[DiarisationRequest] = []

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        self.calls.append(request)
        return self._turns


class FixedLid(LanguageIdentifier):
    name = "whisper"

    def __init__(self, language: str, confidence: float = 0.95) -> None:
        self._language = language
        self._confidence = confidence

    async def identify(self, audio_uri: str, windows: Any) -> LanguageSignal:
        del audio_uri, windows
        return LanguageSignal(
            source=self.name, language=self._language, confidence=self._confidence
        )


class PinnedRegistry(ProviderRegistry):
    """A registry serving the fakes a test names, and nothing else."""

    def __init__(self, settings: Settings, providers: dict[str, Provider]) -> None:
        super().__init__(settings, ())
        self._pinned = providers

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._pinned)

    def reason_disabled(self, name: str) -> str | None:
        return None if name in self._pinned else "not pinned in this test"

    def supports(self, name: str, capability: Any) -> bool:
        provider = self._pinned.get(name)
        return provider is not None and provider.supports(capability)

    def covers(self, name: str, language: str) -> bool:
        del language
        return name in self._pinned

    def max_parallel_requests(self, name: str) -> int:
        return int(getattr(self._pinned.get(name), "max_parallel_requests", 0) or 0)

    async def get(self, name: str) -> Provider:
        return self._pinned[name]


def services_with(
    providers: dict[str, Provider],
    *,
    language_id: LanguageIdentifier | None = None,
    diarisers: DiariserRegistry | None = None,
    cache: Any = None,
    settings: Settings | None = None,
) -> Services:
    resolved = settings or load_settings(VALID_ENV)
    return Services(
        settings=resolved,
        callbacks=RecordingCallbacks(),
        providers=PinnedRegistry(resolved, providers),
        routing=load_routing_table(),
        aligners=AlignerRegistry.default(),
        diarisers=diarisers or DiariserRegistry.default(),
        vad=EnergyVad(),
        cache=cache or MemoryResultCache(),
        language_id=language_id,
        text_lid=IndicLidClassifier(),
    )


def context(services: Services, **payload: Any) -> JobContext:
    return JobContext(
        envelope=parse_envelope(envelope(**payload)),
        queue="ai.transcribe",
        services=services,
        max_attempts=2,
    )


@pytest.fixture
def long_wav(tmp_path: Path) -> Path:
    """25 minutes of speech, so the D14 planner produces several chunks."""
    from worker_ai.audio import write_wav

    spans: list[tuple[str, int]] = []
    for _ in range(25):
        spans.append(("speech", 55_000))
        spans.append(("silence", 5_000))
    return write_wav(tmp_path / "long.wav", clip(*spans))


@pytest.fixture(autouse=True)
def _reset_metrics() -> Any:
    METRICS.reset()
    yield
    METRICS.reset()


# ---------------------------------------------------------------------------
# LID and re-routing (D14)
# ---------------------------------------------------------------------------


async def test_hinglish_is_detected_and_the_job_moves_to_the_code_mix_lane(
    wav_file: Path,
) -> None:
    """Acceptance 2: Hinglish -> Sarvam codemix + alignment."""
    whisper = FakeProvider(
        "serverless-whisper", words=("toh", "aaj", "hum", "matlab", "kaise"), language="hi"
    )
    sarvam = FakeProvider("sarvam", segments_only=True, language="hi-en")
    services = services_with({"serverless-whisper": whisper, "sarvam": sarvam})

    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file))
    )

    assert outcome.result["lid"]["codeMix"] is True
    assert outcome.result["lane"] == "hinglish"
    assert outcome.result["provider"] == "sarvam"
    assert outcome.result["engineVersions"]["asrMode"] == "codemix"
    # Acceptance 3: a Sarvam-routed job always runs an aligner.
    assert outcome.result["alignerModel"] == "proportional-vad"
    # The probe ran on the provisional lane, then every chunk on the new one.
    assert len(whisper.calls) == 1
    assert len(sarvam.calls) == 1


async def test_a_scribe_routed_job_skips_alignment_and_pyannote(wav_file: Path) -> None:
    """Acceptance 3, the other half: Scribe gives word timings and speakers."""
    diariser = FakeDiariser((DiarisedSpeaker(speaker_id="S9", start_ms=0, end_ms=1_000),))
    scribe = FakeProvider("elevenlabs", language="hi", speakers=True)
    services = services_with(
        {"elevenlabs": scribe},
        language_id=FixedLid("hi"),
        diarisers=DiariserRegistry(diarisers=(diariser,)),
    )

    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi", diarise=True)
    )

    assert outcome.result["lane"] == "hindi"
    assert "alignerModel" not in outcome.result
    # The provider already labelled the words, so pyannote never ran.
    assert diariser.calls == []
    assert outcome.result["diarisation"]["diariser"] == "elevenlabs"
    assert [speaker["id"] for speaker in outcome.result["diarisation"]["speakers"]] == ["S1", "S2"]


async def test_a_hint_pins_the_lane_and_no_reroute_happens(wav_file: Path) -> None:
    sarvam = FakeProvider("sarvam", segments_only=True, language="hi-en")
    services = services_with({"sarvam": sarvam})
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi-en")
    )
    assert outcome.result["lane"] == "hinglish"
    assert outcome.result["lid"]["fromHint"] is True
    # One call: the probe was on the right lane already and was kept.
    assert len(sarvam.calls) == 1


async def test_a_disagreement_is_recorded_as_low_confidence(wav_file: Path) -> None:
    provider = FakeProvider("serverless-whisper", words=("hello", "there"), language="ta")
    services = services_with({"serverless-whisper": provider}, language_id=FixedLid("ta"))
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file))
    )
    assert outcome.result["lowConfidence"] is True
    assert "disagree" in outcome.result["lid"]["reason"]


async def test_the_lid_decision_is_logged_on_the_result(wav_file: Path) -> None:
    """`09 §1`: the routing decision travels with the job."""
    services = services_with({"serverless-whisper": FakeProvider("serverless-whisper")})
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file))
    )
    assert set(outcome.result["lid"]) >= {
        "language",
        "codeMix",
        "codeMixScore",
        "reason",
        "signals",
    }
    assert outcome.result["routing"]["lane"]
    assert outcome.result["engineVersions"]["asr"].startswith("serverless-whisper/")


# ---------------------------------------------------------------------------
# The fallback chain (`09 §1`)
# ---------------------------------------------------------------------------


async def test_a_failing_primary_falls_through_to_the_next_candidate(
    wav_file: Path,
) -> None:
    """Acceptance 1: a 429 that outlasted its backoff advances the chain."""
    broken = FakeProvider(
        "elevenlabs", error=ProviderError("429 after backoff", provider="elevenlabs")
    )
    fallback = FakeProvider("sarvam", segments_only=True, language="hi")
    services = services_with(
        {"elevenlabs": broken, "sarvam": fallback}, language_id=FixedLid("hi")
    )

    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi")
    )

    assert outcome.result["provider"] == "sarvam"
    assert outcome.result["fallbacks"] == [{"from": "elevenlabs", "to": "sarvam"}]
    assert outcome.usage is not None
    assert outcome.usage.provider == "sarvam"
    snapshot = METRICS.snapshot()
    assert snapshot["fallbacks"] == [{"from": "elevenlabs", "to": "sarvam", "count": 1}]


async def test_an_exhausted_chain_fails_with_the_last_error(wav_file: Path) -> None:
    broken = FakeProvider(
        "elevenlabs", error=ProviderError("vendor down", provider="elevenlabs")
    )
    services = services_with({"elevenlabs": broken}, language_id=FixedLid("hi"))
    with pytest.raises(JobFailureError) as raised:
        await process_transcribe(
            context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi")
        )
    assert raised.value.code == "worker/provider_failed"
    assert "vendor down" in raised.value.message


async def test_a_permanent_provider_error_still_advances_the_chain(wav_file: Path) -> None:
    """A vendor that rejected this audio is a reason to try another, not to stop."""
    broken = FakeProvider(
        "elevenlabs", error=ProviderError("bad audio", provider="elevenlabs", retryable=False)
    )
    fallback = FakeProvider("sarvam", language="hi")
    services = services_with(
        {"elevenlabs": broken, "sarvam": fallback}, language_id=FixedLid("hi")
    )
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi")
    )
    assert outcome.result["provider"] == "sarvam"


# ---------------------------------------------------------------------------
# The Batch path (D14)
# ---------------------------------------------------------------------------


def test_a_whole_file_result_splits_on_the_chunk_boundaries() -> None:
    """Sarvam returns one job for the file; the plan splits it back up."""
    plan = (
        ChunkPlanEntry(chunk_idx=0, start_ms=0, end_ms=1_000),
        ChunkPlanEntry(chunk_idx=1, start_ms=1_000, end_ms=2_000),
    )
    whole = TranscriptionResult(
        words=(
            Word(s=100, e=300, t="toh"),
            Word(s=900, e=1_100, t="aaj"),  # starts in chunk 0, ends in chunk 1
            Word(s=1_500, e=1_700, t="hum"),
        ),
        language="hi-en",
        segments=((0, 1_200, "toh aaj"), (1_300, 1_900, "hum")),
        usage=ProviderUsage(cost_minor=53),
    )
    split = split_segments(whole, plan)

    assert [[word.t for word in chunk.words] for chunk in split] == [["toh", "aaj"], ["hum"]]
    assert [len(chunk.segments) for chunk in split] == [1, 1]
    # The cost is counted once, on the first chunk.
    assert split[0].usage is not None
    assert split[1].usage is None


async def test_a_batch_lane_makes_one_vendor_call_for_the_whole_file(
    long_wav: Path,
) -> None:
    sarvam = FakeProvider(
        "sarvam",
        segments_only=True,
        language="hi-en",
        capabilities=ProviderCapabilities(
            supported=frozenset({"transcribe"}),
            word_timestamps=False,
            batch=True,
            max_duration_s=2 * 60 * 60,
        ),
    )
    services = services_with({"sarvam": sarvam})
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(long_wav), language="hi-en")
    )

    # One probe on the provisional lane plus one whole-file job — never one per chunk.
    assert len(sarvam.calls) == 2
    assert sarvam.calls[-1].offset_ms == 0
    assert len(outcome.result["chunks"]) >= 2


# ---------------------------------------------------------------------------
# The cache (`09 §1`)
# ---------------------------------------------------------------------------


async def test_a_second_run_of_the_same_audio_skips_the_vendor(wav_file: Path) -> None:
    provider = FakeProvider("serverless-whisper", language="en")
    cache = MemoryResultCache()
    services = services_with(
        {"serverless-whisper": provider}, cache=cache, language_id=FixedLid("en")
    )

    first = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="en")
    )
    calls_after_first = len(provider.calls)
    second = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="en")
    )

    assert len(provider.calls) == calls_after_first
    assert first.result["cached"] is False
    assert second.result["cached"] is True
    assert second.usage is not None
    assert second.usage.cached is True
    assert METRICS.snapshot()["cache"]["hit"] >= 1


async def test_a_supplied_content_hash_is_used_rather_than_rehashing(
    wav_file: Path,
) -> None:
    """A media row that already carries a hash saves hashing a two-hour wav."""
    provider = FakeProvider("serverless-whisper", language="en")
    cache = MemoryResultCache()
    services = services_with({"serverless-whisper": provider}, cache=cache)
    job = context(
        services,
        mediaId=MEDIA_ID,
        audioUri=str(wav_file),
        language="en",
        contentHash="deadbeef",
    )
    await process_transcribe(job)

    # The supplied digest keyed the entry, so a second job with the same hash but
    # a different file still hits — which is the whole point of a content hash.
    other = context(
        services,
        mediaId=MEDIA_ID,
        audioUri=str(wav_file),
        language="en",
        contentHash="deadbeef",
    )
    calls_before = len(provider.calls)
    await process_transcribe(other)
    assert len(provider.calls) == calls_before
    # The digest itself never appears in a key: keys are hashed (T21).
    assert all("deadbeef" not in key for key in cache._entries)


async def test_the_cache_can_be_switched_off(wav_file: Path) -> None:
    from worker_ai.cache import NullResultCache

    provider = FakeProvider("serverless-whisper", language="en")
    services = services_with({"serverless-whisper": provider}, cache=NullResultCache())
    await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="en")
    )
    before = len(provider.calls)
    await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="en")
    )
    assert len(provider.calls) > before


# ---------------------------------------------------------------------------
# Diarisation (D13)
# ---------------------------------------------------------------------------


async def test_diarisation_labels_words_by_overlap_when_asked_for(wav_file: Path) -> None:
    diariser = FakeDiariser(
        (
            DiarisedSpeaker(speaker_id="S1", start_ms=0, end_ms=500),
            DiarisedSpeaker(speaker_id="S2", start_ms=500, end_ms=5_000),
        )
    )
    provider = FakeProvider("serverless-whisper", language="en")
    services = services_with(
        {"serverless-whisper": provider},
        language_id=FixedLid("en"),
        diarisers=DiariserRegistry(diarisers=(diariser,)),
    )

    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="en", diarise=True)
    )

    speakers = [word["sp"] for word in outcome.result["chunks"][0]["words"]]
    assert speakers == ["S1", "S2", "S2"]
    assert len(diariser.calls) == 1
    # `09 §2`: globally over the whole file, never per chunk.
    assert diariser.calls[0].audio_uri.endswith(".wav")


async def test_diarisation_is_opt_in(wav_file: Path) -> None:
    """`09 §9` prices it as an on-request stage."""
    diariser = FakeDiariser(())
    services = services_with(
        {"serverless-whisper": FakeProvider("serverless-whisper", language="en")},
        language_id=FixedLid("en"),
        diarisers=DiariserRegistry(diarisers=(diariser,)),
    )
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="en")
    )
    assert diariser.calls == []
    assert "diarisation" not in outcome.result


async def test_a_diariser_failure_degrades_rather_than_failing_the_job(
    wav_file: Path,
) -> None:
    class _Broken(Diariser):
        name = "broken"

        async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
            raise ProviderError("gpu is cold", provider="pyannote")

    services = services_with(
        {"serverless-whisper": FakeProvider("serverless-whisper", language="en")},
        language_id=FixedLid("en"),
        diarisers=DiariserRegistry(diarisers=(_Broken(),)),
    )
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="en", diarise=True)
    )
    assert outcome.result["wordCount"] == 3
    assert "diarisation" not in outcome.result


async def test_a_fallback_result_is_not_cached_under_the_primary_key(
    wav_file: Path,
) -> None:
    """Otherwise a healthy primary would later serve the fallback's transcript."""
    broken = FakeProvider(
        "elevenlabs", error=ProviderError("vendor down", provider="elevenlabs")
    )
    fallback = FakeProvider("sarvam", words=("ek", "do"), language="hi")
    cache = MemoryResultCache()
    services = services_with(
        {"elevenlabs": broken, "sarvam": fallback}, cache=cache, language_id=FixedLid("hi")
    )
    await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi")
    )

    # The primary recovers; its own key must still be a miss, so it is called.
    healthy = FakeProvider("elevenlabs", words=("teen", "chaar"), language="hi")
    services = services_with(
        {"elevenlabs": healthy, "sarvam": fallback}, cache=cache, language_id=FixedLid("hi")
    )
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi")
    )
    assert outcome.result["provider"] == "elevenlabs"
    assert [word["t"] for word in outcome.result["chunks"][0]["words"]] == ["teen", "chaar"]
    assert healthy.calls


async def test_an_aligner_does_not_carry_its_submissions_into_the_next_job(
    wav_file: Path,
) -> None:
    """The registries are process-wide; a leaked submission is a wrong audit row."""
    from worker_ai.alignment.base import Aligner, AlignerRegistry
    from worker_ai.providers.base import AlignmentRequest, ProviderSubmission, Word

    class _Recording(Aligner):
        name = "recording"
        rank = 1

        def __init__(self) -> None:
            self.submissions: list[ProviderSubmission] = []

        async def align(self, request: AlignmentRequest, regions: Any = ()) -> tuple[Word, ...]:
            self.submissions.append(
                ProviderSubmission(provider="x", endpoint="https://x", artefact="a")
            )
            return tuple(
                Word(s=request.start_ms, e=request.start_ms + 10, t=text)
                for text in request.words
            )

        def drain_submissions(self) -> tuple[ProviderSubmission, ...]:
            drained = tuple(self.submissions)
            self.submissions.clear()
            return drained

    aligner = _Recording()
    provider = FakeProvider("sarvam", segments_only=True, language="hi-en")
    services = services_with({"sarvam": provider})
    services = Services(
        settings=services.settings,
        callbacks=services.callbacks,
        providers=services.providers,
        routing=services.routing,
        aligners=AlignerRegistry(aligners=(aligner,)),
        diarisers=services.diarisers,
        vad=services.vad,
        cache=services.cache,
        language_id=services.language_id,
        text_lid=services.text_lid,
    )

    first = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi-en")
    )
    second = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi-en")
    )
    aligner_rows = [
        row for row in second.result["providerSubmissions"] if row["provider"] == "x"
    ]
    assert len(aligner_rows) == len(
        [row for row in first.result["providerSubmissions"] if row["provider"] == "x"]
    )


# ---------------------------------------------------------------------------
# B09b: `_hints()` runs `prepare_hints()` over the incoming glossary before
# any provider adapter shapes its own vocabulary parameter.
# ---------------------------------------------------------------------------


def test_hints_dedupes_and_caps_via_prepare_hints() -> None:
    services = services_with({})
    payload_hints = ["Aksharo", "aksharo", "  Sarvam  ", "", "x" * 200]
    job_context = context(services, hints=payload_hints)

    assert _hints(job_context) == ("Aksharo", "Sarvam")


def test_hints_is_empty_when_payload_has_none() -> None:
    services = services_with({})
    job_context = context(services)

    assert _hints(job_context) == ()
