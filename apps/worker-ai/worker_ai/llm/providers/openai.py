"""OpenAI adapter — the config-selected fallback (brief section 2).

Same caveat as `anthropic.py`: no real key in this environment; built and unit
tested against a stubbed transport.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2

from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmResponse, LlmUsage

__all__ = ["OpenAiLlmProvider"]

_ENDPOINTS: dict[str, str] = {
    "in": "https://api.openai.com/v1/chat/completions",
    "eu": "https://eu.api.openai.com/v1/chat/completions",
    "us": "https://api.openai.com/v1/chat/completions",
}

_DEFAULT_MODEL = "gpt-4.1"


class OpenAiLlmProvider(LlmProvider):
    name = "openai"
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
                f"openai has no compliant endpoint for region={request.region!r}",
                provider=self.name,
                retryable=False,
            )
        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
            # No-training enforcement (brief section 2): zero-data-retention /
            # no-train is an account-level setting on the OpenAI side; nothing
            # here opts the request into training.
        }
        headers = {"authorization": f"Bearer {self._api_key}", "content-type": "application/json"}
        try:
            async with httpx2.AsyncClient(timeout=self._timeout_s) as client:
                response = await client.post(endpoint, headers=headers, content=json.dumps(body))
        except httpx2.HTTPError as error:
            raise LlmError(str(error), provider=self.name, retryable=True) from error

        if response.status_code == 429 or response.status_code >= 500:
            raise LlmError(f"openai {response.status_code}", provider=self.name, retryable=True)
        if response.status_code >= 400:
            raise LlmError(f"openai {response.status_code}", provider=self.name, retryable=False)

        data = response.json()
        choices = data.get("choices", [])
        text = choices[0]["message"]["content"] if choices else ""
        usage = data.get("usage", {})
        return LlmResponse(
            text=text,
            usage=LlmUsage(
                input_tokens=int(usage.get("prompt_tokens", 0)),
                output_tokens=int(usage.get("completion_tokens", 0)),
            ),
            endpoint=endpoint,
        )
