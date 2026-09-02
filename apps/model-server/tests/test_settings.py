"""Configuration: defaults, validation, and what a log line is allowed to see."""

from __future__ import annotations

import pytest

from model_server.settings import ConfigurationError, Settings

BASE = {"GPU_PROVIDER_TOKEN": "secret-token"}


def env(**overrides: str) -> dict[str, str]:
    return {**BASE, **overrides}


def test_defaults_are_the_gpu_shape() -> None:
    settings = Settings.from_env(env())
    assert settings.device == "cuda"
    assert settings.effective_compute_type == "float16"
    assert settings.whisper_model == "large-v3-turbo"
    assert settings.diariser_model == "pyannote/speaker-diarization-community-1"
    assert settings.batch_window_ms == 50
    assert settings.max_audio_seconds == 600.0
    assert settings.memory_budget_bytes == 18 * 1024 * 1024 * 1024


def test_cpu_mode_drops_to_int8_and_a_smaller_budget() -> None:
    settings = Settings.from_env(env(MODEL_SERVER_DEVICE="cpu"))
    assert settings.on_gpu is False
    assert settings.effective_compute_type == "int8"
    assert settings.memory_budget_bytes == 4 * 1024 * 1024 * 1024


def test_x05s_compute_type_variable_is_honoured() -> None:
    """``infra/gpu/runpod/endpoint.json`` already sets COMPUTE_TYPE in the template."""
    assert Settings.from_env(env(COMPUTE_TYPE="int8_float16")).effective_compute_type == (
        "int8_float16"
    )
    # The app's own variable wins when both are set.
    settings = Settings.from_env(env(COMPUTE_TYPE="int8", MODEL_SERVER_COMPUTE_TYPE="float32"))
    assert settings.effective_compute_type == "float32"


def test_an_unknown_device_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="cuda"):
        Settings.from_env(env(MODEL_SERVER_DEVICE="tpu"))


def test_an_unknown_preload_name_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="asr, align and diarise"):
        Settings.from_env(env(MODEL_SERVER_PRELOAD="asr,translate"))


def test_preload_is_parsed_and_normalised() -> None:
    settings = Settings.from_env(env(MODEL_SERVER_PRELOAD=" ASR , diarise "))
    assert settings.preload == ("asr", "diarise")


def test_a_non_numeric_limit_is_refused_by_name() -> None:
    with pytest.raises(ConfigurationError, match="MODEL_SERVER_PORT"):
        Settings.from_env(env(MODEL_SERVER_PORT="eight thousand"))
    with pytest.raises(ConfigurationError, match="MODEL_SERVER_MAX_AUDIO_SECONDS"):
        Settings.from_env(env(MODEL_SERVER_MAX_AUDIO_SECONDS="ten minutes"))


def test_a_limit_below_its_minimum_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="at least 1"):
        Settings.from_env(env(MODEL_SERVER_BATCH_MAX_SIZE="0"))


def test_megabyte_settings_are_converted_to_bytes() -> None:
    settings = Settings.from_env(
        env(MODEL_SERVER_MAX_BODY_MB="8", MODEL_SERVER_MEMORY_BUDGET_MB="2048")
    )
    assert settings.max_body_bytes == 8 * 1024 * 1024
    assert settings.memory_budget_bytes == 2048 * 1024 * 1024


def test_hf_home_is_the_fallback_model_cache() -> None:
    assert Settings.from_env(env(HF_HOME="/models/hf")).model_cache_dir == "/models/hf"


def test_the_redacted_view_never_carries_the_token() -> None:
    settings = Settings.from_env(env(GPU_PROVIDER_TOKEN="super-secret"))
    redacted = settings.redacted()
    assert redacted["authenticated"] is True
    assert "super-secret" not in repr(redacted)
    assert not any("token" in key.casefold() for key in redacted)
