"""`LLM_PROVIDER=ollama` as the translation chain's last link (free-stack mode)."""

from __future__ import annotations

import json

import httpx2
import pytest

from worker_ai.translate.providers.base import TranslationRequest, TranslationSegment
from worker_ai.translate.providers.llm import LLMTranslateProvider


class TestOllamaTranslate:
    """`LLM_PROVIDER=ollama`: the free stack's keyless translator.

    The worker refused to start at all before this branch existed — `runtime.py`
    builds the translation chain eagerly, so an unknown provider name took the
    whole AI worker down rather than degrading one feature.
    """

    def test_builds_without_any_api_key(self) -> None:
        provider = LLMTranslateProvider(provider="ollama")
        assert provider._http is not None

    def test_does_not_double_up_the_v1_prefix(self) -> None:
        # The configured LLM_BASE_URL ends in /v1 (the OpenAI client shape), while
        # VendorHttp paths add /v1 themselves.
        provider = LLMTranslateProvider(
            provider="ollama", base_url="http://127.0.0.1:11434/v1", model="qwen2.5:3b"
        )
        assert provider._submission().endpoint == "http://127.0.0.1:11434/v1/chat/completions"

    @pytest.mark.anyio
    async def test_translates_through_the_openai_compatible_shape(self) -> None:
        seen: dict[str, object] = {}

        async def handler(request: httpx2.Request) -> httpx2.Response:
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.content)
            return httpx2.Response(
                200, json={"choices": [{"message": {"content": "नमस्ते दुनिया"}}]}
            )

        provider = LLMTranslateProvider(
            provider="ollama",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen2.5:3b",
            client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        )
        result = await provider.translate(
            TranslationRequest(
                segments=(TranslationSegment(segment_id="s1", text="hello world"),),
                source_language="en",
                target_language="hi",
            )
        )
        assert result.segments[0].text == "नमस्ते दुनिया"
        assert seen["url"] == "http://127.0.0.1:11434/v1/chat/completions"
        assert isinstance(seen["body"], dict)
        assert seen["body"]["model"] == "qwen2.5:3b"
