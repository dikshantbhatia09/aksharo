"""The Provider interface, the A09 adapters and the registry."""

from __future__ import annotations

import inspect
import json
from itertools import pairwise
from pathlib import Path
from typing import Any

import httpx2
import pytest

from worker_ai.providers import (
    AlignmentRequest,
    AssemblyAiProvider,
    DiarisationRequest,
    DiarisedSpeaker,
    ElevenLabsScribeProvider,
    LocalWhisperProvider,
    MockProvider,
    Provider,
    ProviderCapabilities,
    ProviderError,
    ProviderUnavailableError,
    SarvamSaarasProvider,
    ServerlessWhisperProvider,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
    build_registry,
)
from worker_ai.providers.local_whisper import (
    _build_initial_prompt,
    _resolve_compute_type,
    _resolve_device,
    words_from_segments,
)
from worker_ai.settings import load_settings

from .conftest import VALID_ENV

# ---------------------------------------------------------------------------
# The interface
# ---------------------------------------------------------------------------


class _StubProvider(Provider):
    """Minimal implementation proving the interface is implementable."""

    name = "stub"
    capabilities = ProviderCapabilities(supported=frozenset({"transcribe"}))
    cost_per_minute_inr = 0.35

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        return TranscriptionResult(
            words=(Word(s=request.offset_ms, e=request.offset_ms + 500, t="namaste"),),
            language=request.language or "hi-IN",
        )

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError


def test_provider_is_abstract() -> None:
    with pytest.raises(TypeError):
        Provider()  # type: ignore[abstract]


def test_every_capability_method_is_async() -> None:
    for name in ("transcribe", "align", "diarise"):
        assert inspect.iscoroutinefunction(getattr(Provider, name)), name


def test_supports_reports_declared_capabilities() -> None:
    provider = _StubProvider()
    assert provider.supports("transcribe") is True
    assert provider.supports("align") is False
    assert provider.supports("diarise") is False


async def test_transcribe_returns_words_with_millisecond_timings() -> None:
    provider = _StubProvider()
    result = await provider.transcribe(
        TranscriptionRequest(audio_uri="file:///tmp/audio16k.wav", offset_ms=1_000)
    )
    assert result.language == "hi-IN"
    assert len(result.words) == 1
    word = result.words[0]
    assert (word.s, word.e, word.t) == (1_000, 1_500, "namaste")
    assert word.scripts == {}
    assert word.filler is False


def test_words_are_immutable() -> None:
    """Frozen dataclasses stop a pass from mutating transcript data in place."""
    word = Word(s=0, e=100, t="hi")
    with pytest.raises((AttributeError, TypeError)):
        word.t = "bye"  # type: ignore[misc]


def test_provider_error_carries_retryability() -> None:
    transient = ProviderError("429 from provider", provider="sarvam")
    fatal = ProviderError("audio rejected", provider="sarvam", retryable=False)
    assert transient.retryable is True
    assert fatal.retryable is False
    assert fatal.provider == "sarvam"


def test_cost_estimate_is_the_list_price_rounded_up_to_the_paisa() -> None:
    """₹0.35/min over 60 s is 35 paise; a part-minute rounds up, never down."""
    provider = _StubProvider()
    assert provider.cost_estimate(60).minor == 35
    assert provider.cost_estimate(60).currency == "INR"
    assert provider.cost_estimate(1).minor == 1
    assert provider.cost_estimate(0).minor == 0


def test_cost_estimate_refuses_negative_media() -> None:
    with pytest.raises(ValueError, match="must not be negative"):
        _StubProvider().cost_estimate(-1)


def test_capabilities_serialise_for_the_control_app() -> None:
    wire = ElevenLabsScribeProvider("").capabilities.to_wire()
    assert wire["wordTimestamps"] is True
    assert wire["diarisation"] is True
    assert "hi" in wire["languages"]
    assert sorted(wire["supported"]) == ["align", "diarise", "transcribe"]


def test_the_a10_shells_carry_the_facts_the_routing_table_relies_on() -> None:
    """Sarvam has no word timings, which is why its lane demands an aligner."""
    assert SarvamSaarasProvider("").capabilities.word_timestamps is False
    assert SarvamSaarasProvider("").capabilities.batch is True
    assert SarvamSaarasProvider("").cost_per_minute_inr == pytest.approx(0.53)
    assert AssemblyAiProvider("").cost_per_minute_inr == pytest.approx(0.24)
    assert ElevenLabsScribeProvider("").cost_per_minute_inr == pytest.approx(0.35)


async def test_a_vendor_never_claims_a_capability_it_does_not_have() -> None:
    """Sarvam has no alignment and no diarisation; AssemblyAI has no alignment."""
    with pytest.raises(NotImplementedError, match="forced alignment"):
        await SarvamSaarasProvider("k").align(
            AlignmentRequest(audio_uri="x", words=("a",), language="hi")
        )
    with pytest.raises(NotImplementedError, match="pyannote"):
        await SarvamSaarasProvider("k").diarise(DiarisationRequest(audio_uri="x"))
    with pytest.raises(NotImplementedError, match="standalone alignment"):
        await AssemblyAiProvider("k").align(
            AlignmentRequest(audio_uri="x", words=("a",), language="en")
        )


# ---------------------------------------------------------------------------
# MockProvider
# ---------------------------------------------------------------------------


async def test_mock_is_deterministic_for_the_same_audio() -> None:
    provider = MockProvider()
    request = TranscriptionRequest(audio_uri="file:///chunk-0.wav")
    first = await provider.transcribe(request)
    second = await provider.transcribe(request)
    assert [word.t for word in first.words] == [word.t for word in second.words]
    assert [word.s for word in first.words] == [word.s for word in second.words]


async def test_mock_timings_are_monotonic_and_offset_by_the_chunk() -> None:
    result = await MockProvider().transcribe(
        TranscriptionRequest(audio_uri="file:///chunk-3.wav", offset_ms=1_800_000)
    )
    assert result.words[0].s == 1_800_000
    for previous, following in pairwise(result.words):
        assert previous.s < previous.e <= following.s


async def test_mock_differs_between_chunks_of_one_file() -> None:
    provider = MockProvider()
    first = await provider.transcribe(TranscriptionRequest(audio_uri="chunk-0"))
    second = await provider.transcribe(TranscriptionRequest(audio_uri="chunk-1"))
    assert [word.t for word in first.words] != [word.t for word in second.words]


async def test_mock_reads_a_word_fixture_verbatim(tmp_path: Path) -> None:
    """A pinned fixture is not rotated: the eval harness compares it to a reference."""
    fixture = tmp_path / "words.json"
    fixture.write_text(json.dumps({"words": ["toh", "aaj", "hum"]}), encoding="utf-8")
    result = await MockProvider().transcribe(
        TranscriptionRequest(audio_uri="anything", options={"wordFixture": str(fixture)})
    )
    assert [word.t for word in result.words] == ["toh", "aaj", "hum"]


async def test_mock_accepts_a_bare_json_list(tmp_path: Path) -> None:
    fixture = tmp_path / "words.json"
    fixture.write_text('["ek", "do"]', encoding="utf-8")
    result = await MockProvider().transcribe(
        TranscriptionRequest(audio_uri="x", options={"wordFixture": str(fixture)})
    )
    assert [word.t for word in result.words] == ["ek", "do"]


async def test_mock_rejects_an_unreadable_fixture(tmp_path: Path) -> None:
    with pytest.raises(ProviderError) as raised:
        await MockProvider().transcribe(
            TranscriptionRequest(
                audio_uri="x", options={"wordFixture": str(tmp_path / "missing.json")}
            )
        )
    assert raised.value.retryable is False


async def test_mock_rejects_a_fixture_that_is_not_a_list(tmp_path: Path) -> None:
    fixture = tmp_path / "words.json"
    fixture.write_text('"toh"', encoding="utf-8")
    with pytest.raises(ProviderError, match="list of words"):
        await MockProvider().transcribe(
            TranscriptionRequest(audio_uri="x", options={"wordFixture": str(fixture)})
        )


async def test_mock_records_a_provider_submission() -> None:
    result = await MockProvider().transcribe(TranscriptionRequest(audio_uri="chunk-0"))
    assert result.submissions[0].to_wire() == {
        "provider": "mock",
        "endpoint": "local://mock",
        "artefact": "chunk-0",
        "retentionClass": "none",
    }


async def test_mock_aligns_inside_the_requested_span() -> None:
    result = await MockProvider().align(
        AlignmentRequest(
            audio_uri="", words=("ek", "do", "teen"), language="hi", start_ms=0, end_ms=3_000
        )
    )
    assert len(result.words) == 3
    assert result.words[0].s >= 0
    assert result.words[-1].e <= 3_100


async def test_mock_diarises_the_regions_it_is_given() -> None:
    turns = await MockProvider().diarise(
        DiarisationRequest(audio_uri="", regions=((0, 1_000), (2_000, 3_000)))
    )
    assert [turn.speaker_id for turn in turns] == ["S1", "S1"]


# ---------------------------------------------------------------------------
# ServerlessWhisperProvider
# ---------------------------------------------------------------------------


def _gpu(handler: Any) -> ServerlessWhisperProvider:
    return ServerlessWhisperProvider(
        "https://gpu.invalid",
        token="secret-token",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )


async def test_serverless_converts_seconds_to_milliseconds_and_applies_the_offset() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx2.Request) -> httpx2.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx2.Response(
            200,
            json={
                "language": "hi",
                "languageProbability": 0.97,
                "durationS": 12.5,
                "model": "large-v3-turbo",
                "requestId": "req-42",
                "words": [
                    {"start": 0.12, "end": 0.44, "word": "toh", "probability": 0.94},
                    {"start": 0.5, "end": 0.9, "word": " aaj "},
                ],
            },
        )

    provider = _gpu(handler)
    result = await provider.transcribe(
        TranscriptionRequest(
            audio_uri="https://r2/audio.wav",
            language="hi",
            hints=("Aksharo",),
            offset_ms=600_000,
        )
    )
    await provider.aclose()

    assert seen["url"] == "https://gpu.invalid/transcribe"
    assert seen["auth"] == "Bearer secret-token"
    assert seen["body"]["hints"] == ["Aksharo"]
    assert seen["body"]["wordTimestamps"] is True
    assert [(word.s, word.e, word.t) for word in result.words] == [
        (600_120, 600_440, "toh"),
        (600_500, 600_900, "aaj"),
    ]
    assert result.words[0].c == 0.94
    assert result.language == "hi"
    assert result.language_confidence == 0.97
    assert result.usage is not None
    assert result.usage.media_seconds == 12.5
    # ₹0.11/min over 12.5 s is 2.29 paise, rounded up.
    assert result.usage.cost_minor == 3
    assert result.submissions[0].external_ref == "req-42"
    assert result.submissions[0].retention_class == "ephemeral"


async def test_serverless_keeps_segments_when_there_are_no_word_timings() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "language": "hi",
                "segments": [{"start": 1.0, "end": 4.0, "text": "toh aaj hum"}],
            },
        )

    provider = _gpu(handler)
    result = await provider.transcribe(TranscriptionRequest(audio_uri="x", offset_ms=1_000))
    await provider.aclose()

    assert result.words == ()
    assert result.segments == ((2_000, 5_000, "toh aaj hum"),)


async def test_serverless_treats_an_empty_response_as_a_permanent_failure() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"language": "hi"})

    provider = _gpu(handler)
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="x"))
    await provider.aclose()
    assert raised.value.retryable is False


async def test_serverless_does_not_retry_a_4xx() -> None:
    calls = 0

    async def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        return httpx2.Response(401, json={"error": "bad token"})

    provider = _gpu(handler)
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="x"))
    await provider.aclose()
    assert calls == 1
    assert raised.value.retryable is False


async def test_serverless_retries_a_5xx_then_succeeds() -> None:
    calls = 0

    async def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx2.Response(503, json={})
        return httpx2.Response(
            200, json={"language": "en", "words": [{"start": 0, "end": 1, "word": "hi"}]}
        )

    provider = ServerlessWhisperProvider(
        "https://gpu.invalid",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        max_attempts=2,
    )
    result = await provider.transcribe(TranscriptionRequest(audio_uri="x"))
    await provider.aclose()
    assert calls == 2
    assert result.words[0].t == "hi"


async def test_serverless_gives_up_with_a_retryable_error() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(500, json={})

    provider = ServerlessWhisperProvider(
        "https://gpu.invalid",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        max_attempts=2,
    )
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="x"))
    await provider.aclose()
    assert raised.value.retryable is True


def test_serverless_needs_a_url() -> None:
    with pytest.raises(ValueError, match="GPU_PROVIDER_URL"):
        ServerlessWhisperProvider("")


# ---------------------------------------------------------------------------
# LocalWhisperProvider
# ---------------------------------------------------------------------------


class _FakeWord:
    def __init__(self, start: float, end: float, word: str, probability: float) -> None:
        self.start, self.end, self.word, self.probability = start, end, word, probability


class _FakeSegment:
    def __init__(self, start: float, end: float, text: str, words: list[Any] | None) -> None:
        self.start, self.end, self.text, self.words = start, end, text, words


class _FakeInfo:
    language = "en"
    language_probability = 0.99
    duration = 5.0


class _FakeWhisper:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
        self.calls.append({"audio": audio, **kwargs})
        return (
            [
                _FakeSegment(
                    0.0,
                    1.0,
                    "hello there",
                    [_FakeWord(0.1, 0.42, " hello", 0.9), _FakeWord(0.5, 0.98, " there", 0.8)],
                )
            ],
            _FakeInfo(),
        )


def test_words_from_segments_converts_seconds_and_trims() -> None:
    segments = [
        _FakeSegment(0.0, 1.0, "hello", [_FakeWord(0.1, 0.42, " hello ", 0.9)]),
        # A segment with no word timings degrades to one word rather than vanishing.
        _FakeSegment(1.5, 2.0, " there ", None),
        _FakeSegment(2.5, 3.0, "   ", None),
    ]
    words = words_from_segments(segments, offset_ms=10_000)
    assert [(word.s, word.e, word.t) for word in words] == [
        (10_100, 10_420, "hello"),
        (11_500, 12_000, "there"),
    ]
    assert words[0].c == 0.9


async def test_local_whisper_passes_the_pipeline_options_through() -> None:
    fake = _FakeWhisper()
    provider = LocalWhisperProvider(model_name="tiny", model_factory=lambda: fake)
    result = await provider.transcribe(
        TranscriptionRequest(audio_uri="chunk.wav", language="en", hints=("Aksharo", "EDG"))
    )

    call = fake.calls[0]
    assert call["word_timestamps"] is True
    # VAD already ran in the worker (D14); running it again would shift timings.
    assert call["vad_filter"] is False
    assert call["language"] == "en"
    assert call["initial_prompt"] == "Aksharo, EDG"
    assert [word.t for word in result.words] == ["hello", "there"]
    assert result.usage is not None
    assert result.usage.model == "tiny"
    assert result.usage.cost_minor == 0
    assert result.submissions[0].endpoint == "local://faster-whisper"


async def test_local_whisper_loads_the_model_once() -> None:
    loads = 0

    def factory() -> Any:
        nonlocal loads
        loads += 1
        return _FakeWhisper()

    provider = LocalWhisperProvider(model_factory=factory)
    await provider.transcribe(TranscriptionRequest(audio_uri="a.wav"))
    await provider.transcribe(TranscriptionRequest(audio_uri="b.wav"))
    assert loads == 1


async def test_local_whisper_wraps_a_model_failure_as_retryable() -> None:
    class _Exploding:
        def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
            raise RuntimeError("CTranslate2 died")

    provider = LocalWhisperProvider(model_factory=_Exploding)
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="a.wav"))
    assert raised.value.retryable is True


async def test_local_whisper_does_not_claim_alignment_or_diarisation() -> None:
    provider = LocalWhisperProvider(model_factory=_FakeWhisper)
    with pytest.raises(NotImplementedError):
        await provider.align(AlignmentRequest(audio_uri="", words=(), language="en"))
    with pytest.raises(NotImplementedError):
        await provider.diarise(DiarisationRequest(audio_uri=""))


def test_initial_prompt_carries_only_the_callers_hints() -> None:
    """No hardcoded vocabulary: every term comes from the glossary/hints (B09)."""
    assert _build_initial_prompt(()) is None
    assert _build_initial_prompt(("Aksharo", "EDG")) == "Aksharo, EDG"
    assert _build_initial_prompt(("  spaced  ", "", "term")) == "spaced, term"


def test_resolve_device_honours_an_explicit_choice() -> None:
    assert _resolve_device("cpu") == "cpu"
    assert _resolve_device("CUDA") == "cuda"


def test_resolve_device_auto_never_raises_even_without_the_extra() -> None:
    # No claim about which device comes back on this machine — only that a
    # missing/broken GPU stack degrades to an answer, never an exception.
    assert _resolve_device("auto") in ("cpu", "cuda")
    assert _resolve_device("") in ("cpu", "cuda")


def test_resolve_compute_type_defaults_by_device_but_an_explicit_choice_wins() -> None:
    assert _resolve_compute_type("", "cuda") == "int8_float16"
    assert _resolve_compute_type("", "cpu") == "int8"
    assert _resolve_compute_type("float16", "cpu") == "float16"


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


def test_a_bare_environment_enables_the_mock_and_nothing_that_needs_a_key() -> None:
    registry = build_registry(load_settings(VALID_ENV))
    rows = {row.name: row for row in registry.describe()}

    assert rows["mock"].enabled is True
    assert rows["serverless-whisper"].enabled is False
    assert "GPU_PROVIDER_URL" in (rows["serverless-whisper"].reason or "")
    for vendor, variable in (
        ("elevenlabs", "ELEVENLABS_API_KEY"),
        ("sarvam", "SARVAM_API_KEY"),
        ("assemblyai", "ASSEMBLYAI_API_KEY"),
    ):
        assert rows[vendor].enabled is False
        assert rows[vendor].implemented is True
        assert variable in (rows[vendor].reason or "")


def test_a_vendor_key_enables_its_adapter() -> None:
    registry = build_registry(load_settings({**VALID_ENV, "SARVAM_API_KEY": "sk-not-real"}))
    assert registry.enabled("sarvam") is True
    assert registry.supports("sarvam", "transcribe") is True
    # Sarvam has no word timings, which is what makes its lane demand an aligner.
    assert registry.supports("sarvam", "align") is False


def test_bhashini_has_no_adapter_at_all() -> None:
    """RR-02 F3 / D63: proof-of-concept-only terms keep it out of every lane."""
    registry = build_registry(load_settings(VALID_ENV))
    assert "bhashini" not in registry.names
    assert "no adapter" in (registry.reason_disabled("bhashini") or "")


def test_coverage_is_open_for_an_adapter_that_declares_no_languages() -> None:
    registry = build_registry(load_settings(VALID_ENV))
    assert registry.covers("serverless-whisper", "fr") is True
    assert registry.covers("elevenlabs", "ta-IN") is True
    assert registry.covers("elevenlabs", "doi") is False
    assert registry.covers("deepgram", "en") is False


def test_the_registry_reports_each_adapter_rate_limit() -> None:
    registry = build_registry(load_settings(VALID_ENV))
    # One batch job per file: there is nothing to fan out (RR-02 F1).
    assert registry.max_parallel_requests("sarvam") == 1
    assert registry.max_parallel_requests("elevenlabs") > 1
    assert registry.max_parallel_requests("deepgram") == 0


def test_a_configured_gpu_endpoint_enables_the_serverless_adapter() -> None:
    registry = build_registry(
        load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.example/v1"})
    )
    assert registry.enabled("serverless-whisper") is True
    # With a real lane available the mock stops being a default.
    assert registry.enabled("mock") is False


def test_the_mock_can_be_forced_back_on() -> None:
    registry = build_registry(
        load_settings(
            {
                **VALID_ENV,
                "GPU_PROVIDER_URL": "https://gpu.example/v1",
                "WORKER_AI_ALLOW_MOCK": "1",
            }
        )
    )
    assert registry.enabled("mock") is True


def test_a_feature_flag_switches_a_provider_off() -> None:
    registry = build_registry(
        load_settings(
            {
                **VALID_ENV,
                "GPU_PROVIDER_URL": "https://gpu.example/v1",
                "FEATURE_FLAGS_JSON": '{"asr.serverless-whisper": false}',
            }
        )
    )
    assert registry.enabled("serverless-whisper") is False
    assert "asr.serverless-whisper" in (registry.reason_disabled("serverless-whisper") or "")


def test_an_unknown_provider_is_reported_not_raised() -> None:
    registry = build_registry(load_settings(VALID_ENV))
    assert registry.enabled("deepgram") is False
    assert "no adapter" in (registry.reason_disabled("deepgram") or "")
    assert registry.supports("deepgram", "transcribe") is False


async def test_getting_a_disabled_provider_raises_with_the_reason() -> None:
    registry = build_registry(load_settings(VALID_ENV))
    with pytest.raises(ProviderUnavailableError) as raised:
        await registry.get("sarvam")
    assert raised.value.provider == "sarvam"
    assert "SARVAM_API_KEY" in raised.value.reason


async def test_instances_are_cached_and_closed() -> None:
    registry = build_registry(load_settings(VALID_ENV))
    first = await registry.get("mock")
    assert first is await registry.get("mock")
    await registry.aclose()


def test_supports_answers_from_the_capability_record() -> None:
    registry = build_registry(load_settings(VALID_ENV))
    assert registry.supports("mock", "transcribe") is True
    assert registry.supports("sarvam", "transcribe") is False  # disabled here
