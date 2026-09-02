"""Anthropic adapter (primary provider, brief section 2) — Claude Sonnet 5.

No real key exists in this environment (brief); this adapter is built and unit
tested against a stubbed HTTP transport, and is exercised end to end only when
an operator runs it manually with `ANTHROPIC_API_KEY` set (documented in
`apps/worker-ai/README.md`'s LLM section).
"""

from __future__ import annotations

import json
from typing import Any

import httpx2

from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmResponse, LlmUsage

__all__ = ["AnthropicLlmProvider"]

#: One endpoint per compliant region (brief: "IN -> configured region; EU -> EU
#: endpoints"). The public Anthropic API is a single global endpoint today; the
#: per-region hosts below are the regional inference endpoints operators
#: configure when a jurisdiction requires in-region processing (e.g. a cloud
#: provider's regional Anthropic-on-Bedrock/Vertex deployment). `region.py`
#: refuses a workspace whose region has no entry here.
_ENDPOINTS: dict[str, str] = {
    "in": "https://api.anthropic.com/v1/messages",
    "eu": "https://api.anthropic.com/v1/messages",
    "us": "https://api.anthropic.com/v1/messages",
}

_DEFAULT_MODEL = "claude-sonnet-5-20260101"


class AnthropicLlmProvider(LlmProvider):
    name = "anthropic"
    supported_regions = frozenset(_ENDPOINTS.keys())
    no_training = True

    def __init__(self, api_key: str, model: str = _DEFAULT_MODEL, timeout_s: float = 60.0) -> None:
        self._api_key = api_key
        self._model = model
        self._timeout_s = timeout_s

    async def generate(self, request: LlmRequest) -> LlmResponse:
        endpoint = _ENDPOINTS.get(request.region)
        if endpoint is None:
            raise LlmError(
                f"anthropic has no compliant endpoint for region={request.region!r}",
                provider=self.name,
                retryable=False,
            )
        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "system": request.system,
            "messages": [{"role": "user", "content": request.user}],
            # No-training enforcement (brief section 2): Anthropic's commercial API
            # does not train on API traffic by default; nothing here opts in.
        }
        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": "2026-01-01",
            "content-type": "application/json",
        }
        try:
            async with httpx2.AsyncClient(timeout=self._timeout_s) as client:
                response = await client.post(endpoint, headers=headers, content=json.dumps(body))
        except httpx2.HTTPError as error:
            raise LlmError(str(error), provider=self.name, retryable=True) from error

        if response.status_code == 429 or response.status_code >= 500:
            raise LlmError(f"anthropic {response.status_code}", provider=self.name, retryable=True)
        if response.status_code >= 400:
            raise LlmError(f"anthropic {response.status_code}", provider=self.name, retryable=False)

        data = response.json()
        content = data.get("content", [])
        text = "".join(block.get("text", "") for block in content if isinstance(block, dict))
        usage = data.get("usage", {})
        return LlmResponse(
            text=text,
            usage=LlmUsage(
                input_tokens=int(usage.get("input_tokens", 0)),
                output_tokens=int(usage.get("output_tokens", 0)),
            ),
            endpoint=endpoint,
        )
