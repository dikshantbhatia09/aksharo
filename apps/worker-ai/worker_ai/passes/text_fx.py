"""The text-fx pass (D06): key phrases -> title events.

Pure, dependency-light, like every other module in this package: it takes the
LLM's raw ``keyphrases@1`` output (already validated JSON, one dict per
phrase: ``phrase``/``startMs``/``endMs``) plus the transcript's own words and
the document's guarded ranges, and returns a rate-limited, word-snapped,
classified list of :class:`TextFxEvent`. The queue adapter
(``processors/text_fx_pass.py``) calls the LLM, then this module, then shapes
the result for the completion handler.

### Rules (03-architecture/09-ai-pipeline.md §6, brief D06 rule 1)

- **Rate limit:** at most one phrase every ``min_gap_ms`` (20 s) and at most
  ``max_per_window`` (12) per rolling ``window_ms`` (10 min).
- **Snapping:** each phrase's span is snapped to the ``s``/``e`` of the
  transcript words it actually covers (nearest word boundaries), never to the
  LLM's own (frequently approximate) millisecond guess.
- **Guarding:** a phrase is dropped outright — never clamped — when its
  snapped span intersects a protected range or an accepted cut's range.
- **Intent:** classified from surface cues in the phrase text (a question, a
  number, a quoted claim, or "the rest") into ``title | stat | quote | hook``,
  each with its own default motion preset (`render-core`'s
  `DEFAULT_PRESET_BY_INTENT`, mirrored here as `_PRESET_BY_INTENT` so this
  worker never imports the TypeScript render package).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

__all__ = [
    "MAX_PER_WINDOW",
    "MIN_GAP_MS",
    "RATE_LIMIT_WINDOW_MS",
    "TextFxEvent",
    "Word",
    "build_text_fx_events",
    "classify_intent",
]

MIN_GAP_MS = 20_000
MAX_PER_WINDOW = 12
RATE_LIMIT_WINDOW_MS = 600_000

TextFxIntent = Literal["title", "stat", "quote", "hook"]

#: Mirrors `render-core`'s `DEFAULT_PRESET_BY_INTENT` (`packages/render-core/
#: src/textfx/presets.ts`) — kept in sync by inspection, not by import, since
#: this worker has no TypeScript dependency.
_PRESET_BY_INTENT: dict[TextFxIntent, str] = {
    "title": "pop",
    "stat": "count-up",
    "quote": "fade",
    "hook": "slide-up",
}

_NUMBER_RE = re.compile(r"\d")
_QUOTE_CHARS = ('"', "“", "”", "'")


@dataclass(frozen=True, slots=True)
class Word:
    wid: str
    s: int
    e: int
    t: str


@dataclass(frozen=True, slots=True)
class TextFxEvent:
    text: str
    intent: TextFxIntent
    start_ms: int
    end_ms: int
    anchor_word_ids: tuple[str, ...]
    motion_preset: str
    confidence: float
    reason: str


def classify_intent(phrase: str) -> TextFxIntent:
    """Surface-cue classification — no model call, just the phrase's own text.

    A question mark is a `hook` (it is written to make the viewer keep
    watching); a digit is a `stat`; a quoted phrase is a `quote`; anything
    else is a plain `title`.
    """
    stripped = phrase.strip()
    if stripped.endswith("?"):
        return "hook"
    if any(char in _QUOTE_CHARS for char in stripped):
        return "quote"
    if _NUMBER_RE.search(stripped) is not None:
        return "stat"
    return "title"


def _snap_to_words(
    start_ms: int, end_ms: int, words: list[Word]
) -> tuple[int, int, tuple[str, ...]] | None:
    """The transcript words overlapping `[start_ms, end_ms)`, and the snapped
    span (`first.s`, `last.e`). `None` when no word overlaps at all.
    """
    covering = [w for w in words if w.e > start_ms and w.s < end_ms]
    if not covering:
        return None
    covering.sort(key=lambda w: w.s)
    return covering[0].s, covering[-1].e, tuple(w.wid for w in covering)


def _overlaps_any(start: int, end: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start < r_end and r_start < end for r_start, r_end in ranges)


def _as_int(value: object, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _as_str(value: object) -> str:
    return value if isinstance(value, str) else ""


def build_text_fx_events(
    keyphrases: list[dict[str, object]],
    words: list[Word],
    *,
    guarded_ranges: list[tuple[int, int]] | None = None,
    min_gap_ms: int = MIN_GAP_MS,
    max_per_window: int = MAX_PER_WINDOW,
    window_ms: int = RATE_LIMIT_WINDOW_MS,
) -> list[TextFxEvent]:
    """Turns raw `keyphrases@1` output into rate-limited, word-snapped,
    classified :class:`TextFxEvent`, earliest first.

    Processing order is earliest-phrase-first (the LLM's own order is not
    trusted to be chronological); a candidate is dropped — never shifted or
    clamped — when it fails to snap to any word, falls inside a guarded
    range, is within `min_gap_ms` of the previous accepted event, or would
    put more than `max_per_window` events inside any trailing `window_ms`
    window ending at its own start.
    """
    guarded = guarded_ranges or []
    ordered = sorted(
        keyphrases,
        key=lambda item: (_as_int(item.get("startMs"), default=0), _as_str(item.get("phrase"))),
    )

    events: list[TextFxEvent] = []
    accepted_starts: list[int] = []

    for item in ordered:
        phrase = _as_str(item.get("phrase")).strip()
        if not phrase:
            continue
        raw_start = _as_int(item.get("startMs"), default=0)
        raw_end = _as_int(item.get("endMs"), default=raw_start)

        snapped = _snap_to_words(raw_start, raw_end, words)
        if snapped is None:
            continue
        start_ms, end_ms, anchor_word_ids = snapped
        if end_ms <= start_ms:
            continue

        if _overlaps_any(start_ms, end_ms, guarded):
            continue

        if accepted_starts and start_ms - accepted_starts[-1] < min_gap_ms:
            continue

        window_start = start_ms - window_ms
        in_window = sum(1 for s in accepted_starts if s > window_start)
        if in_window >= max_per_window:
            continue

        intent = classify_intent(phrase)
        events.append(
            TextFxEvent(
                text=phrase,
                intent=intent,
                start_ms=start_ms,
                end_ms=end_ms,
                anchor_word_ids=anchor_word_ids,
                motion_preset=_PRESET_BY_INTENT[intent],
                confidence=0.7,
                reason="keyphrase",
            )
        )
        accepted_starts.append(start_ms)

    return events
