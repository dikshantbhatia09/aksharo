"""Transliterate a transcript's words into one target script (`09 §4`, A22).

Thin orchestration over :mod:`worker_ai.transliterate.provider`: batch the
words, call the provider, and shape the result for the completion payload the
processor sends to `POST /internal/transcripts/{id}/scripts`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from worker_ai.providers.base import ProviderSubmission
from worker_ai.transliterate.provider import (
    TargetScript,
    TransliterationProvider,
    TransliterationRequest,
)

__all__ = ["TransliterateWordsResult", "TransliteratedWord", "transliterate_words"]


@dataclass(frozen=True, slots=True)
class TransliteratedWord:
    wid: str
    text: str
    preserved: bool = False


@dataclass(frozen=True, slots=True)
class TransliterateWordsResult:
    words: tuple[TransliteratedWord, ...]
    submissions: tuple[ProviderSubmission, ...] = field(default_factory=tuple)
    #: Words left exactly as they were (English preservation, or no rule table
    #: for this language) — for the job event / log line, not for a decision.
    unchanged: int = 0


async def transliterate_words(
    provider: TransliterationProvider,
    *,
    words: tuple[tuple[str, str], ...],
    language: str,
    target: TargetScript,
) -> TransliterateWordsResult:
    """Transliterate `words` (`(wid, text)` pairs, document order) into `target`.

    Empty input returns an empty result rather than calling the provider — a
    transcript with no words in a chunk is not a provider failure.
    """
    if not words:
        return TransliterateWordsResult(words=())

    requests = tuple(
        TransliterationRequest(wid=wid, text=text, language=language, target=target)
        for wid, text in words
    )
    results = await provider.transliterate(requests)

    submissions: list[ProviderSubmission] = []
    unchanged = 0
    out: list[TransliteratedWord] = []
    for result in results:
        out.append(
            TransliteratedWord(wid=result.wid, text=result.text, preserved=result.preserved)
        )
        submissions.extend(result.submissions)
        if result.preserved:
            unchanged += 1

    return TransliterateWordsResult(
        words=tuple(out), submissions=tuple(submissions), unchanged=unchanged
    )
