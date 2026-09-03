"""Ollama adapter (M20 free-stack mode) — a local, OpenAI-compatible server.

Selected by `LLM_PROVIDER=ollama`. Unlike `anthropic.py`/`openai.py`, this
adapter is exercised end to end on this host: `docs/FREE-STACK.md` documents
`winget install Ollama.Ollama` + `ollama pull qwen2.5:3b`, and the model never
leaves the machine — every workspace region is "compliant" the same way the
mock provider's is (`supported_regions` = every known region), because there
is no cross-border transfer to gate.

Ollama serves an OpenAI-compatible `/v1/chat/completions` endpoint
(`LLM_BASE_URL`, default `http://127.0.0.1:11434/v1`) that accepts the same
`response_format: {"type": "json_object"}` JSON-mode flag OpenAI's does, so
the request body below is a copy of `openai.py`'s shape with the endpoint and
default model swapped. `service.py`'s one-repair-on-invalid-JSON path applies
here unchanged — this adapter only has to return the model's raw text.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2

from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmResponse, LlmUsage

__all__ = ["OllamaLlmProvider"]

_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
_DEFAULT_MODEL = "qwen2.5:3b"

#: A qwen2.5:3b reply in JSON mode is more verbose than the template budgets
#: (`TEMPLATE_CONFIG`) assume for a hosted model -- a request under this
#: floor was truncating mid-string on several eval fixtures (M20 increment
#: 2b). Applied to every call this provider makes; a hosted provider is
#: unaffected, it never reads this constant.
_MIN_MAX_TOKENS = 3_000

#: Ollama runs entirely on this host: no network egress, so every workspace
#: jurisdiction is compliant with it (same rationale as the mock provider).
_ALL_REGIONS = frozenset({"in", "eu", "us"})


class OllamaLlmProvider(LlmProvider):
    name = "ollama"
    supported_regions = _ALL_REGIONS
    no_training = True

    def __init__(
        self,
        base_url: str = _DEFAULT_BASE_URL,
        model: str = _DEFAULT_MODEL,
        timeout_s: float = 120.0,
        client: httpx2.AsyncClient | None = None,
    ) -> None:
        # A local model on CPU is much slower than a hosted one; the longer
        # default timeout is deliberate (brief: "record latencies").
        self._base_url = base_url.rstrip("/") or _DEFAULT_BASE_URL
        self._model = model or _DEFAULT_MODEL
        self._timeout_s = timeout_s
        # `client` is injectable so a test drives an `httpx2.MockTransport`
        # instead of a network (same convention as `VendorHttp` and every
        # translate/transliterate provider in this package). When this
        # provider owns the client (the real-run path), it opens and closes
        # one per call; an injected client is the caller's to close.
        self._client = client
        self._owns_client = client is None

    @property
    def _endpoint(self) -> str:
        return f"{self._base_url}/chat/completions"

    async def generate(self, request: LlmRequest) -> LlmResponse:
        effective_max_tokens = max(request.max_tokens, _MIN_MAX_TOKENS)
        endpoint = self._endpoint
        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": effective_max_tokens,
            "options": {"num_predict": effective_max_tokens},
            "temperature": request.temperature,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
            # JSON mode: every template here asks for strict JSON only; Ollama's
            # OpenAI-compat endpoint honours the same flag OpenAI's does.
            "response_format": {"type": "json_object"},
            "stream": False,
        }
        headers = {"content-type": "application/json"}
        client = self._client or httpx2.AsyncClient(timeout=self._timeout_s)
        try:
            try:
                response = await client.post(endpoint, headers=headers, content=json.dumps(body))
            finally:
                if self._owns_client:
                    await client.aclose()
        except httpx2.HTTPError as error:
            raise LlmError(str(error), provider=self.name, retryable=True) from error

        if response.status_code == 429 or response.status_code >= 500:
            raise LlmError(f"ollama {response.status_code}", provider=self.name, retryable=True)
        if response.status_code >= 400:
            raise LlmError(f"ollama {response.status_code}", provider=self.name, retryable=False)

        data = response.json()
        choices = data.get("choices", [])
        text = choices[0]["message"]["content"] if choices else ""
        usage = data.get("usage", {})
        return LlmResponse(
            text=text,
            usage=LlmUsage(
                input_tokens=int(usage.get("prompt_tokens", 0)),
                output_tokens=int(usage.get("completion_tokens", 0)),
                # A local model costs nothing per call; leave cost unset rather
                # than reporting a fabricated zero-with-currency.
                cost_minor=None,
            ),
            endpoint=endpoint,
        )
