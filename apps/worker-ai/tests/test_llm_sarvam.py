"""`SarvamLlmProvider` (2026-09-29) and how `LLM_PROVIDER=sarvam` is wired.

Built against an injected `httpx2.MockTransport`: no network, no key, no money.
The live shape was verified by the integrator on 2026-09-29.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest

from worker_ai.llm.budget import BudgetedLlmProvider, RedisSpendLedger
from worker_ai.llm.providers.base import LlmError, LlmRequest
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.llm.providers.ollama import OllamaLlmProvider
from worker_ai.llm.providers.sarvam import SarvamLlmProvider
from worker_ai.llm.registry import build_llm_providers
from worker_ai.runtime import build_translation_providers
from worker_ai.settings import EnvValidationError, load_settings
from worker_ai.translate.providers.llm import LLMTranslateProvider

from .conftest import VALID_ENV

KEY = "sk-sarvam-test-key-0000"


def _provider(handler: Any, **kwargs: Any) -> SarvamLlmProvider:
    return SarvamLlmProvider(
        KEY, client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), **kwargs
    )


def _request() -> LlmRequest:
    return LlmRequest(system="sys", user="user", max_tokens=256, temperature=0.2, region="in")


def _reply(content: str | None, *, prompt: int = 1_000, completion: int = 500) -> dict[str, Any]:
    return {
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": prompt, "completion_tokens": completion},
    }


async def test_posts_the_openai_shaped_body_with_the_subscription_key() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx2.Request) -> httpx2.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("api-subscription-key")
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx2.Response(200, json=_reply('{"ok": true}'))

    response = await _provider(handler).generate(_request())

    assert seen["url"] == "https://api.sarvam.ai/v1/chat/completions"
    assert seen["key"] == KEY
    assert seen["auth"] is None
    assert seen["body"]["model"] == "sarvam-105b-conversations"
    assert seen["body"]["response_format"] == {"type": "json_object"}
    assert seen["body"]["max_tokens"] == 256
    assert seen["body"]["temperature"] == 0.2
    assert seen["body"]["messages"] == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "user"},
    ]
    assert response.text == '{"ok": true}'
    assert response.usage.input_tokens == 1_000
    assert response.usage.output_tokens == 500


async def test_prices_the_call_from_its_tokens() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=_reply("{}", prompt=1_000_000, completion=1_000_000))

    response = await _provider(handler).generate(_request())

    # Rs 29.28 in + Rs 73.2 out = Rs 102.48 = 10,248 paise.
    assert response.usage.cost_minor == 10_248
    assert response.usage.currency == "INR"


async def test_reads_the_json_object_out_of_a_fenced_reply() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        content = 'Here you go:\n```json\n{"title": "Salary se ameer kyun nahi?"}\n```\nThanks'
        return httpx2.Response(200, json=_reply(content))

    response = await _provider(handler).generate(_request())
    assert json.loads(response.text) == {"title": "Salary se ameer kyun nahi?"}


async def test_json_mode_refused_is_retried_once_without_it_and_then_left_out() -> None:
    bodies: list[dict[str, Any]] = []

    async def handler(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if "response_format" in body:
            return httpx2.Response(400, json={"error": {"message": "unknown field"}})
        return httpx2.Response(200, json=_reply('{"ok": 1}'))

    provider = _provider(handler)
    first = await provider.generate(_request())
    second = await provider.generate(_request())

    assert json.loads(first.text) == {"ok": 1}
    assert json.loads(second.text) == {"ok": 1}
    assert ["response_format" in body for body in bodies] == [True, False, False]


async def test_a_reasoning_models_null_content_is_a_failure_for_the_next_provider() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=_reply(None))

    with pytest.raises(LlmError) as excinfo:
        await _provider(handler, model="sarvam-105b").generate(_request())
    assert excinfo.value.retryable is False
    assert "no content" in str(excinfo.value)


@pytest.mark.parametrize(("status", "retryable"), [(429, True), (500, True), (503, True)])
async def test_load_and_outages_are_retryable(status: int, retryable: bool) -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status, json={"error": {"message": "busy"}})

    with pytest.raises(LlmError) as excinfo:
        await _provider(handler).generate(_request())
    assert excinfo.value.retryable is retryable
    assert excinfo.value.provider == "sarvam"


async def test_a_refused_key_is_final_and_never_echoes_the_key() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(401, json={"error": {"message": "invalid api key"}})

    with pytest.raises(LlmError) as excinfo:
        await _provider(handler).generate(_request())
    assert excinfo.value.retryable is False
    assert KEY not in str(excinfo.value)


async def test_an_unreachable_api_is_retryable_and_never_echoes_the_key() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("boom", request=request)

    with pytest.raises(LlmError) as excinfo:
        await _provider(handler).generate(_request())
    assert excinfo.value.retryable is True
    assert KEY not in str(excinfo.value)


def test_serves_indian_workspaces_only() -> None:
    provider = SarvamLlmProvider(KEY)
    assert provider.supports_region("in")
    assert not provider.supports_region("eu")
    assert not provider.supports_region("us")
    # No signed terms promise zero retention: recorded under the vendor default.
    assert provider.no_training is False


def test_refuses_to_be_built_without_a_key() -> None:
    with pytest.raises(ValueError, match="SARVAM_API_KEY"):
        SarvamLlmProvider("")


# ---------------------------------------------------------------------------
# Settings and the chain
# ---------------------------------------------------------------------------


def test_settings_accept_sarvam_and_default_its_model() -> None:
    settings = load_settings({**VALID_ENV, "LLM_PROVIDER": "sarvam"})
    assert settings.llm_provider == "sarvam"
    assert settings.llm_model == "sarvam-105b-conversations"
    assert settings.llm_fallback_provider == "ollama"
    assert settings.llm_fallback_model == "qwen2.5:3b"
    assert settings.llm_daily_budget_inr == 300.0


def test_settings_read_the_fallback_and_the_budget() -> None:
    settings = load_settings(
        {
            **VALID_ENV,
            "LLM_PROVIDER": "sarvam",
            "LLM_MODEL": "sarvam-m",
            "LLM_FALLBACK_PROVIDER": "none",
            "LLM_FALLBACK_MODEL": "llama3.2:1b",
            "LLM_DAILY_BUDGET_INR": "12.5",
        }
    )
    assert settings.llm_model == "sarvam-m"
    assert settings.llm_fallback_provider == "none"
    assert settings.llm_fallback_model == "llama3.2:1b"
    assert settings.llm_daily_budget_inr == 12.5


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("LLM_FALLBACK_PROVIDER", "gemini"),
        ("LLM_DAILY_BUDGET_INR", "-1"),
        ("LLM_DAILY_BUDGET_INR", "lots"),
        ("LLM_DAILY_BUDGET_INR", "inf"),
    ],
)
def test_settings_refuse_a_bad_fallback_or_budget(name: str, value: str) -> None:
    with pytest.raises(EnvValidationError, match=name):
        load_settings({**VALID_ENV, "LLM_PROVIDER": "sarvam", name: value})


def test_the_chain_is_budgeted_sarvam_then_the_local_fallback() -> None:
    settings = load_settings({**VALID_ENV, "LLM_PROVIDER": "sarvam", "SARVAM_API_KEY": KEY})
    first, second = build_llm_providers(settings)

    assert isinstance(first, BudgetedLlmProvider)
    assert isinstance(first.inner, SarvamLlmProvider)
    assert first.name == "sarvam"
    assert first.model == "sarvam-105b-conversations"
    assert first.daily_budget_inr == 300.0
    assert isinstance(first._ledger, RedisSpendLedger)
    assert isinstance(second, OllamaLlmProvider)
    assert second.model == "qwen2.5:3b"
    assert second._endpoint == "http://127.0.0.1:11434/v1/chat/completions"


def test_without_a_key_the_chain_is_the_fallback_alone() -> None:
    settings = load_settings({**VALID_ENV, "LLM_PROVIDER": "sarvam"})
    (only,) = build_llm_providers(settings)
    assert isinstance(only, OllamaLlmProvider)


def test_without_a_key_or_a_fallback_the_chain_is_the_mock() -> None:
    settings = load_settings(
        {**VALID_ENV, "LLM_PROVIDER": "sarvam", "LLM_FALLBACK_PROVIDER": "none"}
    )
    (only,) = build_llm_providers(settings)
    assert isinstance(only, MockLlmProvider)


def test_a_sarvam_deployment_still_boots_its_translation_chain() -> None:
    """`LLMTranslateProvider` refuses unknown providers at boot: `sarvam` must not reach it."""
    settings = load_settings({**VALID_ENV, "LLM_PROVIDER": "sarvam", "SARVAM_API_KEY": KEY})
    chain = build_translation_providers(settings)
    last = chain[-1]
    assert isinstance(last, LLMTranslateProvider)
    assert last._provider == "ollama"
    assert last._model == "qwen2.5:3b"


def test_a_sarvam_deployment_with_no_fallback_translates_last_with_the_mock() -> None:
    settings = load_settings(
        {**VALID_ENV, "LLM_PROVIDER": "sarvam", "LLM_FALLBACK_PROVIDER": "none"}
    )
    last = build_translation_providers(settings)[-1]
    assert isinstance(last, LLMTranslateProvider)
    assert last._provider == "mock"
