"""`OllamaLlmProvider` (M20 free-stack mode) and its registry wiring.

Built and unit tested against an injected `httpx2.MockTransport` (the same
convention as `VendorHttp`/`ServerlessWhisperProvider`/the translate
providers) — no network here. A real run against a live Ollama server is a
manual/CI-skipped step, documented in `docs/FREE-STACK.md`.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest

from worker_ai.llm.providers.base import LlmError, LlmRequest
from worker_ai.llm.providers.ollama import OllamaLlmProvider
from worker_ai.llm.registry import build_llm_providers
from worker_ai.llm.service import generate_insight
from worker_ai.llm.templates import TranscriptInput, TranscriptSegment
from worker_ai.settings import load_settings

from .conftest import VALID_ENV


def _provider(handler: Any, **kwargs: Any) -> OllamaLlmProvider:
    return OllamaLlmProvider(
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), **kwargs
    )


def _request() -> LlmRequest:
    return LlmRequest(system="sys", user="user", max_tokens=256, temperature=0.2, region="in")


# ---------------------------------------------------------------------------
# OllamaLlmProvider
# ---------------------------------------------------------------------------


async def test_ollama_posts_to_the_openai_compatible_chat_endpoint() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx2.Request) -> httpx2.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx2.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"ok": true}'}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3},
            },
        )

    provider = _provider(handler, base_url="http://127.0.0.1:11434/v1", model="qwen2.5:3b")
    response = await provider.generate(_request())

    assert seen["url"] == "http://127.0.0.1:11434/v1/chat/completions"
    assert seen["body"]["model"] == "qwen2.5:3b"
    assert seen["body"]["response_format"] == {"type": "json_object"}
    assert seen["body"]["messages"] == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "user"},
    ]
    assert response.text == '{"ok": true}'
    assert response.usage.input_tokens == 12
    assert response.usage.output_tokens == 3
    assert response.usage.cost_minor is None


async def test_ollama_strips_a_trailing_slash_from_the_base_url() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    provider = _provider(handler, base_url="http://127.0.0.1:11434/v1/")
    response = await provider.generate(_request())
    assert response.endpoint == "http://127.0.0.1:11434/v1/chat/completions"


async def test_ollama_maps_429_and_5xx_to_a_retryable_error() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(503, json={"error": "loading model"})

    provider = _provider(handler)
    with pytest.raises(LlmError) as excinfo:
        await provider.generate(_request())
    assert excinfo.value.retryable is True
    assert excinfo.value.provider == "ollama"


async def test_ollama_maps_400_to_a_non_retryable_error() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(400, json={"error": "bad request"})

    provider = _provider(handler)
    with pytest.raises(LlmError) as excinfo:
        await provider.generate(_request())
    assert excinfo.value.retryable is False


async def test_ollama_supports_every_known_region() -> None:
    provider = OllamaLlmProvider()
    assert provider.supports_region("in")
    assert provider.supports_region("eu")
    assert provider.supports_region("us")
    assert provider.no_training is True


# ---------------------------------------------------------------------------
# registry.py: LLM_PROVIDER=ollama needs no key
# ---------------------------------------------------------------------------


def test_registry_selects_ollama_with_no_key_configured() -> None:
    settings = load_settings({**VALID_ENV, "LLM_PROVIDER": "ollama"})
    providers = build_llm_providers(settings)
    assert len(providers) == 1
    assert providers[0].name == "ollama"


def test_registry_ollama_uses_configured_base_url_and_model() -> None:
    settings = load_settings(
        {
            **VALID_ENV,
            "LLM_PROVIDER": "ollama",
            "LLM_BASE_URL": "http://127.0.0.1:22222/v1",
            "LLM_MODEL": "llama3.2:1b",
        }
    )
    (provider,) = build_llm_providers(settings)
    assert isinstance(provider, OllamaLlmProvider)
    assert provider._endpoint == "http://127.0.0.1:22222/v1/chat/completions"
    assert provider._model == "llama3.2:1b"


def test_registry_ollama_defaults_match_the_documented_ones() -> None:
    settings = load_settings({**VALID_ENV, "LLM_PROVIDER": "ollama"})
    assert settings.llm_base_url == "http://127.0.0.1:11434/v1"
    assert settings.llm_model == "qwen2.5:3b"


# ---------------------------------------------------------------------------
# service.generate_insight end to end against the mocked Ollama transport
# ---------------------------------------------------------------------------


async def test_generate_insight_end_to_end_with_ollama() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {"chapters": [{"startMs": 0, "title": "Intro"}]}
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 40, "completion_tokens": 8},
            },
        )

    provider = _provider(handler)
    transcript = TranscriptInput(
        language="en",
        duration_ms=20_000,
        media_title="Sample",
        segments=(TranscriptSegment(0, 4_000, "Hello everyone welcome to the show"),),
    )
    result = await generate_insight("chapters", transcript, (provider,), "in")
    assert result.provider == "ollama"
    assert result.output["chapters"][0]["title"] == "Intro"
    assert result.usage["inputTokens"] == 40
    assert result.usage["outputTokens"] == 8


async def test_generate_insight_repairs_once_against_ollama_on_invalid_json() -> None:
    replies = iter(["not json", json.dumps({"chapters": [{"startMs": 0, "title": "Intro"}]})])

    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"choices": [{"message": {"content": next(replies)}}]})

    provider = _provider(handler)
    transcript = TranscriptInput(
        language="en",
        duration_ms=20_000,
        media_title="Sample",
        segments=(TranscriptSegment(0, 4_000, "Hello everyone welcome to the show"),),
    )
    result = await generate_insight("chapters", transcript, (provider,), "in")
    assert result.output["chapters"][0]["title"] == "Intro"
