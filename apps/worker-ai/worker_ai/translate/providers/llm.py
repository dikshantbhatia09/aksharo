"""LLM translation — the last link in the provider chain (`09 §4`, `09 §7`).

Runs after Sarvam Mayura and IndicTrans2 have both been tried (or skipped): an
LLM is the most expensive and least specialised translator of the three, kept
last on purpose. One call per segment, through the region-pinned Anthropic or
OpenAI endpoint named by `LLM_PROVIDER` (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`,
CONTRACTS section 1) — never both, and never a default that silently picks one.

`LLM_PROVIDER=ollama` speaks the same OpenAI-compatible shape against a local
Ollama server (`LLM_BASE_URL`, `LLM_MODEL`), so the free stack has a real
translator with no key and no data leaving the host.

`LLM_PROVIDER=mock` (the worker's own default, `settings.py`) never calls a
network at all: it returns a deterministic, clearly-marked translation so the
provider chain, the length-aware retry and the glossary substitution are all
testable and runnable with no credentials, exactly like the mock ASR provider
covers `ai.transcribe` in dev and CI.
"""

from __future__ import annotations

import httpx2

from worker_ai.providers.base import ProviderError, ProviderSubmission
from worker_ai.providers.http import VendorHttp
from worker_ai.translate.providers.base import (
    TranslatedSegment,
    TranslationProvider,
    TranslationRequest,
    TranslationResult,
)
from worker_ai.translate.providers.prompts import (
    TRANSLATE_CAPTION_PROMPT_VERSION,
    build_translate_prompt,
)

__all__ = ["LLMTranslateProvider"]

_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
_ANTHROPIC_MODEL = "claude-haiku-4-5"
_OPENAI_BASE_URL = "https://api.openai.com"
_OPENAI_MODEL = "gpt-4o-mini"
_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
_OLLAMA_MODEL = "qwen2.5:3b"


class LLMTranslateProvider(TranslationProvider):
    """Anthropic Claude or OpenAI, one call per segment; `mock` needs neither."""

    name = "llm-translate"

    def __init__(
        self,
        *,
        provider: str,
        anthropic_api_key: str = "",
        openai_api_key: str = "",
        base_url: str = "",
        model: str = "",
        client: httpx2.AsyncClient | None = None,
    ) -> None:
        self._provider = provider
        self._client_owned = client is None
        self._model = model
        if provider == "anthropic":
            if not anthropic_api_key:
                raise ValueError("LLMTranslateProvider(anthropic) needs ANTHROPIC_API_KEY")
            self._http: VendorHttp | None = VendorHttp(
                provider=self.name,
                base_url=_ANTHROPIC_BASE_URL,
                headers={
                    "x-api-key": anthropic_api_key,
                    "anthropic-version": "2023-06-01",
                },
                client=client,
            )
        elif provider == "openai":
            if not openai_api_key:
                raise ValueError("LLMTranslateProvider(openai) needs OPENAI_API_KEY")
            self._http = VendorHttp(
                provider=self.name,
                base_url=_OPENAI_BASE_URL,
                headers={"authorization": f"Bearer {openai_api_key}"},
                client=client,
            )
        elif provider == "ollama":
            # Local, OpenAI-compatible, and keyless: nothing leaves the host. The
            # configured base URL already ends in `/v1` (that is what the OpenAI
            # client shape expects), while `VendorHttp` paths add `/v1` themselves,
            # so trim it here rather than calling `/v1/v1/chat/completions`.
            root = (base_url or _OLLAMA_BASE_URL).rstrip("/")
            if root.endswith("/v1"):
                root = root[: -len("/v1")]
            self._model = model or _OLLAMA_MODEL
            self._http = VendorHttp(
                provider=self.name,
                base_url=root or _OLLAMA_BASE_URL,
                headers={},
                client=client,
            )
        elif provider == "mock":
            self._http = None
        else:
            raise ValueError(f"LLMTranslateProvider: unknown provider {provider!r}")

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        translated: list[TranslatedSegment] = []
        for segment in request.segments:
            if segment.text.strip() == "":
                translated.append(TranslatedSegment(segment_id=segment.segment_id, text=""))
                continue
            text = await self._translate_one(
                text=segment.text,
                source_language=request.source_language,
                target_language=request.target_language,
                shorter=segment.shorter,
            )
            translated.append(TranslatedSegment(segment_id=segment.segment_id, text=text))

        submissions = () if self._http is None else (self._submission(),)
        return TranslationResult(segments=tuple(translated), submissions=submissions)

    async def _translate_one(
        self, *, text: str, source_language: str, target_language: str, shorter: bool
    ) -> str:
        if self._http is None:
            return _mock_translate(text, target_language, shorter=shorter)

        _system, user = build_translate_prompt(
            text=text,
            source_language=source_language,
            target_language=target_language,
            shorter=shorter,
        )
        if self._provider == "anthropic":
            return await self._anthropic(_system, user)
        return await self._openai(_system, user)

    async def _anthropic(self, system: str, user: str) -> str:
        http = self._require_http()
        body = await http.json(
            "POST",
            "/v1/messages",
            json_body={
                "model": _ANTHROPIC_MODEL,
                "max_tokens": 1024,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
        )
        content = body.get("content")
        if not isinstance(content, list) or not content:
            raise ProviderError(
                "anthropic returned no content", provider=self.name, retryable=False
            )
        first = content[0]
        text = first.get("text") if isinstance(first, dict) else None
        if not isinstance(text, str):
            raise ProviderError(
                "anthropic returned a content block with no text",
                provider=self.name,
                retryable=False,
            )
        return text.strip()

    async def _openai(self, system: str, user: str) -> str:
        http = self._require_http()
        body = await http.json(
            "POST",
            "/v1/chat/completions",
            json_body={
                "model": self._model or _OPENAI_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        )
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ProviderError("openai returned no choices", provider=self.name, retryable=False)
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        text = message.get("content") if isinstance(message, dict) else None
        if not isinstance(text, str):
            raise ProviderError(
                "openai returned a choice with no message content",
                provider=self.name,
                retryable=False,
            )
        return text.strip()

    def _submission(self) -> ProviderSubmission:
        http = self._require_http()
        path = "/v1/messages" if self._provider == "anthropic" else "/v1/chat/completions"
        return ProviderSubmission(
            provider=f"{self.name}-{self._provider}",
            endpoint=http.url(path),
            artefact="transcript-segments",
            retention_class="zero_retention",
        )

    def _require_http(self) -> VendorHttp:
        """Narrow ``self._http`` for the two real providers; `mock` never calls this."""
        if self._http is None:
            raise ProviderError(
                "LLMTranslateProvider(mock) has no HTTP client", provider=self.name, retryable=False
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()


def _mock_translate(text: str, target_language: str, *, shorter: bool) -> str:
    """A deterministic, clearly-fake translation for dev/CI (`LLM_PROVIDER=mock`).

    Prefixed with the target language and the prompt version so a test can
    assert the right provider ran without needing real translation quality; a
    `shorter` retry actually is shorter (drops the version tag), so the
    length-aware retry has something real to measure.
    """
    if shorter:
        return f"[{target_language}] {text[: max(1, len(text) // 2)]}"
    return f"[{target_language}/{TRANSLATE_CAPTION_PROMPT_VERSION}] {text}"
