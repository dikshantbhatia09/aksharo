"""``ai.transcribe`` with no language to go on, and with two local Whisper models.

The owner made "auto" the clips default (2026-09-27). "auto" must behave exactly
like no hint at all: probe on the default lane, let both LID signals decide, and
report what they decided — never ``"auto"`` itself, and never a Hindi default.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from worker_ai.cache import MemoryResultCache
from worker_ai.lid import LanguageSignal, decide_language, pinned_language
from worker_ai.processors import JobFailureError, process_transcribe
from worker_ai.providers import local_whisper as local_whisper_module
from worker_ai.providers.base import ProviderError, TranscriptionRequest, TranscriptionResult
from worker_ai.providers.local_whisper import ENGLISH_FAMILY, LocalWhisperProvider

from .conftest import MEDIA_ID

# `long_wav` is a fixture of the pipeline suite; importing it registers it here.
from .test_transcribe_pipeline import (
    FakeProvider,
    FixedLid,
    context,
    long_wav,  # noqa: F401
    services_with,
)

ENGLISH = ("so", "here", "is", "the", "thing", "about", "editing")
HINGLISH = ("toh", "aaj", "hum", "matlab", "kaise", "karte", "hain")


# ---------------------------------------------------------------------------
# "auto" is not a hint
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("hint", ["auto", "AUTO", " auto ", "und", "unknown", "", None])
def test_auto_and_its_spellings_pin_nothing(hint: str | None) -> None:
    assert pinned_language(hint) is None


@pytest.mark.parametrize(
    ("hint", "pinned"),
    [
        ("en-IN", "en-IN"),
        ("hi-Latn", "hi"),
        ("hinglish", "hi-en"),
        ("hi-en", "hi-en"),
        ("ps", "ps"),
    ],
)
def test_a_real_hint_still_pins(hint: str, pinned: str) -> None:
    assert pinned_language(hint) == pinned


def test_an_auto_hint_leaves_the_decision_to_the_signals() -> None:
    decision = decide_language(
        acoustic=LanguageSignal(source="provider", language="en", confidence=0.97),
        textual=LanguageSignal(source="indiclid", language="en", confidence=0.9),
        hint="auto",
    )
    assert decision.language == "en"
    assert decision.from_hint is False


@pytest.mark.parametrize(
    ("acoustic", "textual"),
    [("ur", ""), ("ur", "ur"), ("ur-PK", "hi"), ("hi", "ur")],
)
def test_an_unpinned_urdu_detection_is_heard_as_hindi(acoustic: str, textual: str) -> None:
    decision = decide_language(
        acoustic=LanguageSignal(source="provider", language=acoustic, confidence=0.9),
        textual=LanguageSignal(source="indiclid", language=textual, confidence=0.9),
        hint="auto",
    )
    assert decision.language == "hi"
    heard = [signal.detail.get("heard") for signal in decision.signals]
    assert any(value is not None and value.startswith("ur") for value in heard)


def test_a_pinned_urdu_is_never_second_guessed() -> None:
    decision = decide_language(
        acoustic=LanguageSignal(source="provider", language="ur", confidence=0.9),
        textual=LanguageSignal(source="indiclid", language="", confidence=0.0),
        hint="ur",
    )
    assert decision.language == "ur"
    assert decision.from_hint is True


async def test_an_auto_job_reports_the_language_it_detected(wav_file: Path) -> None:
    """Before: the transcript's language was the literal string "auto"."""
    whisper = FakeProvider("serverless-whisper", words=ENGLISH, language="en")
    services = services_with({"serverless-whisper": whisper})

    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="auto")
    )

    assert outcome.result["language"] == "en"
    assert outcome.result["lid"]["fromHint"] is False
    assert outcome.result["lane"] == "global"
    # The probe went out with no language: this is a detection, not a pin.
    assert whisper.calls[0].language is None
    for chunk in outcome.result["chunks"]:
        assert chunk.get("language", "en") != "auto"
    # A vendor names no local weights.
    assert "asrWeights" not in outcome.result["engineVersions"]


async def test_an_auto_job_of_hinglish_speech_reaches_the_code_mix_lane(wav_file: Path) -> None:
    whisper = FakeProvider("serverless-whisper", words=HINGLISH, language="hi")
    sarvam = FakeProvider("sarvam", segments_only=True, language="hi-en")
    services = services_with({"serverless-whisper": whisper, "sarvam": sarvam})

    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="auto")
    )

    assert outcome.result["lane"] == "hinglish"
    assert outcome.result["language"] == "hi-en"
    assert outcome.result["lid"]["codeMix"] is True


async def test_a_real_hint_is_still_reported_verbatim(wav_file: Path) -> None:
    """``hi-Latn`` carries the script the API reads; it must survive untouched."""
    provider = FakeProvider("elevenlabs", words=HINGLISH, language="hi")
    services = services_with({"elevenlabs": provider})
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi-Latn")
    )
    assert outcome.result["language"] == "hi-Latn"
    assert outcome.result["lid"]["fromHint"] is True


# ---------------------------------------------------------------------------
# The acoustic signal when the probe ran on local-whisper
# ---------------------------------------------------------------------------


class _LocalFake(FakeProvider):
    """A local-whisper fake that says which family of weights answered."""

    def __init__(self, *, family: str, **kwargs: Any) -> None:
        super().__init__("local-whisper", **kwargs)
        self.family = family

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        result = await super().transcribe(request)
        return replace(result, raw={"model": "C:/models/" + self.family, "family": self.family})


async def test_a_local_whisper_probe_is_its_own_acoustic_signal(wav_file: Path) -> None:
    """The dedicated identifier (the fine-tune, on the CPU) is not consulted.

    Here it would say Hindi about English speech — what the fine-tune does —
    and, as the acoustic signal, it decides a disagreement.
    """
    local = _LocalFake(family=ENGLISH_FAMILY, words=ENGLISH, language="en")
    services = services_with({"local-whisper": local}, language_id=FixedLid("hi"))

    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="auto")
    )

    signals = outcome.result["lid"]["signals"]
    assert [signal["source"] for signal in signals] == ["provider", "indiclid"]
    assert signals[0]["language"] == "en"
    assert outcome.result["language"] == "en"
    assert outcome.result["lane"] == "global"


def _whisper_factory(
    languages: dict[str, tuple[str, tuple[str, ...]]], calls: list[tuple[str, dict[str, Any]]]
) -> Any:
    """A model factory: per weights, the language it detects and the words it writes."""

    class _Segment:
        def __init__(self, text: str) -> None:
            self.start, self.end, self.text, self.words = 0.0, 0.5, text, None

    class _Model:
        def __init__(self, weights: str) -> None:
            self.weights = weights

        def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
            calls.append((self.weights, kwargs))
            detected, words = languages[self.weights]
            info = type(
                "Info",
                (),
                {
                    "language": kwargs.get("language") or detected,
                    "language_probability": 1.0,
                    "duration": 1.0,
                },
            )()
            return [_Segment(" ".join(words))], info

    return _Model


async def test_the_fine_tunes_detection_is_not_the_acoustic_signal(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``WORKER_AI_WHISPER_MODEL_EN`` unset: the fine-tune probes "auto" jobs.

    It says ``en`` at 1.0 about everything. Before, that was trusted as the
    acoustic signal, beat the text signal's Hinglish, and the job went down the
    English lane labelled English. Now it is no opinion and the text decides.
    """
    monkeypatch.setattr(local_whisper_module, "_prepare_cleaned_audio", lambda uri: (uri, False))
    calls: list[tuple[str, dict[str, Any]]] = []
    provider = LocalWhisperProvider(
        model_name="C:/models/whisper-hindi2hinglish-apex",
        model_factory=_whisper_factory(
            {"C:/models/whisper-hindi2hinglish-apex": ("en", HINGLISH)}, calls
        ),
    )

    outcome = await process_transcribe(
        context(
            services_with({"local-whisper": provider}),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="auto",
        )
    )

    acoustic = outcome.result["lid"]["signals"][0]
    assert acoustic["language"] == ""
    assert "ignored" in acoustic["detail"]
    assert outcome.result["language"] == "hi"
    assert outcome.result["lane"] == "hindi"
    # The record says what ran, whatever the table called it.
    assert outcome.result["engineVersions"]["asrWeights"] == "whisper-hindi2hinglish-apex"


async def test_the_general_weights_detection_is_the_acoustic_signal(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(local_whisper_module, "_prepare_cleaned_audio", lambda uri: (uri, False))
    calls: list[tuple[str, dict[str, Any]]] = []
    provider = LocalWhisperProvider(
        model_name="C:/models/fine-tune",
        english_model_name="C:/models/faster-whisper-large-v3-turbo",
        model_factory=_whisper_factory(
            {
                "C:/models/fine-tune": ("en", HINGLISH),
                "C:/models/faster-whisper-large-v3-turbo": ("en", ENGLISH),
            },
            calls,
        ),
    )

    outcome = await process_transcribe(
        context(
            services_with({"local-whisper": provider}),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="auto",
        )
    )

    assert outcome.result["lid"]["signals"][0]["language"] == "en"
    assert outcome.result["language"] == "en"
    assert outcome.result["lane"] == "global"
    assert outcome.result["engineVersions"]["asrWeights"] == "faster-whisper-large-v3-turbo"
    assert outcome.result["model"] == "large-v3-turbo"


async def test_hindi_that_whisper_calls_urdu_goes_to_the_hindi_lane(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before: ``ur`` alone (the Arabic-script text gives no second opinion)
    routed a Hindi speaker to Sarvam's Urdu lane and an Urdu-script transcript."""
    monkeypatch.setattr(local_whisper_module, "_prepare_cleaned_audio", lambda uri: (uri, False))
    calls: list[tuple[str, dict[str, Any]]] = []
    provider = LocalWhisperProvider(
        model_name="C:/models/fine-tune",
        english_model_name="C:/models/turbo",
        model_factory=_whisper_factory(
            {
                "C:/models/fine-tune": ("hi", HINGLISH),
                "C:/models/turbo": ("ur", ("یہ", "بات", "ہے")),
            },
            calls,
        ),
    )

    outcome = await process_transcribe(
        context(
            services_with({"local-whisper": provider}),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="auto",
        )
    )

    acoustic = outcome.result["lid"]["signals"][0]
    assert acoustic["language"] == "hi"
    assert acoustic["detail"]["heard"] == "ur"
    assert outcome.result["lane"] == "hindi"
    assert outcome.result["language"] == "hi"


# ---------------------------------------------------------------------------
# A pinned job's probe carries the pin
# ---------------------------------------------------------------------------


async def test_a_pinned_job_sends_its_language_with_the_probe(wav_file: Path) -> None:
    """Before: the probe went out with no language, and — the pin keeping the lane —
    was kept. A real detector could decode that whole first chunk as Hindi."""
    local = FakeProvider("local-whisper", words=ENGLISH, language="en")
    outcome = await process_transcribe(
        context(
            services_with({"local-whisper": local}),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="en-IN",
        )
    )
    assert outcome.result["language"] == "en-IN"
    assert [call.language for call in local.calls] == ["en-IN"] * len(local.calls)


async def test_every_chunk_of_an_en_in_job_reaches_whisper_as_english(
    long_wav: Path,  # noqa: F811 - the imported fixture
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reviewer's scratch run, as a test: the calls were ``[None, 'en', 'en']``."""
    monkeypatch.setattr(local_whisper_module, "_prepare_cleaned_audio", lambda uri: (uri, False))
    calls: list[tuple[str, dict[str, Any]]] = []
    provider = LocalWhisperProvider(
        model_name="C:/models/fine-tune",
        english_model_name="C:/models/turbo",
        model_factory=_whisper_factory(
            {"C:/models/fine-tune": ("hi", HINGLISH), "C:/models/turbo": ("hi", ENGLISH)}, calls
        ),
    )
    await process_transcribe(
        context(
            services_with({"local-whisper": provider}),
            mediaId=MEDIA_ID,
            audioUri=str(long_wav),
            language="en-IN",
            chunkPlan=[
                {"chunkIdx": 0, "startMs": 0, "endMs": 600_000},
                {"chunkIdx": 1, "startMs": 600_000, "endMs": 1_200_000},
                {"chunkIdx": 2, "startMs": 1_200_000, "endMs": 1_500_000},
            ],
        )
    )
    assert [kwargs.get("language") for _, kwargs in calls] == ["en", "en", "en"]
    assert {weights for weights, _ in calls} == {"C:/models/turbo"}


# ---------------------------------------------------------------------------
# Retrying, and the cache
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("sarvam_retryable", "expected"), [(True, True), (False, False)])
async def test_a_job_is_retried_when_any_candidate_could_answer_later(
    wav_file: Path, sarvam_retryable: bool, expected: bool
) -> None:
    """Before: only the last candidate's error counted, so a Sarvam 429 followed
    by a local-whisper refusal failed a Hindi job for good."""
    sarvam = FakeProvider(
        "sarvam", error=ProviderError("429", provider="sarvam", retryable=sarvam_retryable)
    )
    local = FakeProvider(
        "local-whisper", error=ProviderError("refused", provider="local-whisper", retryable=False)
    )
    services = services_with({"sarvam": sarvam, "local-whisper": local})

    with pytest.raises(JobFailureError) as raised:
        await process_transcribe(
            context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="hi")
        )
    assert raised.value.retryable is expected
    assert len(sarvam.calls) == 1 and len(local.calls) == 1


async def test_the_cache_never_serves_one_glossarys_transcript_for_another(
    wav_file: Path,
) -> None:
    """Two workspaces repurposing the same video share audio, not glossaries."""
    whisper = FakeProvider("serverless-whisper", words=ENGLISH, language="en")
    services = services_with({"serverless-whisper": whisper}, cache=MemoryResultCache())

    async def run(hints: list[str] | None) -> Any:
        payload: dict[str, Any] = {"contentHash": "same-audio", "language": "en"}
        if hints is not None:
            payload["hints"] = hints
        return await process_transcribe(
            context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), **payload)
        )

    assert (await run(["Aksharo", "Shirorekha"])).result["cached"] is False
    assert (await run(["Kalakar"])).result["cached"] is False
    assert (await run(["Aksharo", "Shirorekha"])).result["cached"] is True
    assert (await run(None)).result["cached"] is False
    assert (await run(None)).result["cached"] is True
    assert len(whisper.calls) == 3


async def test_a_transcript_the_default_weights_made_in_place_of_english_is_not_cached_as_english(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The English weights failed during the call: the lookup key assumed them."""
    monkeypatch.setattr(local_whisper_module, "_prepare_cleaned_audio", lambda uri: (uri, False))
    cache = MemoryResultCache()

    def factory(broken: bool) -> Any:
        def build(weights: str) -> _Weights:
            if broken and weights == "general":
                raise RuntimeError("CUDA failed with error out of memory")
            return _Weights(weights)

        return build

    failing = LocalWhisperProvider(
        model_name="fine-tune", english_model_name="general", model_factory=factory(True)
    )
    first = await process_transcribe(
        context(
            services_with({"local-whisper": failing}, cache=cache),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="en",
        )
    )
    assert first.result["chunks"][0]["words"][0]["t"] == "from-fine-tune"

    working = LocalWhisperProvider(
        model_name="fine-tune", english_model_name="general", model_factory=factory(False)
    )
    second = await process_transcribe(
        context(
            services_with({"local-whisper": working}, cache=cache),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="en",
        )
    )
    assert second.result["cached"] is False
    assert second.result["chunks"][0]["words"][0]["t"] == "from-general"


async def test_a_vendor_probe_still_consults_the_identifier(wav_file: Path) -> None:
    vendor = FakeProvider("serverless-whisper", words=ENGLISH, language="en")
    services = services_with({"serverless-whisper": vendor}, language_id=FixedLid("en"))
    outcome = await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language="auto")
    )
    assert outcome.result["lid"]["signals"][0]["source"] == "whisper"


# ---------------------------------------------------------------------------
# local-whisper is told which weights its lane runs
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("hint", "model"),
    [
        ("en", "large-v3-turbo"),
        ("en-IN", "large-v3-turbo"),
        ("auto", "large-v3-turbo"),
        ("hi", "whisper-hindi2hinglish-apex"),
        ("hi-Latn", "whisper-hindi2hinglish-apex"),
    ],
)
async def test_every_local_whisper_call_carries_its_lanes_model(
    wav_file: Path, hint: str, model: str
) -> None:
    words = ENGLISH if model == "large-v3-turbo" else HINGLISH
    language = "en" if model == "large-v3-turbo" else "hi"
    local = FakeProvider("local-whisper", words=words, language=language)
    services = services_with({"local-whisper": local})

    await process_transcribe(
        context(services, mediaId=MEDIA_ID, audioUri=str(wav_file), language=hint)
    )

    assert local.calls
    assert {call.options.get("model") for call in local.calls} == {model}


class _Segment:
    def __init__(self, start: float, end: float, text: str) -> None:
        self.start, self.end, self.text, self.words = start, end, text, None


class _Info:
    language = "en"
    language_probability = 0.99
    duration = 1.0


class _Weights:
    """A loaded model that names its weights in the one word it transcribes."""

    def __init__(self, weights: str) -> None:
        self.weights = weights
        self.calls = 0

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
        self.calls += 1
        return [_Segment(0.0, 0.5, "from-" + Path(self.weights).name)], _Info()


async def test_a_transcript_from_the_default_weights_is_not_served_once_english_is_set(
    wav_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cache knows which weights ran, not just the table's name for them."""
    monkeypatch.setattr(local_whisper_module, "_prepare_cleaned_audio", lambda uri: (uri, False))
    cache = MemoryResultCache()
    models: dict[str, _Weights] = {}

    def factory(weights: str) -> _Weights:
        models[weights] = _Weights(weights)
        return models[weights]

    before = LocalWhisperProvider(model_name="fine-tune", model_factory=factory)
    first = await process_transcribe(
        context(
            services_with({"local-whisper": before}, cache=cache),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="en",
        )
    )
    assert first.result["chunks"][0]["words"][0]["t"] == "from-fine-tune"

    after = LocalWhisperProvider(
        model_name="fine-tune", english_model_name="general", model_factory=factory
    )
    second = await process_transcribe(
        context(
            services_with({"local-whisper": after}, cache=cache),
            mediaId=MEDIA_ID,
            audioUri=str(wav_file),
            language="en",
        )
    )

    assert second.result["cached"] is False
    assert second.result["chunks"][0]["words"][0]["t"] == "from-general"
    assert models["general"].calls >= 1


# ---------------------------------------------------------------------------
# A cache hit on a fallback adopts the fallback's provider too
# ---------------------------------------------------------------------------


async def test_after_a_cached_fallback_the_next_chunk_calls_the_fallback(
    long_wav: Path,  # noqa: F811 - the imported fixture
) -> None:
    """Before: the run kept the broken primary's adapter under the fallback's name.

    Chunk 0 is served from the fallback's cache entry; chunk 1 is not cached,
    and used to be sent to the broken primary — which failed the whole job.
    """
    broken = FakeProvider("elevenlabs", error=ProviderError("down", provider="elevenlabs"))
    sarvam = FakeProvider("sarvam", words=HINGLISH, language="hi")
    cache = MemoryResultCache()
    services = services_with({"elevenlabs": broken, "sarvam": sarvam}, cache=cache)
    first_chunk = [{"chunkIdx": 0, "startMs": 0, "endMs": 60_000}]
    both_chunks = [*first_chunk, {"chunkIdx": 1, "startMs": 60_000, "endMs": 120_000}]

    await process_transcribe(
        context(
            services,
            mediaId=MEDIA_ID,
            audioUri=str(long_wav),
            language="hi",
            contentHash="same-audio",
            chunkPlan=first_chunk,
        )
    )
    sarvam_calls = len(sarvam.calls)

    try:
        outcome = await process_transcribe(
            context(
                services,
                mediaId=MEDIA_ID,
                audioUri=str(long_wav),
                language="hi",
                contentHash="same-audio",
                chunkPlan=both_chunks,
            )
        )
    except JobFailureError as error:  # pragma: no cover - the regression itself
        pytest.fail("the second chunk went to the broken primary: " + error.message)

    assert outcome.result["provider"] == "sarvam"
    assert len(outcome.result["chunks"]) == 2
    assert len(sarvam.calls) == sarvam_calls + 1  # chunk 0 from the cache, chunk 1 live
