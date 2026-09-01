"""Settings validation, including a property test over arbitrary environments."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from worker_ai.settings import (
    CONTRACT_ENV_VARS,
    REQUIRED_ENV_VARS,
    EnvValidationError,
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
