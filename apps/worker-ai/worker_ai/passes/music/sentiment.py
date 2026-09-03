"""Per-sentence sentiment for the ``music`` pass's mood classifier (D05
follow-up, brief §2): a prompted call through B11's LLM client seam
(``music-mood@1``, ``worker_ai.llm``), with the old lexicon scorer kept as
the offline fallback — never both silently blended, always one clearly
reported ``source``.

Previously this scoring lived in `apps/api/src/passes/passes.service.ts`
(`sentimentCuesOf`, a lexicon-only stand-in whose own docstring flagged it as
a deviation from CONTRACTS' "all AI runs in apps/worker-ai"). It now lives
here instead: the producer ships raw `sentences` in the job payload, and this
module is the one that scores them, in-process, the same split
`worker_ai.translate.providers.llm` uses for its own last-resort LLM call.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from worker_ai.llm.providers.base import LlmProvider
from worker_ai.llm.region import RegionBlockedError
from worker_ai.llm.service import AllProvidersFailedError, InvalidOutputError, generate_insight
from worker_ai.llm.templates import TranscriptInput, TranscriptSegment

__all__ = ["SentimentSource", "lexicon_cues", "lexicon_score", "score_sentiment"]

SentimentSource = Literal["lexicon", "llm"]

#: Mirrors `apps/api/src/passes/passes.service.ts`'s old `POSITIVE_WORDS`
#: exactly (kept as the offline fallback rather than deleted with it) and
#: `packages/prompts/src/eval/music-mood-mock.ts`'s mock scorer.
_POSITIVE_WORDS = frozenset(
    {"great", "amazing", "love", "awesome", "happy", "exciting", "fun", "best", "win", "yes"}
)
_NEGATIVE_WORDS = frozenset(
    {"bad", "sad", "hate", "terrible", "worst", "fail", "no", "angry", "afraid", "wrong"}
)
_WORD_RE = re.compile(r"[a-z']+")


@dataclass(frozen=True, slots=True)
class SentenceInput:
    start_ms: int
    end_ms: int
    text: str


def lexicon_score(text: str) -> float:
    """A tiny lexicon-based sentiment score, clamped to ``[-1, 1]``. Mirrors
    `passes.service.ts`'s old `sentimentScore` byte for byte."""
    words = _WORD_RE.findall(text.lower())
    if not words:
        return 0.0
    score = sum(
        (1 if word in _POSITIVE_WORDS else -1 if word in _NEGATIVE_WORDS else 0) for word in words
    )
    return max(-1.0, min(1.0, score / max(3, len(words))))


def lexicon_cues(sentences: list[SentenceInput]) -> list[tuple[int, float]]:
    """Mirrors `passes.service.ts`'s old `sentimentCuesOf`: one `(midMs,
    score)` sample per sentence."""
    return [
        (round((sentence.start_ms + sentence.end_ms) / 2), lexicon_score(sentence.text))
        for sentence in sentences
    ]


async def score_sentiment(
    sentences: list[SentenceInput],
    *,
    llm_providers: tuple[LlmProvider, ...],
    region: str,
    language: str = "en",
    media_title: str | None = None,
    duration_ms: int = 0,
) -> tuple[list[tuple[int, float]], SentimentSource]:
    """Scores every sentence through the `music-mood@1` template
    (`source: "llm"`); on any failure of the whole LLM seam — every provider
    failing, a region block, or output that never validates even after
    repair — falls back to the deterministic lexicon scorer
    (`source: "lexicon"`) rather than propagating the error, so a music pass
    never fails outright for want of an LLM call. Empty `sentences` short-
    circuits to an empty, lexicon-sourced result (nothing to score, nothing
    to call an LLM about)."""
    if not sentences:
        return [], "lexicon"

    transcript = TranscriptInput(
        language=language,
        duration_ms=duration_ms,
        segments=tuple(
            TranscriptSegment(start_ms=s.start_ms, end_ms=s.end_ms, text=s.text)
            for s in sentences
        ),
        media_title=media_title,
    )
    try:
        result = await generate_insight("music-mood", transcript, llm_providers, region)
    except (AllProvidersFailedError, InvalidOutputError, RegionBlockedError):
        return lexicon_cues(sentences), "lexicon"

    scores_raw = result.output.get("scores")
    if not isinstance(scores_raw, list):
        return lexicon_cues(sentences), "lexicon"

    by_index: dict[int, float] = {}
    for entry in scores_raw:
        if not isinstance(entry, dict):
            continue
        index = entry.get("index")
        score = entry.get("sentiment")
        if isinstance(index, int) and isinstance(score, (int, float)) and not isinstance(
            score, bool
        ):
            by_index[index] = float(score)

    cues: list[tuple[int, float]] = []
    for i, sentence in enumerate(sentences):
        mid_ms = round((sentence.start_ms + sentence.end_ms) / 2)
        score = by_index.get(i)
        cues.append((mid_ms, score if score is not None else lexicon_score(sentence.text)))
    return cues, "llm"
