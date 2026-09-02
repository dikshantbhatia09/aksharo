"""IndicTrans2 (AI4Bharat, MIT) — self-hosted fallback translation (`09 §4`).

Optional and off by default: `IndicTrans2Provider` is only constructed when
`WORKER_AI_INDICTRANS2_URL` is set (`runtime.py`), because it names a self-host
deployment this repository does not ship — there is no public hosted endpoint to
default to, unlike Sarvam. When the URL is unset the provider chain simply skips
this link, which is exactly what an optional, flagged provider means.

## Wire contract (fixture-driven; the self-host server is whatever wraps the
released IndicTrans2 checkpoints — FastAPI is the reference implementation
AI4Bharat publishes, hence the shape below)

```
POST {base_url}/translate
{ "sentences": ["यह वीडियो बहुत अच्छा है"], "source_lang": "hin_Deva",
  "target_lang": "eng_Latn" }
200 { "translations": ["This video is very good"] }
```

Batched, unlike Mayura: IndicTrans2 is a self-hosted model server, so one call
per job (not per segment) is both cheaper and the shape its own batching
support expects.
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

__all__ = ["FLORES_200_CODES", "IndicTrans2Provider"]

#: BCP-47 base -> FLORES-200 code, the tag IndicTrans2 was trained on. Only the
#: languages this work package's golden tests exercise are listed; extending the
#: map is data, not code.
FLORES_200_CODES: dict[str, str] = {
    "en": "eng_Latn",
    "hi": "hin_Deva",
    "ta": "tam_Taml",
    "bn": "ben_Beng",
    "gu": "guj_Gujr",
    "kn": "kan_Knda",
    "ml": "mal_Mlym",
    "mr": "mar_Deva",
    "pa": "pan_Guru",
    "te": "tel_Telu",
    "ur": "urd_Arab",
}


class IndicTrans2Provider(TranslationProvider):
    """A self-hosted IndicTrans2 server, batched one call per job."""

    name = "indictrans2"

    def __init__(self, *, base_url: str, client: httpx2.AsyncClient | None = None) -> None:
        if not base_url:
            raise ValueError("IndicTrans2Provider needs a base_url (WORKER_AI_INDICTRANS2_URL)")
        self._http = VendorHttp(provider=self.name, base_url=base_url, client=client)

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        sentences = [segment.text for segment in request.segments]
        body = await self._http.json(
            "POST",
            "/translate",
            json_body={
                "sentences": sentences,
                "source_lang": _flores(request.source_language),
                "target_lang": _flores(request.target_language),
            },
        )
        translations = body.get("translations")
        if not isinstance(translations, list) or len(translations) != len(request.segments):
            raise ProviderError(
                "indictrans2 returned a different number of sentences than were sent",
                provider=self.name,
                retryable=False,
            )
        translated = tuple(
            TranslatedSegment(segment_id=segment.segment_id, text=str(text))
            for segment, text in zip(request.segments, translations, strict=True)
        )
        submission = ProviderSubmission(
            provider=self.name,
            endpoint=self._http.url("/translate"),
            artefact="transcript-segments",
            retention_class="zero_retention",
        )
        return TranslationResult(segments=translated, submissions=(submission,))

    async def aclose(self) -> None:
        await self._http.aclose()


def _flores(language: str) -> str:
    base = language.split("-")[0].lower()
    return FLORES_200_CODES.get(base, base)
