"""Sarvam chat adapter (2026-09-29): the paid primary for Indian languages.

Selected by ``LLM_PROVIDER=sarvam`` and keyed by the same ``SARVAM_API_KEY`` the
Saaras transcription adapter uses. Sarvam's chat endpoint is OpenAI-shaped::

    POST {SARVAM_BASE_URL}/v1/chat/completions
    api-subscription-key: <SARVAM_API_KEY>
    {"model", "messages", "temperature", "max_tokens", "response_format"?}
    -> {"choices": [{"message": {"content": "..."}}],
        "usage": {"prompt_tokens", "completion_tokens"}}

The default model is ``sarvam-105b-conversations``: verified live on
2026-09-29, it answers natural Hinglish JSON in under a second. Not
``sarvam-105b``, which is a reasoning model: it spends the whole ``max_tokens``
budget thinking and returns ``content: null``, so every call would be paid for
and then fall through to the fallback.

JSON mode was not verified on the conversations model. Each call asks for it;
if the API refuses the field (a 400 or 422), the call is made once more without
it, and the object is read out of the text instead (fences and preamble
stripped, `json_reply.py`). Once a call without it has worked, later calls
leave it out.

Sarvam processes in India, so the adapter serves Indian workspaces only
(`region.py`): an EU or US workspace's words go to the local fallback instead.
Every call's cost is priced from its tokens (`pricing.py`) and reported in
``usage.cost_minor`` (paise); the daily budget wraps this adapter
(`budget.py`), not the other way round.
"""

from __future__ import annotations

import json
from typing import Any, Final

import httpx2

from worker_ai.llm.json_reply import first_json_object_text
from worker_ai.llm.pricing import call_cost_inr, inr_to_paise
from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmResponse, LlmUsage

__all__ = ["SARVAM_CHAT_DEFAULT_MODEL", "SARVAM_LLM_DEFAULT_BASE_URL", "SarvamLlmProvider"]

SARVAM_LLM_DEFAULT_BASE_URL: Final[str] = "https://api.sarvam.ai"
SARVAM_CHAT_DEFAULT_MODEL: Final[str] = "sarvam-105b-conversations"
_CHAT_PATH: Final[str] = "/v1/chat/completions"

#: The statuses with which an API refuses a request field it does not know.
_FIELD_REFUSED: Final = frozenset({400, 422})


class SarvamLlmProvider(LlmProvider):
    name = "sarvam"
    #: Sarvam serves from India; a workspace pinned elsewhere never reaches it.
    supported_regions = frozenset({"in"})
    #: Not contractually zero-retention (no signed terms say so), so its
    #: submissions are recorded under the vendor's default retention.
    no_training = False
    #: A 32K-token context, less the reply: about 45,000 characters of Hinglish.
    max_prompt_chars = 45_000

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = SARVAM_LLM_DEFAULT_BASE_URL,
        model: str = SARVAM_CHAT_DEFAULT_MODEL,
        timeout_s: float = 90.0,
        client: httpx2.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("SarvamLlmProvider needs SARVAM_API_KEY")
        self._api_key = api_key
        self._base_url = (base_url or SARVAM_LLM_DEFAULT_BASE_URL).rstrip("/")
        self.model = model or SARVAM_CHAT_DEFAULT_MODEL
        self._timeout_s = timeout_s
        # Injectable for tests (an `httpx2.MockTransport`), the same convention
        # as the Ollama adapter: an injected client is the caller's to close.
        self._client = client
        self._owns_client = client is None
        self._json_mode = True

    @property
    def endpoint(self) -> str:
        return f"{self._base_url}{_CHAT_PATH}"

    async def generate(self, request: LlmRequest) -> LlmResponse:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.user},
            ],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
        }
        json_mode = self._json_mode
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        response = await self._post(body)
        if json_mode and response.status_code in _FIELD_REFUSED:
            # Possibly the JSON-mode field, which this model was never verified
            # to accept: once more without it, and the object is read from text.
            del body["response_format"]
            response = await self._post(body)
            if response.status_code < 400:
                self._json_mode = False

        status = response.status_code
        if status == 429 or status >= 500:
            raise LlmError(f"sarvam {status}", provider=self.name, retryable=True)
        if status >= 400:
            raise LlmError(
                f"sarvam {status}: {_error_detail(response)}", provider=self.name, retryable=False
            )

        try:
            data = response.json()
        except ValueError as error:
            raise LlmError(
                "sarvam answered with a body that is not JSON", provider=self.name
            ) from error
        content = _content_of(data)
        if content is None:
            # A reasoning model spends its budget thinking and answers null.
            raise LlmError(
                f"sarvam returned no content (model {self.model})",
                provider=self.name,
                retryable=False,
            )
        usage_raw = data.get("usage") if isinstance(data, dict) else None
        usage = _usage_of(usage_raw if isinstance(usage_raw, dict) else {})
        return LlmResponse(
            text=first_json_object_text(content) or content,
            usage=usage,
            endpoint=self.endpoint,
        )

    async def _post(self, body: dict[str, Any]) -> httpx2.Response:
        headers = {
            "api-subscription-key": self._api_key,
            "content-type": "application/json",
        }
        client = self._client or httpx2.AsyncClient(timeout=self._timeout_s)
        try:
            try:
                return await client.post(self.endpoint, headers=headers, content=json.dumps(body))
            finally:
                if self._owns_client:
                    await client.aclose()
        except httpx2.HTTPError as error:
            # Never the request: its headers carry the key.
            raise LlmError(
                f"sarvam unreachable: {type(error).__name__}", provider=self.name, retryable=True
            ) from error


def _content_of(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    message = choices[0].get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return content if isinstance(content, str) and content.strip() else None


def _usage_of(raw: dict[str, Any]) -> LlmUsage:
    def tokens(key: str) -> int:
        value = raw.get(key)
        return int(value) if isinstance(value, int | float) and value > 0 else 0

    input_tokens = tokens("prompt_tokens")
    output_tokens = tokens("completion_tokens")
    measured = LlmUsage(input_tokens=input_tokens, output_tokens=output_tokens)
    return LlmUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_minor=inr_to_paise(call_cost_inr("sarvam", measured)),
        currency="INR",
    )


def _error_detail(response: httpx2.Response) -> str:
    """The API's own message for a refusal, short, for the log line."""
    try:
        data = response.json()
    except ValueError:
        return "no detail"
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("code")
            if isinstance(message, str):
                return message[:200]
        if isinstance(error, str):
            return error[:200]
        message = data.get("message") or data.get("detail")
        if isinstance(message, str):
            return message[:200]
    return "no detail"
