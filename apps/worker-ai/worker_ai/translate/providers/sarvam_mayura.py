"""Sarvam **Mayura** translation — the primary translation lane (`09 §4`).

Distinct from `worker_ai/providers/sarvam.py`'s `SarvamSaarasProvider` (ASR):
Mayura is Sarvam's text-translation model, a separate endpoint on the same
account. No vendor key exists yet (A00-06); the wire contract below is what the
recorded fixtures in the tests replay and what the manual smoke path checks
first once a key arrives.

## Wire contract (fixture-driven)

```
POST {SARVAM_BASE_URL}/translate
api-subscription-key: {SARVAM_API_KEY}
{ "input": "यह वीडियो बहुत अच्छा है",
  "source_language_code": "auto",
  "target_language_code": "en-IN",
  "model": "mayura:v1",
  "mode": "formal" | "concise" }
200 { "translated_text": "This video is very good", "source_language_code": "hi-IN" }
```

One call per segment: Mayura is a text-in-text-out model with no documented
batch mode, and a caption segment is a sentence or less, so the per-call cost is
the same shape as the ASR Batch API's per-chunk cost, just synchronous.
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

__all__ = ["SARVAM_TRANSLATE_DEFAULT_BASE_URL", "SarvamMayuraProvider"]

SARVAM_TRANSLATE_DEFAULT_BASE_URL = "https://api.sarvam.ai"


class SarvamMayuraProvider(TranslationProvider):
    """Sarvam Mayura, one segment per HTTP call."""

    name = "sarvam-mayura"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = SARVAM_TRANSLATE_DEFAULT_BASE_URL,
        client: httpx2.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("SarvamMayuraProvider needs SARVAM_API_KEY")
        self._http = VendorHttp(
            provider=self.name,
            base_url=base_url,
            headers={"api-subscription-key": api_key},
            client=client,
        )

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        translated: list[TranslatedSegment] = []
        submissions: list[ProviderSubmission] = []
        for segment in request.segments:
            if segment.text.strip() == "":
                translated.append(TranslatedSegment(segment_id=segment.segment_id, text=""))
                continue
            body = await self._http.json(
                "POST",
                "/translate",
                json_body={
                    "input": segment.text,
                    "source_language_code": _sarvam_tag(request.source_language) or "auto",
                    "target_language_code": _sarvam_tag(request.target_language),
                    "model": "mayura:v1",
                    "mode": "concise" if segment.shorter else "formal",
                },
            )
            text = body.get("translated_text")
            if not isinstance(text, str):
                raise ProviderError(
                    "sarvam-mayura returned no translated_text",
                    provider=self.name,
                    retryable=False,
                )
            translated.append(TranslatedSegment(segment_id=segment.segment_id, text=text))
        submissions.append(
            ProviderSubmission(
                provider=self.name,
                endpoint=self._http.url("/translate"),
                artefact="transcript-segments",
                retention_class="vendor_default",
            )
        )
        return TranslationResult(segments=tuple(translated), submissions=tuple(submissions))

    async def aclose(self) -> None:
        await self._http.aclose()


def _sarvam_tag(language: str) -> str:
    """BCP-47 base -> Sarvam's `xx-IN`/`en-IN` region tags, best-effort.

    Sarvam documents region-qualified codes; a bare `"hi"` becomes `"hi-IN"` and
    an already-qualified tag is passed through unchanged.
    """
    if not language:
        return ""
    if "-" in language:
        return language
    return f"{language}-IN" if language != "en" else "en-IN"
