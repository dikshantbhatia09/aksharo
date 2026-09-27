"""``local-whisper`` runs two sets of weights, and the routing table picks between them.

2026-09-27: every English and ``en-IN`` video was transcribed by the Hinglish
fine-tune, which put "1 more" and "built built built" into real titles, and the
fine-tune reports every language as English (every local-whisper probe since
2026-09-12 said ``en`` at 1.0), so "auto" could never have been probed on it.
``WORKER_AI_WHISPER_MODEL_EN`` adds a general model for the English and global
lanes; the Hindi and Hinglish lanes keep the fine-tune.
"""

from __future__ import annotations

import logging
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from worker_ai.providers import local_whisper as local_whisper_module
from worker_ai.providers import registry as registry_module
from worker_ai.providers.base import ProviderError, TranscriptionRequest
from worker_ai.providers.local_whisper import (
    DEFAULT_FAMILY,
    DEFAULT_ROUTING_MODELS,
    ENGLISH_FAMILY,
    ENGLISH_ROUTING_MODELS,
    LocalWhisperProvider,
    weights_problem,
)
from worker_ai.providers.registry import build_registry
from worker_ai.routing import (
    MODEL_SELECTING_PROVIDERS,
    RoutingCandidate,
    load_routing_table,
    resolve_chain,
)
from worker_ai.settings import load_settings

from .conftest import VALID_ENV

FINE_TUNE = "C:/models/whisper-hindi2hinglish-apex-ct2-int8"
GENERAL = "C:/models/faster-whisper-large-v3-turbo"


class _Info:
    language = "en"
    language_probability = 0.98
    duration = 2.0


class _Model:
    """A loaded model that remembers its weights and every call made on it."""

    def __init__(self, weights: str) -> None:
        self.weights = weights
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
        self.calls.append(kwargs)
        return [], _Info()


class _Loader:
    """A model factory that records which weights were asked for, and how often."""

    def __init__(self) -> None:
        self.loaded: list[str] = []
        self.models: dict[str, _Model] = {}

    def __call__(self, weights: str) -> _Model:
        self.loaded.append(weights)
        model = _Model(weights)
        self.models[weights] = model
        return model


def _provider(loader: _Loader, *, english: str = GENERAL) -> LocalWhisperProvider:
    return LocalWhisperProvider(
        model_name=FINE_TUNE, english_model_name=english, model_factory=loader
    )


# ---------------------------------------------------------------------------
# Which weights a request runs on
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("language", "family"),
    [
        ("en", ENGLISH_FAMILY),
        ("en-IN", ENGLISH_FAMILY),
        ("EN_us", ENGLISH_FAMILY),
        ("hi", DEFAULT_FAMILY),
        ("hi-Latn", DEFAULT_FAMILY),
        ("hi-en", DEFAULT_FAMILY),
        ("ta", DEFAULT_FAMILY),
        (None, DEFAULT_FAMILY),
        ("auto", DEFAULT_FAMILY),
    ],
)
def test_without_a_routed_model_the_language_picks_the_weights(
    language: str | None, family: str
) -> None:
    """Outside the pipeline (the eval CLI, a direct call): en -> EN, else default."""
    provider = _provider(_Loader())
    assert provider.family_for(language=language) == family
    expected = GENERAL if family == ENGLISH_FAMILY else FINE_TUNE
    assert provider.weights_for(language=language) == expected


@pytest.mark.parametrize("language", [None, "hi", "en"])
def test_a_routed_model_wins_over_the_language(language: str | None) -> None:
    """The LID probe goes out with no language; the lane has to decide for it."""
    provider = _provider(_Loader())
    assert provider.weights_for(language=language, routed_model="large-v3-turbo") == GENERAL
    assert (
        provider.weights_for(language=language, routed_model="whisper-hindi2hinglish-apex")
        == FINE_TUNE
    )


def test_an_unset_english_model_means_the_default_serves_every_lane() -> None:
    """Today's behaviour when WORKER_AI_WHISPER_MODEL_EN is empty."""
    provider = _provider(_Loader(), english="")
    assert provider.weights_for(language="en") == FINE_TUNE
    assert provider.weights_for(routed_model="large-v3-turbo") == FINE_TUNE


# ---------------------------------------------------------------------------
# Loading: lazily, once per set of weights, and kept
# ---------------------------------------------------------------------------


async def test_each_model_loads_on_first_use_and_stays_resident() -> None:
    loader = _Loader()
    provider = _provider(loader)

    await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="hi"))
    assert loader.loaded == [FINE_TUNE]  # English was never asked for, so never loaded

    for language in ("en", "hi", "en-IN", "hi-Latn", "en"):
        await provider.transcribe(TranscriptionRequest(audio_uri="b.wav", language=language))

    # One load per set of weights, however many jobs follow.
    assert loader.loaded == [FINE_TUNE, GENERAL]
    assert len(loader.models[GENERAL].calls) == 3
    assert len(loader.models[FINE_TUNE].calls) == 3


async def test_the_same_weights_for_both_families_load_once() -> None:
    loader = _Loader()
    provider = LocalWhisperProvider(
        model_name=FINE_TUNE, english_model_name=FINE_TUNE, model_factory=loader
    )
    await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))
    await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="hi"))
    assert loader.loaded == [FINE_TUNE]


async def test_the_routed_model_selects_the_weights_and_never_reaches_the_decoder() -> None:
    """A probe (no language) on an English lane runs the English weights.

    ``model`` rides in ``options`` from the routing table; handing it to
    ``transcribe(**options)`` would be a TypeError on every chunk.
    """
    loader = _Loader()
    provider = _provider(loader)
    options = RoutingCandidate(provider="local-whisper", model="large-v3-turbo").provider_options()

    result = await provider.transcribe(
        TranscriptionRequest(audio_uri="a.wav", language=None, options=options)
    )

    # The default weights load first (see the load-order test below).
    assert loader.loaded == [FINE_TUNE, GENERAL]
    assert loader.models[FINE_TUNE].calls == []
    call = loader.models[GENERAL].calls[0]
    assert "model" not in call
    assert "language" not in call  # still a detection: this is the LID probe
    assert result.usage is not None
    assert result.usage.model == GENERAL
    assert result.raw["family"] == ENGLISH_FAMILY
    assert result.raw["requestedFamily"] == ENGLISH_FAMILY


async def test_the_default_weights_load_first_even_for_an_english_job() -> None:
    """If the card cannot hold both, English — which can fall back — is left out.

    Before: whichever family asked first loaded first, so an English job after a
    restart could leave the Hinglish fine-tune, which has no fallback, no room.
    """
    loader = _Loader()
    provider = _provider(loader)
    await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))
    assert loader.loaded == [FINE_TUNE, GENERAL]
    await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="hi"))
    assert loader.loaded == [FINE_TUNE, GENERAL]  # and nothing reloads


async def test_an_unset_english_model_is_reported_as_the_default_family() -> None:
    """What ran is what the result says — the pipeline trusts detection on it."""
    loader = _Loader()
    provider = _provider(loader, english="")
    options = RoutingCandidate(provider="local-whisper", model="large-v3-turbo").provider_options()
    result = await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", options=options))
    assert loader.loaded == [FINE_TUNE]
    assert result.raw["family"] == DEFAULT_FAMILY
    assert result.raw["requestedFamily"] == ENGLISH_FAMILY
    assert result.raw["model"] == FINE_TUNE


# ---------------------------------------------------------------------------
# A load that fails
# ---------------------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


class _FlakyLoader(_Loader):
    """Fails to load the weights named in ``broken`` until they are removed from it."""

    def __init__(self, *broken: str) -> None:
        super().__init__()
        self.broken = set(broken)
        self.attempts: list[str] = []

    def __call__(self, weights: str) -> _Model:
        self.attempts.append(weights)
        if weights in self.broken:
            raise RuntimeError("CUDA failed with error out of memory")
        return super().__call__(weights)


async def test_english_weights_that_will_not_load_fall_back_to_the_default() -> None:
    """Before: every English, en-IN and auto job failed and was retried instead."""
    loader = _FlakyLoader(GENERAL)
    provider = _provider(loader)

    result = await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))

    assert result.raw["family"] == DEFAULT_FAMILY
    assert result.raw["requestedFamily"] == ENGLISH_FAMILY
    assert result.usage is not None and result.usage.model == FINE_TUNE
    assert len(loader.models[FINE_TUNE].calls) == 1
    # The cache's idea of the weights follows, so nothing is stored as English.
    assert provider.weights_for(language="en") == FINE_TUNE


async def test_a_failed_english_load_is_not_retried_until_its_interval_passes() -> None:
    """Not 1.6 GB re-read for every chunk of every English job."""
    clock = _Clock()
    loader = _FlakyLoader(GENERAL)
    provider = LocalWhisperProvider(
        model_name=FINE_TUNE, english_model_name=GENERAL, model_factory=loader, clock=clock
    )

    for _ in range(3):
        await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))
    assert loader.attempts.count(GENERAL) == 1

    loader.broken.clear()
    clock.now += local_whisper_module.ENGLISH_RETRY_AFTER_S
    result = await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))

    assert loader.attempts.count(GENERAL) == 2
    assert result.raw["family"] == ENGLISH_FAMILY
    assert provider.weights_for(language="en") == GENERAL


async def test_a_failed_default_load_is_shared_briefly_then_retried() -> None:
    """Parallel chunks share one failure; BullMQ's retry (15 s later) tries again."""
    clock = _Clock()
    loader = _FlakyLoader(FINE_TUNE)
    provider = LocalWhisperProvider(model_name=FINE_TUNE, model_factory=loader, clock=clock)

    for _ in range(2):
        with pytest.raises(ProviderError) as raised:
            await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="hi"))
        assert raised.value.retryable is True
    assert loader.attempts == [FINE_TUNE]

    assert local_whisper_module.DEFAULT_RETRY_AFTER_S < 15.0
    clock.now += local_whisper_module.DEFAULT_RETRY_AFTER_S
    loader.broken.clear()
    await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="hi"))
    assert loader.attempts == [FINE_TUNE, FINE_TUNE]


async def test_a_default_that_will_not_load_does_not_stop_english() -> None:
    loader = _FlakyLoader(FINE_TUNE)
    provider = _provider(loader)
    result = await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))
    assert result.raw["family"] == ENGLISH_FAMILY
    assert loader.attempts == [FINE_TUNE, GENERAL]


async def test_a_load_error_names_the_weights_directory_not_the_whole_path() -> None:
    loader = _FlakyLoader(FINE_TUNE)
    provider = LocalWhisperProvider(model_name=FINE_TUNE, model_factory=loader)
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="a.wav"))
    assert "whisper-hindi2hinglish-apex-ct2-int8" in str(raised.value)
    assert "C:/models" not in str(raised.value)


async def test_a_model_that_does_not_fit_on_the_gpu_is_never_moved_to_the_cpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Before: under ``auto`` any GPU load error silently reloaded it on the CPU.

    There it stayed for the life of the process, decoding at beam 5 on the laptop
    that serves the whole stack. Now English falls back to the default weights
    (already on the GPU), and nothing is ever built on the CPU.
    """
    built: list[tuple[str, str, str]] = []

    class _FakeFasterWhisper:
        def __init__(self, weights: str, *, device: str, compute_type: str) -> None:
            built.append((weights, device, compute_type))
            if weights == GENERAL:
                raise RuntimeError("CUDA failed with error out of memory")

        def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
            return [], _Info()

    monkeypatch.setitem(
        sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=_FakeFasterWhisper)
    )
    monkeypatch.setattr(local_whisper_module, "_resolve_device", lambda requested: "cuda")

    provider = LocalWhisperProvider(model_name=FINE_TUNE, english_model_name=GENERAL)
    result = await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))

    assert built == [(FINE_TUNE, "cuda", "int8_float16"), (GENERAL, "cuda", "int8_float16")]
    assert result.raw["device"] == "cuda"
    assert result.raw["model"] == FINE_TUNE


async def test_a_default_that_does_not_fit_on_the_gpu_fails_rather_than_run_on_the_cpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[str] = []

    class _NoRoom:
        def __init__(self, weights: str, *, device: str, compute_type: str) -> None:
            built.append(device)
            raise RuntimeError("CUDA failed with error out of memory")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=_NoRoom))
    monkeypatch.setattr(local_whisper_module, "_resolve_device", lambda requested: "cuda")

    provider = LocalWhisperProvider(model_name=FINE_TUNE, device="auto")
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="hi"))
    assert raised.value.retryable is True
    assert built == ["cuda"]


async def test_an_explicit_cuda_device_is_not_silently_moved_to_the_cpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _NoRoom:
        def __init__(self, weights: str, *, device: str, compute_type: str) -> None:
            raise RuntimeError("CUDA failed with error out of memory")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=_NoRoom))
    monkeypatch.setattr(local_whisper_module, "_resolve_device", lambda requested: "cuda")

    provider = LocalWhisperProvider(model_name=FINE_TUNE, device="cuda")
    with pytest.raises(ProviderError, match="could not load the Whisper model"):
        await provider.transcribe(TranscriptionRequest(audio_uri="a.wav"))


# ---------------------------------------------------------------------------
# A refused request is not retried
# ---------------------------------------------------------------------------


async def test_an_invalid_language_code_is_a_non_retryable_provider_error() -> None:
    """2026-09-27: "'en-IN' is not a valid language code" was retried, then dead-lettered."""

    class _Refusing:
        def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
            raise ValueError("'xx' is not a valid language code (accepted language codes: en)")

    provider = LocalWhisperProvider(model_factory=_Refusing)
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language="en"))
    assert raised.value.retryable is False
    assert "not a valid language code" in str(raised.value)


async def test_an_unexpected_decode_argument_is_not_retried_either() -> None:
    class _Strict:
        def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
            raise TypeError("transcribe() got an unexpected keyword argument 'bogus'")

    provider = LocalWhisperProvider(model_factory=_Strict)
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", options={"bogus": True}))
    assert raised.value.retryable is False


# ---------------------------------------------------------------------------
# The routing table and the registry
# ---------------------------------------------------------------------------


def test_every_local_whisper_model_in_the_table_is_one_the_adapter_knows() -> None:
    """A typo would silently put its lane back on the default weights."""
    known = ENGLISH_ROUTING_MODELS | DEFAULT_ROUTING_MODELS
    table = load_routing_table()
    for lane in table.lanes:
        for candidate in lane.candidates:
            if candidate.provider == "local-whisper":
                assert candidate.model in known, (lane.id, candidate.model)


def test_only_a_model_selecting_provider_is_handed_the_model() -> None:
    """serverless-whisper copies every option into its request body."""
    assert {"local-whisper"} == MODEL_SELECTING_PROVIDERS
    local = RoutingCandidate(provider="local-whisper", model="large-v3-turbo")
    assert local.provider_options() == {"model": "large-v3-turbo"}
    assert (
        "model"
        not in RoutingCandidate(
            provider="serverless-whisper", model="large-v3-turbo"
        ).provider_options()
    )
    assert RoutingCandidate(
        provider="sarvam", model="saaras-v4", mode="codemix", api="batch"
    ).provider_options() == {"mode": "codemix", "api": "batch"}


def _local_only_registry(monkeypatch: pytest.MonkeyPatch, **env: str) -> Any:
    """A registry where local-whisper is the only real provider, installed or not."""
    monkeypatch.setattr(registry_module, "_faster_whisper_missing", lambda: None)
    return build_registry(load_settings({**VALID_ENV, "WORKER_AI_ALLOW_MOCK": "0", **env}))


@pytest.mark.parametrize(
    ("language", "code_mix", "model"),
    [
        ("en", False, "large-v3-turbo"),
        ("en-IN", False, "large-v3-turbo"),
        # "auto": no language, so the default lane — which is where the probe runs.
        (None, False, "large-v3-turbo"),
        ("fr", False, "large-v3-turbo"),
        ("hi", False, "whisper-hindi2hinglish-apex"),
        ("hi-Latn", False, "whisper-hindi2hinglish-apex"),
        ("hi-en", True, "whisper-hindi2hinglish-apex"),
    ],
)
def test_english_and_global_lanes_route_to_the_general_model(
    monkeypatch: pytest.MonkeyPatch, language: str | None, code_mix: bool, model: str
) -> None:
    registry = _local_only_registry(monkeypatch)
    chain = resolve_chain(load_routing_table(), registry, language=language, code_mix=code_mix)
    local = [d for d in chain if d.candidate.provider == "local-whisper"]
    assert len(local) == 1
    assert local[0].candidate.provider_options()["model"] == model


def _ct2_directory(path: Path) -> Path:
    """A directory shaped like a CTranslate2 model: it has a ``model.bin``."""
    path.mkdir(parents=True, exist_ok=True)
    (path / "model.bin").write_bytes(b"")
    return path


async def test_the_registry_hands_the_english_weights_to_the_adapter(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    weights = str(_ct2_directory(tmp_path / "turbo"))
    registry = _local_only_registry(monkeypatch, WORKER_AI_WHISPER_MODEL_EN=weights)
    provider = await registry.get("local-whisper")
    assert isinstance(provider, LocalWhisperProvider)
    assert provider.english_model_name == weights
    assert provider.weights_for(routed_model="large-v3-turbo") == weights
    # The instance is cached, so its loaded models survive from job to job.
    assert await registry.get("local-whisper") is provider


# ---------------------------------------------------------------------------
# WORKER_AI_WHISPER_MODEL_EN
# ---------------------------------------------------------------------------


def test_the_english_model_is_unset_by_default() -> None:
    assert load_settings(VALID_ENV).whisper_model_en == ""


@pytest.mark.parametrize(
    "value",
    ["C:/models/not-there", "./not-there", "large-v3-turbo", "models/turbo", "/c/models/x"],
)
def test_no_english_model_value_can_stop_the_worker_booting(value: str) -> None:
    """Before: a missing path raised at boot, and worker-ai exited.

    ``start-production-stack.ps1`` never reads a worker's exit code, so every
    ``ai.*`` queue — the Sarvam lane, ``ai.faces``, alignment — would have
    stalled with every health check green, for a setting whose empty value is
    a supported fallback. The registry checks it instead (below).
    """
    assert load_settings({**VALID_ENV, "WORKER_AI_WHISPER_MODEL_EN": value}).whisper_model_en == (
        value
    )


@pytest.mark.parametrize(
    "name",
    [
        "large-v3-turbo",
        "Systran/faster-whisper-large-v3",
        "deepdml/faster-whisper-large-v3-turbo-ct2",
    ],
)
def test_a_model_name_is_not_a_path(name: str) -> None:
    """A Hugging Face repo id has one slash and is resolved at load, not checked here."""
    assert weights_problem(name) is None


def test_a_ct2_directory_is_usable(tmp_path: Path) -> None:
    assert weights_problem(str(_ct2_directory(tmp_path / "turbo"))) is None


def test_an_existing_relative_path_without_a_dot_is_a_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before: ``models/turbo`` was taken for a repo id, whatever was on disk."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "models").mkdir()
    assert weights_problem("models/turbo") is None  # not on disk: a repo id
    (tmp_path / "models" / "turbo").mkdir()
    assert weights_problem("models/turbo") == (
        "the directory has no model.bin, so it is not a CTranslate2 model"
    )
    _ct2_directory(tmp_path / "models" / "turbo")
    assert weights_problem("models/turbo") is None


@pytest.mark.parametrize(
    "value",
    ["C:/models/not-there", "C:\\models\\not-there", "./not-there", "/c/models/turbo", "~/nope"],
)
def test_a_path_shaped_value_that_is_not_on_disk_is_a_problem(value: str) -> None:
    """POSIX-style paths included: on Windows they are not absolute, and were missed."""
    assert weights_problem(value) == "nothing exists at that path"


def test_the_engine_decides_whether_a_file_or_a_directory_is_right(tmp_path: Path) -> None:
    """openai-whisper loads a ``.pt`` checkpoint file, which a directory check refused."""
    checkpoint = tmp_path / "large-v3-turbo.pt"
    checkpoint.write_bytes(b"")
    directory = _ct2_directory(tmp_path / "ct2")

    assert weights_problem(str(checkpoint), engine="openai-whisper") is None
    assert weights_problem(str(checkpoint), engine="faster-whisper") is not None
    assert weights_problem(str(directory), engine="faster-whisper") is None
    assert weights_problem(str(directory), engine="openai-whisper") is not None


async def test_an_unusable_english_model_is_logged_and_ignored_at_boot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """English runs on the default weights, the worker keeps every other queue."""
    missing = str(tmp_path / "not-there")
    with caplog.at_level(logging.ERROR, logger="worker_ai.providers.registry"):
        registry = _local_only_registry(monkeypatch, WORKER_AI_WHISPER_MODEL_EN=missing)

    provider = await registry.get("local-whisper")
    assert isinstance(provider, LocalWhisperProvider)
    assert provider.english_model_name == ""
    errors = [record for record in caplog.records if record.levelno == logging.ERROR]
    assert any("WORKER_AI_WHISPER_MODEL_EN is ignored" in record.getMessage() for record in errors)
    # The log names the variable, never the value (THREAT-MODEL T21).
    assert all(missing not in record.getMessage() for record in caplog.records)


def test_an_unset_english_model_is_a_boot_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="worker_ai.providers.registry"):
        _local_only_registry(monkeypatch)
    assert any(
        "WORKER_AI_WHISPER_MODEL_EN is unset" in record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
    )
