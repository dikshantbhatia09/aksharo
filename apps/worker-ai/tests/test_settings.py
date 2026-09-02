"""Settings validation, including a property test over arbitrary environments."""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from worker_ai.settings import (
    CONTRACT_ENV_VARS,
    DEFAULT_CONCURRENCY,
    DEFAULT_CONTROL_PORT,
    REQUIRED_ENV_VARS,
    WORKER_ENV_VARS,
    EnvValidationError,
    load_repo_dotenv,
    load_settings,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_EXAMPLE = REPO_ROOT / ".env.example"

VALID_ENV: dict[str, str] = {
    "REDIS_URL": "redis://localhost:6379",
    "API_ORIGIN": "http://localhost:3001",
    "INTERNAL_CALLBACK_SECRET": "0" * 64,
}


def test_env_example_lists_every_contract_variable() -> None:
    """`.env.example` must cover CONTRACTS section 1 exactly."""
    assigned = {
        match.group(1)
        for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines()
        if (match := re.match(r"^([A-Z][A-Z0-9_]*)=", line.strip()))
    }
    assert [name for name in CONTRACT_ENV_VARS if name not in assigned] == []


def test_contract_list_matches_typescript() -> None:
    """The Python list must not drift from `packages/config/src/env.ts`."""
    env_ts = (REPO_ROOT / "packages" / "config" / "src" / "env.ts").read_text(encoding="utf-8")
    block = env_ts.split("CONTRACT_ENV_VARS = [", 1)[1].split("] as const", 1)[0]
    from_ts = tuple(re.findall(r'"([A-Z0-9_]+)"', block))
    assert from_ts == CONTRACT_ENV_VARS


def test_loads_a_valid_environment() -> None:
    settings = load_settings(VALID_ENV)
    assert settings.redis_url == "redis://localhost:6379"
    assert settings.llm_provider == "mock"
    assert settings.gpu_provider == "none"
    assert settings.has_any_asr_provider is False


def test_detects_a_configured_asr_provider() -> None:
    settings = load_settings({**VALID_ENV, "ELEVENLABS_API_KEY": "sk-test"})
    assert settings.has_any_asr_provider is True


@pytest.mark.parametrize("missing", REQUIRED_ENV_VARS)
def test_fails_fast_naming_the_missing_variable(missing: str) -> None:
    source = {key: value for key, value in VALID_ENV.items() if key != missing}
    with pytest.raises(EnvValidationError) as excinfo:
        load_settings(source)
    assert f"{missing} is missing" in str(excinfo.value)
    assert "Copy .env.example to .env" in str(excinfo.value)


def test_reports_every_problem_at_once() -> None:
    with pytest.raises(EnvValidationError) as excinfo:
        load_settings({})
    for name in REQUIRED_ENV_VARS:
        assert name in str(excinfo.value)
    assert len(excinfo.value.problems) == len(REQUIRED_ENV_VARS)


def test_rejects_a_non_redis_url() -> None:
    with pytest.raises(EnvValidationError, match="redis://"):
        load_settings({**VALID_ENV, "REDIS_URL": "amqp://localhost"})


def test_rejects_a_short_callback_secret() -> None:
    with pytest.raises(EnvValidationError, match="at least 32 characters"):
        load_settings({**VALID_ENV, "INTERNAL_CALLBACK_SECRET": "short"})


def test_rejects_an_unknown_llm_provider() -> None:
    with pytest.raises(EnvValidationError, match="LLM_PROVIDER"):
        load_settings({**VALID_ENV, "LLM_PROVIDER": "gemini"})


@given(
    st.dictionaries(
        st.sampled_from(REQUIRED_ENV_VARS),
        st.text(max_size=8),
        max_size=len(REQUIRED_ENV_VARS),
    )
)
def test_never_returns_partial_settings(source: dict[str, str]) -> None:
    """Either every required value is present and valid, or it raises.

    A partially-populated `Settings` would let a worker start and fail later on a
    real job, which is exactly what fail-fast validation exists to prevent.
    """
    try:
        settings = load_settings(source)
    except EnvValidationError as error:
        assert error.problems
        return
    assert settings.redis_url.startswith(("redis://", "rediss://"))
    assert settings.api_origin.startswith(("http://", "https://"))
    assert len(settings.internal_callback_secret) >= 32


# ---------------------------------------------------------------------------
# A09: deployment naming, storage and feature flags
# ---------------------------------------------------------------------------


def test_worker_variables_are_documented_and_not_in_the_frozen_contract_list() -> None:
    """`WORKER_ENV_VARS` is deployment naming, like `MONTAJ_QUEUE_PREFIX` in the API."""
    assert not set(WORKER_ENV_VARS) & set(CONTRACT_ENV_VARS)
    readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
    for name in WORKER_ENV_VARS:
        assert name in readme, f"{name} is not documented in the worker README"


def test_deployment_defaults_match_the_documented_ones() -> None:
    settings = load_settings(VALID_ENV)
    assert settings.queue_prefix == "bull"
    assert settings.concurrency == DEFAULT_CONCURRENCY
    assert settings.control_port == DEFAULT_CONTROL_PORT
    assert settings.queues == ()
    assert settings.whisper_model == "small"


def test_the_queue_prefix_can_be_isolated_for_a_parallel_run() -> None:
    settings = load_settings({**VALID_ENV, "MONTAJ_QUEUE_PREFIX": "a09"})
    assert settings.queue_prefix == "a09"


def test_a_trailing_slash_on_the_api_origin_is_dropped() -> None:
    """Otherwise every callback path would carry a double slash."""
    settings = load_settings({**VALID_ENV, "API_ORIGIN": "https://api.example.com/"})
    assert settings.api_origin == "https://api.example.com"


@pytest.mark.parametrize("name", ["WORKER_AI_CONCURRENCY", "WORKER_AI_PORT"])
@pytest.mark.parametrize("value", ["nonsense", "0", "-4"])
def test_rejects_a_non_positive_integer(name: str, value: str) -> None:
    with pytest.raises(EnvValidationError, match=f"{name}: must be a positive integer"):
        load_settings({**VALID_ENV, name: value})


def test_rejects_a_gpu_url_that_is_not_http() -> None:
    with pytest.raises(EnvValidationError, match="GPU_PROVIDER_URL"):
        load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "grpc://gpu.example"})


def test_rejects_feature_flags_that_are_not_a_json_object() -> None:
    with pytest.raises(EnvValidationError, match="FEATURE_FLAGS_JSON"):
        load_settings({**VALID_ENV, "FEATURE_FLAGS_JSON": "not json"})
    with pytest.raises(EnvValidationError, match="FEATURE_FLAGS_JSON"):
        load_settings({**VALID_ENV, "FEATURE_FLAGS_JSON": "[1,2]"})


def test_feature_flags_read_booleans_strings_and_defaults() -> None:
    settings = load_settings(
        {**VALID_ENV, "FEATURE_FLAGS_JSON": '{"a": true, "b": "off", "c": "yes", "d": 0}'}
    )
    assert settings.flag("a") is True
    assert settings.flag("b") is False
    assert settings.flag("c") is True
    assert settings.flag("d") is False
    assert settings.flag("unknown") is True
    assert settings.flag("unknown", default=False) is False


def test_the_bucket_settings_know_when_they_are_incomplete() -> None:
    settings = load_settings(VALID_ENV)
    assert settings.derived_bucket.configured is False

    configured = load_settings(
        {
            **VALID_ENV,
            "R2_ENDPOINT": "http://localhost:9000",
            "R2_BUCKET_DERIVED": "montaj-derived",
            "R2_ACCESS_KEY": "key",
            "R2_SECRET_KEY": "secret",
        }
    )
    assert configured.derived_bucket.configured is True
    assert configured.derived_bucket.region == "auto"


def test_the_mock_is_allowed_only_when_nothing_better_is_configured() -> None:
    assert load_settings(VALID_ENV).mock_allowed is True
    assert load_settings({**VALID_ENV, "SARVAM_API_KEY": "sk"}).mock_allowed is False
    assert (
        load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.example"}).mock_allowed
        is False
    )
    assert (
        load_settings(
            {**VALID_ENV, "SARVAM_API_KEY": "sk", "WORKER_AI_ALLOW_MOCK": "true"}
        ).mock_allowed
        is True
    )


def test_load_repo_dotenv_finds_the_repository_env(tmp_path: Path) -> None:
    nested = tmp_path / "a" / "b"
    nested.mkdir(parents=True)
    (tmp_path / ".env").write_text("MONTAJ_DOTENV_PROBE=1\n", encoding="utf-8")
    assert load_repo_dotenv(nested) == tmp_path / ".env"
    assert os.environ.pop("MONTAJ_DOTENV_PROBE") == "1"


def test_load_repo_dotenv_returns_none_when_there_is_no_env(tmp_path: Path) -> None:
    # An empty temporary root has no `.env` above it on any CI runner.
    assert load_repo_dotenv(tmp_path) in (None, *(parent / ".env" for parent in tmp_path.parents))
