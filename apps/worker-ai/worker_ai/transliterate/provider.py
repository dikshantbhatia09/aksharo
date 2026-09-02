"""Transliteration providers behind one interface (`09 §4`, A22).

**Decision: worker-local, not a model-server route.** `apps/model-server` exists
to keep a GPU-resident model warm across requests (Whisper, alignment,
diarisation — `05 §10`). IndicXlit is the opposite shape: AI4Bharat ships it as a
small CPU-friendly transliteration model, cheap enough to run in-process per
word, and this environment has no vendor key and no downloaded model weight
(A00-06) to serve from either place. So the default provider
(:class:`RuleTableTransliterationProvider`) runs worker-local with **no**
network call and **no** GPU dependency — a rule table stands in for the neural
model until A00-06 lands real weights. :class:`IndicXlitHttpProvider` is the
seam for that day: point `WORKER_AI_INDICXLIT_URL` at a served model (on
`apps/model-server` or anywhere else) and the registry in ``../translate`` — er,
in :mod:`worker_ai.runtime` — prefers it over the rule table automatically. No
`apps/model-server` route is added by this work package because there is
nothing to serve yet; adding one is a follow-up once A00-06 has weights.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal

import httpx2

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import ProviderError, ProviderSubmission
from worker_ai.providers.http import VendorHttp
from worker_ai.transliterate.english import is_english_token
from worker_ai.transliterate.tables import (
    native_punctuation,
    normalise_numerals,
    romanise_word,
    transliterate_word,
)

__all__ = [
    "IndicXlitHttpProvider",
    "RuleTableTransliterationProvider",
    "TargetScript",
    "TransliterationProvider",
    "TransliterationRequest",
    "TransliterationResult",
]

_log = get_logger(__name__)

#: `Word.scripts` carries `roman`/`native`/`en` (CONTRACTS section 2); `en` is a
#: translation slot, not a transliteration target, so only the first two apply.
TargetScript = Literal["roman", "native"]

#: Languages the rule tables in ``tables.py`` cover today. Extending to the rest
#: of the 21 AI4Bharat languages is new dictionary/syllable tables in that
#: module — the provider and the processor need no change.
SUPPORTED_LANGUAGES: frozenset[str] = frozenset({"hi", "ta"})


@dataclass(frozen=True, slots=True)
class TransliterationRequest:
    """One word to transliterate, in document order."""

    #: Stable word id (`"<chunkIdx>:<n>"`), carried through untouched.
    wid: str
    #: The word's current text, in whatever script it was transcribed in.
    text: str
    #: BCP-47 base language, e.g. `"hi"` from `"hi-Latn"`.
    language: str
    target: TargetScript


@dataclass(frozen=True, slots=True)
class TransliterationResult:
    wid: str
    text: str
    #: True when this word was left untouched because it is English (Hinglish
    #: preservation rule) — informational, for the corrections-style log.
    preserved: bool = False
    submissions: tuple[ProviderSubmission, ...] = field(default_factory=tuple)


class TransliterationProvider(ABC):
    """What every transliteration adapter implements."""

    name: str = "abstract"

    @abstractmethod
    async def transliterate(
        self, requests: tuple[TransliterationRequest, ...]
    ) -> tuple[TransliterationResult, ...]:
        """Transliterate a batch of words. Order in, order out — same length."""
        raise NotImplementedError

    async def aclose(self) -> None:
        return None


class RuleTableTransliterationProvider(TransliterationProvider):
    """Default provider: dictionary + syllable tables, no network call.

    Applies, in order, for every word: (1) the Hinglish English-preservation
    rule — an English token is never transliterated, in either direction; (2)
    numeral normalisation; (3) punctuation normalisation; (4) the word/syllable
    table for the target script. A language this provider has no table for
    (anything outside :data:`SUPPORTED_LANGUAGES`) is returned unchanged, word
    for word, rather than raising — an unsupported language should not fail a
    job that also carries words in a supported one (mixed-language segments do
    happen), and the caller sees exactly which words changed and which did not.
    """

    name = "indicxlit-ruletable"

    async def transliterate(
        self, requests: tuple[TransliterationRequest, ...]
    ) -> tuple[TransliterationResult, ...]:
        return tuple(self._one(request) for request in requests)

    def _one(self, request: TransliterationRequest) -> TransliterationResult:
        token = request.text
        stripped = token.strip()

        if stripped == "":
            return TransliterationResult(wid=request.wid, text=token)

        if is_english_token(stripped):
            return TransliterationResult(wid=request.wid, text=token, preserved=True)

        language = request.language.split("-")[0].lower()
        to_native = request.target == "native"

        numeralised = normalise_numerals(stripped, language=language, to_native=to_native)
        if numeralised != stripped:
            return TransliterationResult(wid=request.wid, text=numeralised)

        punctuated = native_punctuation(stripped, language=language) if to_native else stripped
        if punctuated != stripped:
            return TransliterationResult(wid=request.wid, text=punctuated)

        if language not in SUPPORTED_LANGUAGES:
            return TransliterationResult(wid=request.wid, text=token)

        mapped = (
            transliterate_word(stripped, language=language)
            if to_native
            else romanise_word(stripped, language=language)
        )
        return TransliterationResult(wid=request.wid, text=mapped)


class IndicXlitHttpProvider(TransliterationProvider):
    """A served IndicXlit model, when one exists.

    Wire contract (documented, fixture-driven — no live endpoint exists yet):

    ```
    POST {base_url}/transliterate
        { "language": "hi", "target": "native", "words": ["yeh", "video"] }
    200 { "words": ["यह", "video"] }
    ```

    A batch response shorter or longer than the request is a contract violation
    from the server, not a transient failure, so it is not retried.
    """

    name = "indicxlit"

    def __init__(self, *, base_url: str, client: httpx2.AsyncClient | None = None) -> None:
        self._http = VendorHttp(provider=self.name, base_url=base_url, client=client)

    async def transliterate(
        self, requests: tuple[TransliterationRequest, ...]
    ) -> tuple[TransliterationResult, ...]:
        if not requests:
            return ()
        # Group by (language, target): the served model takes one language and
        # one direction per call.
        groups: dict[tuple[str, str], list[TransliterationRequest]] = {}
        for request in requests:
            key = (request.language.split("-")[0].lower(), request.target)
            groups.setdefault(key, []).append(request)

        by_wid: dict[str, TransliterationResult] = {}
        for (language, target), group in groups.items():
            words = [request.text for request in group]
            body = await self._http.json(
                "POST",
                "/transliterate",
                json_body={"language": language, "target": target, "words": words},
            )
            translated = body.get("words")
            if not isinstance(translated, list) or len(translated) != len(group):
                raise ProviderError(
                    "indicxlit returned a different number of words than were sent",
                    provider=self.name,
                    retryable=False,
                )
            submission = ProviderSubmission(
                provider=self.name,
                endpoint=self._http.url("/transliterate"),
                artefact="transliteration",
                retention_class="zero_retention",
            )
            for request, text in zip(group, translated, strict=True):
                by_wid[request.wid] = TransliterationResult(
                    wid=request.wid,
                    text=str(text),
                    submissions=(submission,),
                )
        return tuple(by_wid[request.wid] for request in requests)

    async def aclose(self) -> None:
        await self._http.aclose()
