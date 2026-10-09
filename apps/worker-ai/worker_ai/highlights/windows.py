"""Candidate windows over the whole transcript, and the choice between them.

The first version walked the transcript once, kept windows in time order and
returned the first ``count`` - so every "suggested moment" of a six-minute
video came from its first 91 seconds, and the 14 windows after them were
never looked at. It also dropped any sentence longer than the maximum whole,
recognised only Latin full stops, and when nothing fitted it fell back to the
first 51 words however far apart they were.

Here:

1. The transcript becomes **units**: sentences (``.`` ``!`` ``?`` ``…`` and the
   danda ``।`` ``॥``; in a transcript with next to no marks, like local
   Whisper's Devanagari, a pause of :data:`PAUSE_MS`). A sentence longer than a
   quarter of the maximum length (or the minimum, if that is longer) is split
   at its strongest internal break - a pause of :data:`PAUSE_MS` or more, else
   a comma, else the middle - until the pieces fit. Nothing is dropped, so a
   transcript with no pauses and no punctuation still yields windows.
2. Every run of consecutive units whose span lies in the requested
   ``[min, max]`` is a **window**, across the entire video - up to
   :data:`WINDOW_BUDGET` of them. Past that, starts and ends are thinned
   evenly along the video, keeping the cleanest cut of each stretch.
3. Only when no window fits at all (speech in short islands far apart) is a run
   of units **padded** with the silence around it up to the minimum length -
   never into a neighbouring word, so the cut holds exactly the words its
   excerpt quotes.
4. :func:`select` takes the best windows by score, never overlapping, and at
   most ``ceil(count / 2)`` from any third of the video while other thirds
   still have candidates. A near-tie goes to the less-used third.

A window that overlaps any of the run's ``excludeRanges`` (2026-09-29: the
intro, the outro, a sponsor read the person asked to skip) is dropped as it is
enumerated, before anything is scored - so a padded window is still looked for
when every sentence window falls inside what was skipped.

Music notes and sound labels (``♪``, ``[Music]``) are not words here: Whisper
times them like speech, and a window of them was proposed as a moment.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final

from worker_ai.highlights.contracts import MAX_DURATION_MS, MIN_DURATION_MS, ExcludeRange
from worker_ai.highlights.text import carries_break, ends_clause, ends_sentence_before, is_speech

__all__ = [
    "DISALLOWED_CLOSINGS",
    "DISALLOWED_OPENINGS",
    "DURATION_BINS_MS",
    "HARD_BREAK_PATTERNS",
    "PAUSE_MS",
    "SPONSOR_PATTERNS",
    "WINDOW_BUDGET",
    "Unit",
    "Window",
    "Word",
    "build_units",
    "discourse_opening_advance",
    "enumerate_windows",
    "filter_windows_by_duration",
    "is_incomplete_closing",
    "outside",
    "padded_windows",
    "select",
    "sentence_ends",
    "snap_to_silence",
    "snap_to_silence_ms",
    "snap_window_to_silence",
    "snap_windows",
    "spoken_count",
    "usable_words",
    "words_to_silence_gaps",
]

#: Preset duration bins in milliseconds (Pillar 2 §05).
DURATION_BINS_MS: Final[dict[str, tuple[int, int]]] = {
    "UNDER_30": (15_000, 30_000),
    "BETWEEN_30_60": (30_000, 60_000),
    "BETWEEN_60_90": (60_000, 90_000),
    "BETWEEN_90_180": (90_000, 180_000),
    "AUTO": (20_000, 90_000),
}

#: Explicit transition markers that start a new news item or segment.
HARD_BREAK_PATTERNS: Final = re.compile(
    r"\b("
    r"also this week|"
    r"our next model|"
    r"moving on to|"
    r"next up|"
    r"in other news|"
    r"in this next story|"
    r"coming up next|"
    r"here's another one"
    r")\b",
    re.IGNORECASE,
)

#: Commercial reads and sponsor promotions that must never bleed into clips.
SPONSOR_PATTERNS: Final = re.compile(
    r"\b("
    r"the sponsor of this video|"
    r"definitely check out .* sponsor|"
    r"sponsored by|"
    r"brought to you by|"
    r"a word from our sponsor|"
    r"thanks to .* for sponsoring"
    r")\b",
    re.IGNORECASE,
)

#: Fast intro recap hooks that rattle off multiple stories without substance.
INTRO_TEASER_PATTERNS: Final = re.compile(
    r"\b("
    r"this week has been absolutely insane|"
    r"this week has been crazy|"
    r"ai never sleeps|"
    r"in this video we'll cover|"
    r"coming up in this episode"
    r")\b",
    re.IGNORECASE,
)

#: Sentence openers that continue earlier context or start with orphan pronouns.
ORPHAN_START_PATTERNS: Final = re.compile(
    r"^(?:"
    r"(?:and|so|now|well|also|plus|still|basically|honestly|then)\s+)?"
    r"(?:"
    r"it\s+(?:also|is|was|can|has|turns|means|works|needs|takes|looks)|"
    r"they\s+(?:also|are|were|can|have|released|used|found)|"
    r"he\s+(?:also|is|was|can|has|fed|said)|"
    r"she\s+(?:also|is|was|can|has|said)|"
    r"here(?:'s|s)\s+(?:its|their|another|how|an\s+example|benchmark)|"
    r"its\s+|their\s+|"
    r"this\s+(?:is|takes|just|can|one)|"
    r"these\s+|those\s+|"
    r"still\s+(?:a\s+few|another)|"
    r"apparently\s+(?:they|it|we)|"
    r"if\s+you\s+(?:look\s+at|scroll\s+up)"
    r")\b",
    re.IGNORECASE,
)

#: A gap between words this long is a breath, not a word boundary.
PAUSE_MS: Final[int] = 700
#: The most windows one transcript has scored. An ordinary video is nowhere
#: near it (an 18-minute talk has about 2,000), but six hours of three-word
#: sentences with the widest bounds a run accepts had over a million: most of
#: a minute of CPU and about a gigabyte, on the loop every AI queue shares.
WINDOW_BUDGET: Final[int] = 40_000
#: When the budget binds, starts are thinned before a start keeps fewer ends.
_MIN_ENDS_PER_START: Final[int] = 8
#: Fewer sentence marks than one in this many words, and the transcript is
#: read as unpunctuated. Speech runs 10-20 words to a sentence; local Whisper's
#: Hindi has no marks at all.
_UNPUNCTUATED_WORDS_PER_MARK: Final[int] = 50
#: The contract's word-id limit (``startWordId``/``endWordId`` are max 100).
_MAX_WORD_ID: Final[int] = 100
#: What each pick already in a third of the video costs the next candidate
#: there, in potential (0-1): five points, so a window three points better in
#: an already-represented stretch loses to one elsewhere, and one ten points
#: better does not.
_SPREAD_PENALTY: Final[float] = 0.05


@dataclass(frozen=True, slots=True)
class Word:
    wid: str
    text: str
    start_ms: int
    end_ms: int


#: Disallowed discourse openings that indicate trailing context or fragmented thoughts (Pillar 2 §03).
DISALLOWED_OPENINGS: Final[frozenset[str]] = frozenset({
    "and",
    "but",
    "so",
    "because",
    "or",
    "like i said",
    "like i was saying",
    "as mentioned",
    "as i said",
    "anyway",
    "well",
    "and then",
    "and so",
    "so anyway",
    "but then",
    "aur",
    "lekin",
    "kyunki",
    "waise",
})

#: Disallowed closing conjunctions that leave sentences hanging (Pillar 2 §03).
DISALLOWED_CLOSINGS: Final[frozenset[str]] = frozenset({
    "and",
    "but",
    "because",
    "if",
    "when",
    "which",
    "that",
    "so",
    "like",
    "or",
    "with",
    "as",
    "aur",
    "lekin",
    "to",
    "kyunki",
})


def discourse_opening_advance(words: Sequence[Word], first: int, last: int) -> int:
    """Calculates how many leading words to advance past disallowed discourse connectors."""
    if first > last:
        return 0
    clean_words = [w.text.lower().rstrip(".,!?;:\"'—–-") for w in words[first : min(last + 1, first + 5)]]
    if len(clean_words) >= 4:
        four = " ".join(clean_words[:4])
        if four in ("like i was saying",):
            return 4
    if len(clean_words) >= 3:
        three = " ".join(clean_words[:3])
        if three in ("like i said", "as i said", "so anyway", "like i was"):
            return 3
    if len(clean_words) >= 2:
        two = " ".join(clean_words[:2])
        if two in ("as mentioned", "and then", "and so", "but then", "so anyway"):
            return 2
    if len(clean_words) >= 1:
        one = clean_words[0]
        if one in ("and", "but", "so", "because", "or", "anyway", "well", "aur", "lekin", "kyunki", "waise"):
            return 1
    return 0


def is_incomplete_closing(words: Sequence[Word], first: int, last: int) -> bool:
    """True if the trailing words form an incomplete dependency clause or hanging conjunction."""
    if last < first:
        return False
    raw_tail = words[last].text
    clean_tail = raw_tail.lower().rstrip(".,!?;:\"'—–-")
    if clean_tail in ("and", "but", "because", "if", "when", "which", "so", "or", "aur", "lekin", "to", "kyunki"):
        return True
    if clean_tail in ("that", "like", "with", "as"):
        if not raw_tail.endswith((".", "!", "?", "।", "॥")):
            return True
    if last - first >= 2:
        three = " ".join(w.text.lower().rstrip(".,!?;:\"'—–-") for w in words[last - 2 : last + 1])
        if three in ("which means that", "in order to", "so much that"):
            return True
    if last - first >= 1:
        two = " ".join(w.text.lower().rstrip(".,!?;:\"'—–-") for w in words[last - 1 : last + 1])
        if two in ("because of", "and then", "so that", "such as", "due to"):
            return True
    return False


@dataclass(frozen=True, slots=True)
class Unit:
    """A sentence, or a piece of an overlong one: words ``first..last``."""

    first: int
    last: int
    start_ms: int
    end_ms: int
    #: The unit's last word closes a sentence (the last piece of a split one does).
    sentence_end: bool = False
    is_hard_break: bool = False
    is_sponsor: bool = False
    is_teaser: bool = False
    starts_sentence: bool = True
    is_orphan_start: bool = False
    has_disallowed_opening: bool = False
    has_disallowed_closing: bool = False
    opening_advance: int = 0


@dataclass(frozen=True, slots=True)
class Window:
    """Words ``first..last``, cut at ``start_ms..end_ms``.

    ``start_ms``/``end_ms`` are the words' own edges, except for a padded window,
    which reaches into the silence around them.
    """

    window_id: str
    first: int
    last: int
    start_ms: int
    end_ms: int


def _milliseconds(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if not math.isfinite(value):
        return None
    return round(value)


def _citable(item: dict[Any, Any]) -> tuple[str, str] | None:
    """The id and text of a words-response item a proposal could quote, whatever its timing.

    One check for :func:`usable_words` and :func:`spoken_count`, so the two can
    only ever differ by timing - which is what the untimed-transcript failure
    claims they differ by.
    """
    wid = item.get("wid")
    text = item.get("text")
    if not isinstance(wid, str) or not wid.strip() or len(wid.strip()) > _MAX_WORD_ID:
        return None
    if not isinstance(text, str) or not text.strip():
        return None
    return wid.strip(), text.strip()


def usable_words(raw: Sequence[object]) -> list[Word]:
    """The spoken words a window can be built from, in time order.

    A word needs an id to cite, speech in its text (:func:`is_speech` - not a
    music note or a ``[Music]`` label), and timings that make sense
    (``0 <= start <= end``). A zero-length word is kept: aligners produce the
    odd one, and it still belongs in the excerpt. A token that is only a mark,
    like a danda sent as its own "word", is not cited either, but its mark
    joins the word before it so the sentence still ends there. The caller
    decides what to do when too few words survive.
    """
    tokens: list[Word] = []
    for item in raw:
        if not isinstance(item, dict) or (cited := _citable(item)) is None:
            continue
        start = _milliseconds(item.get("startMs"))
        end = _milliseconds(item.get("endMs"))
        if start is None or end is None or start < 0 or end < start:
            continue
        wid, text = cited
        tokens.append(Word(wid=wid, text=text, start_ms=start, end_ms=end))
    # Stable: a well-formed transcript is already in order and stays exactly so.
    tokens.sort(key=lambda word: word.start_ms)

    words: list[Word] = []
    for token in tokens:
        if is_speech(token.text):
            words.append(token)
        elif words and carries_break(token.text):
            before = words[-1]
            words[-1] = Word(before.wid, before.text + token.text, before.start_ms, before.end_ms)
    return words


def spoken_count(raw: Sequence[object]) -> int:
    """How many items of a words response are citable speech, whatever their timing.

    The words :func:`usable_words` would keep if every timing were sound. A
    word whose id is missing or overlong is left out here too: it is not a
    word without a timing, and counting it would report a malformed response
    as an untimed transcript and send the user to transcribe again for nothing.
    """
    return sum(
        1
        for item in raw
        if isinstance(item, dict) and (cited := _citable(item)) is not None and is_speech(cited[1])
    )


def sentence_ends(words: Sequence[Word]) -> list[bool]:
    """Which words close a sentence.

    The transcript's own marks, where it has them. Where it has next to none
    (local Whisper's Hindi), a pause of :data:`PAUSE_MS` or more: the only
    sentence end such a transcript has, and without it only its very first word
    could ever start a sentence, which put that window ahead of every other.
    """
    marked = [
        ends_sentence_before(word.text, words[index + 1].text if index + 1 < len(words) else None)
        for index, word in enumerate(words)
    ]
    if sum(marked) * _UNPUNCTUATED_WORDS_PER_MARK >= len(words):
        return marked
    return [
        mark or (index + 1 < len(words) and words[index + 1].start_ms - word.end_ms >= PAUSE_MS)
        for index, (word, mark) in enumerate(zip(words, marked, strict=True))
    ]


def _sentence_spans(ends: Sequence[bool]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    first = 0
    for index, end in enumerate(ends):
        if end or index == len(ends) - 1:
            spans.append((first, index))
            first = index + 1
    return spans


def _break_strength(words: Sequence[Word], index: int) -> int:
    """How good a place the gap after word ``index`` is to split a sentence."""
    if words[index + 1].start_ms - words[index].end_ms >= PAUSE_MS:
        return 2
    if ends_clause(words[index].text):
        return 1
    return 0


def _split_overlong(
    words: Sequence[Word], first: int, last: int, cap_ms: int
) -> list[tuple[int, int]]:
    """Split ``first..last`` until every piece spans at most ``cap_ms`` (or is one word)."""
    pieces: list[tuple[int, int]] = []
    pending = [(first, last)]
    while pending:
        low, high = pending.pop()
        if low == high or words[high].end_ms - words[low].start_ms <= cap_ms:
            pieces.append((low, high))
            continue
        middle = (words[low].start_ms + words[high].end_ms) / 2
        # Strongest break first; among equals, the one nearest the middle, so the
        # pieces stay balanced; among those, the earlier one, so it is deterministic.
        cut = max(
            range(low, high),
            key=lambda k: (_break_strength(words, k), -abs(words[k].end_ms - middle), -k),
        )
        pending.append((low, cut))
        pending.append((cut + 1, high))
    return sorted(pieces)


def build_units(words: Sequence[Word], *, min_ms: int, max_ms: int) -> list[Unit]:
    """Sentences, with any longer than the cap split at their breaks.

    The cap is a quarter of the maximum, or the minimum if that is longer (15 s
    for the default 15-60 s). Windows start and end only on unit edges, so
    the cap is what lets a window begin at a pause inside a long sentence - and,
    for unpunctuated Whisper Devanagari, where the whole transcript is one
    "sentence", it is the difference between a handful of windows and a real
    choice. Splitting a sentence costs nothing: the window that takes all its
    pieces is still enumerated, and still scores as complete.
    """
    cap_ms = max(min_ms, max_ms // 4)
    ends = sentence_ends(words)
    units: list[Unit] = []
    for first, last in _sentence_spans(ends):
        pieces = _split_overlong(words, first, last, cap_ms)
        for piece_idx, (low, high) in enumerate(pieces):
            advance = discourse_opening_advance(words, low, high) if piece_idx == 0 else 0
            effective_low = low + advance if (low + advance <= high) else low
            has_open = bool(advance > 0)
            has_close = is_incomplete_closing(words, effective_low, high)
            unit_text = " ".join(words[k].text for k in range(effective_low, high + 1))
            is_break = bool(HARD_BREAK_PATTERNS.search(unit_text))
            from worker_ai.highlights.sponsors import is_commercial_segment
            is_spon = bool(SPONSOR_PATTERNS.search(unit_text)) or is_commercial_segment(unit_text)
            is_teas = bool(words[effective_low].start_ms <= 60_000 and INTRO_TEASER_PATTERNS.search(unit_text))
            is_orphan = bool(effective_low > 0 and ORPHAN_START_PATTERNS.search(unit_text))
            starts_sent = (piece_idx == 0) and (low + advance <= high)
            units.append(
                Unit(
                    first=effective_low,
                    last=high,
                    start_ms=words[effective_low].start_ms,
                    end_ms=words[high].end_ms,
                    sentence_end=ends[high],
                    is_hard_break=is_break,
                    is_sponsor=is_spon,
                    is_teaser=is_teas,
                    starts_sentence=starts_sent,
                    is_orphan_start=is_orphan,
                    has_disallowed_opening=has_open,
                    has_disallowed_closing=has_close,
                    opening_advance=advance,
                )
            )
    return units


def _window_id(sequence: int) -> str:
    # Five digits: the budget keeps ids below 100,000, so they sort as they were made.
    return f"w-{sequence:05d}"


def outside(windows: Sequence[Window], exclude: Sequence[ExcludeRange] | None) -> list[Window]:
    """The windows that overlap none of ``exclude``, in their order.

    Half-open: a window that ends exactly where a skipped range starts (or
    starts where one ends) touches it without taking any of it, and is kept.
    Ids are left as enumerated, so a proposal still names the window it was
    chosen from.
    """
    if not exclude:
        return list(windows)
    spans = [(span.start_ms, span.end_ms) for span in exclude]
    return [
        window
        for window in windows
        if not any(window.start_ms < end and start < window.end_ms for start, end in spans)
    ]


def _end_ranges(units: Sequence[Unit], *, min_ms: int, max_ms: int) -> list[tuple[int, int]]:
    """For each unit, the units a window starting on it can end on: ``lo..hi``.

    ``lo`` is the first end that reaches ``min_ms`` and ``hi`` the last before
    one passes ``max_ms``; both only move forward as the start does, so this is
    one pass rather than one per start. ``lo > hi`` when nothing fits.

    Transitions and sponsor cues block windows from crossing them, and sponsor
    reads or intro teasers cannot start a window.
    """
    next_blocker = [len(units)] * len(units)
    last_blocker = len(units)
    for i in range(len(units) - 1, -1, -1):
        next_blocker[i] = last_blocker
        if units[i].is_hard_break or units[i].is_sponsor:
            last_blocker = i

    punctuated = sum(u.sentence_end for u in units) * _UNPUNCTUATED_WORDS_PER_MARK >= len(units)
    ranges: list[tuple[int, int]] = []
    lo = past = 0
    for a, head in enumerate(units):
        if head.is_sponsor or head.is_teaser:
            ranges.append((1, 0))
            continue
        if punctuated and not head.starts_sentence:
            ranges.append((1, 0))
            continue

        lo = max(lo, a)
        while lo < len(units) and units[lo].end_ms - head.start_ms < min_ms:
            lo += 1
        past = max(past, a)
        while past < len(units) and units[past].end_ms - head.start_ms <= max_ms:
            past += 1

        hi = past - 1
        blocker = next_blocker[a]
        if blocker < len(units):
            hi = min(hi, blocker - 1)

        ranges.append((lo, hi))
    return ranges


def snap_to_silence(
    timestamp: float,
    silences: Sequence[tuple[float, float]],
    tolerance: float = 0.3,
) -> float:
    """Finds the silence interval closest to timestamp and snaps to its midpoint (Pillar 2 §03)."""
    best_mid: float | None = None
    min_dist = float("inf")
    for start, end in silences:
        if start - tolerance <= timestamp <= end + tolerance:
            dist = abs(timestamp - (start + end) / 2.0)
            if dist < min_dist:
                min_dist = dist
                best_mid = (start + end) / 2.0
    return best_mid if best_mid is not None else timestamp


def snap_to_silence_ms(
    timestamp_ms: int,
    silences_ms: Sequence[tuple[int, int]],
    tolerance_ms: int = 300,
) -> int:
    """Finds the silence interval closest to timestamp_ms and snaps to its midpoint."""
    best_mid: int | None = None
    min_dist = float("inf")
    for start, end in silences_ms:
        if start - tolerance_ms <= timestamp_ms <= end + tolerance_ms:
            dist = abs(timestamp_ms - (start + end) / 2.0)
            if dist < min_dist:
                min_dist = dist
                best_mid = round((start + end) / 2.0)
    return best_mid if best_mid is not None else timestamp_ms


def snap_window_to_silence(
    window: Window,
    silences: Sequence[tuple[int, int]],
    words: Sequence[Word] | None = None,
    *,
    min_ms: int = MIN_DURATION_MS,
    max_ms: int = MAX_DURATION_MS,
    tolerance_ms: int = 300,
) -> Window:
    """Snaps window start and end timestamps to silence gap midpoints."""
    new_start = snap_to_silence_ms(window.start_ms, silences, tolerance_ms)
    new_end = snap_to_silence_ms(window.end_ms, silences, tolerance_ms)
    if words:
        first_word = words[window.first]
        last_word = words[window.last]
        # Never slice into the words of this window
        new_start = min(new_start, first_word.start_ms)
        new_end = max(new_end, last_word.end_ms)
        # Never slice into neighbouring words
        if window.first > 0:
            new_start = max(new_start, words[window.first - 1].end_ms)
        if window.last + 1 < len(words):
            new_end = min(new_end, words[window.last + 1].start_ms)
    # Ensure min/max duration constraints remain respected
    if new_end - new_start < min_ms or new_end - new_start > max_ms:
        return window
    return Window(
        window_id=window.window_id,
        first=window.first,
        last=window.last,
        start_ms=new_start,
        end_ms=new_end,
    )


def filter_windows_by_duration(
    windows: Sequence[Window],
    *,
    min_ms: int,
    max_ms: int,
) -> list[Window]:
    """Strictly filters candidate windows so 100% of kept windows satisfy [min_ms, max_ms]."""
    return [w for w in windows if min_ms <= (w.end_ms - w.start_ms) <= max_ms]


def snap_windows(
    windows: Sequence[Window],
    silences: Sequence[tuple[int, int]],
    words: Sequence[Word] | None = None,
    *,
    min_ms: int = MIN_DURATION_MS,
    max_ms: int = MAX_DURATION_MS,
) -> list[Window]:
    """Snaps all windows to nearest silence gap midpoints and strictly filters to [min_ms, max_ms]."""
    snapped = [
        snap_window_to_silence(w, silences, words, min_ms=min_ms, max_ms=max_ms)
        for w in windows
    ]
    return filter_windows_by_duration(snapped, min_ms=min_ms, max_ms=max_ms)


def words_to_silence_gaps(words: Sequence[Word], duration_ms: int = 0) -> list[tuple[int, int]]:
    """Extracts silence intervals (inter-word pauses) from words."""
    gaps: list[tuple[int, int]] = []
    if not words:
        return gaps
    if words[0].start_ms > 0:
        gaps.append((0, words[0].start_ms))
    for i in range(len(words) - 1):
        if words[i + 1].start_ms > words[i].end_ms:
            gaps.append((words[i].end_ms, words[i + 1].start_ms))
    max_end = max(duration_ms, words[-1].end_ms)
    if max_end > words[-1].end_ms:
        gaps.append((words[-1].end_ms, max_end))
    return gaps


def _cleanest_along(
    indices: Sequence[int], keep: int, cut: Sequence[tuple[bool, int]]
) -> list[int]:
    """At most ``keep`` of ``indices``, spread evenly along them.

    They are split into ``keep`` equal runs and each run keeps its cleanest cut
    (a sentence end first, then the longest pause; the earliest among equals),
    so thinning takes away the weakest starts and ends, not a stretch of video.
    """
    if len(indices) <= keep:
        return list(indices)
    size = len(indices)
    return [
        max(indices[k * size // keep : (k + 1) * size // keep], key=cut.__getitem__)
        for k in range(keep)
    ]


def enumerate_windows(
    units: Sequence[Unit],
    *,
    min_ms: int,
    max_ms: int,
    budget: int = WINDOW_BUDGET,
    exclude: Sequence[ExcludeRange] | None = None,
    silences: Sequence[tuple[int, int]] | None = None,
    words: Sequence[Word] | None = None,
) -> list[Window]:
    """Every run of consecutive units whose span is within ``[min_ms, max_ms]``.

    Up to ``budget`` of them. Past it, starts are thinned first, down to one per
    stretch of ``budget / 8``, and then each start keeps an even share of its
    ends: every part of the video still has windows of every length, cut at its
    cleanest breaks. None that overlaps ``exclude`` (:func:`outside`).

    Ids are assigned in time order over ALL windows, before any ranking, so the
    id a proposal carries names the enumerated window it was chosen from.
    """
    ranges = _end_ranges(units, min_ms=min_ms, max_ms=max_ms)
    starts = [a for a, (lo, hi) in enumerate(ranges) if lo <= hi]
    ends_per_start: int | None = None
    cut_after: list[tuple[bool, int]] = []
    if starts and sum(ranges[a][1] - ranges[a][0] + 1 for a in starts) > budget:
        # What a cut after each unit is worth, and before it: the transcript's
        # own start counts as a sentence start with no measured pause.
        cut_after = [
            (unit.sentence_end, units[b + 1].start_ms - unit.end_ms if b + 1 < len(units) else 0)
            for b, unit in enumerate(units)
        ]
        cut_before = [(True, 0), *cut_after[:-1]]
        starts = _cleanest_along(starts, max(1, budget // _MIN_ENDS_PER_START), cut_before)
        ends_per_start = max(1, budget // len(starts))

    windows: list[Window] = []
    for a in starts:
        head = units[a]
        lo, hi = ranges[a]
        ends: Sequence[int] = range(lo, hi + 1)
        if ends_per_start is not None:
            ends = _cleanest_along(ends, ends_per_start, cut_after)
        for b in ends:
            tail = units[b]
            # Syntactic discourse filter: never end on a trailing hanging conjunction
            if tail.has_disallowed_closing:
                continue
            # Words can overlap, so a later unit can end earlier than the one before it.
            span_ms = tail.end_ms - head.start_ms
            if span_ms < min_ms or span_ms > max_ms:
                continue
            w = Window(
                window_id=_window_id(len(windows) + 1),
                first=head.first,
                last=tail.last,
                start_ms=head.start_ms,
                end_ms=tail.end_ms,
            )
            if silences:
                w = snap_window_to_silence(w, silences, words, min_ms=min_ms, max_ms=max_ms)
            # Semantic knapsack strict filtering: discard any window whose total duration
            # after acoustic pause snapping falls outside [min_ms, max_ms].
            snapped_duration_ms = w.end_ms - w.start_ms
            if snapped_duration_ms < min_ms or snapped_duration_ms > max_ms:
                continue
            windows.append(w)
    auto_sponsor_excludes = [
        ExcludeRange(start_ms=u.start_ms, end_ms=u.end_ms)
        for u in units
        if u.is_sponsor
    ]
    all_exclude = list(exclude or []) + auto_sponsor_excludes
    return filter_windows_by_duration(outside(windows, all_exclude), min_ms=min_ms, max_ms=max_ms)


def padded_windows(
    units: Sequence[Unit],
    *,
    min_ms: int,
    max_ms: int,
    timeline_end_ms: int,
    exclude: Sequence[ExcludeRange] | None = None,
    silences: Sequence[tuple[int, int]] | None = None,
    words: Sequence[Word] | None = None,
) -> list[Window]:
    """For a transcript where no window fits: runs of units padded up to ``min_ms``.

    From each unit, take as many following units as fit in ``max_ms``, then
    widen the cut into the silence on either side - half before, half after,
    never past a neighbouring word, the start of the media or the end of the
    transcript. A run whose speech spans less than a third of the minimum is
    left out: fifteen seconds of silence around one word is not a moment. So is
    one whose padded cut overlaps ``exclude`` (:func:`outside`).
    """
    auto_sponsor_excludes = [
        ExcludeRange(start_ms=u.start_ms, end_ms=u.end_ms)
        for u in units
        if u.is_sponsor
    ]
    all_exclude = list(exclude or []) + auto_sponsor_excludes
    min_speech_ms = max(MIN_DURATION_MS, min_ms // 3)
    windows: list[Window] = []
    for a, head in enumerate(units):
        if head.is_sponsor or head.is_teaser:
            continue
        b = a
        while (
            b + 1 < len(units)
            and not (units[b + 1].is_hard_break or units[b + 1].is_sponsor)
            and units[b + 1].end_ms - head.start_ms <= max_ms
        ):
            b += 1
        tail = units[b]
        # Never end a padded window on a trailing conjunction if avoidable
        if tail.has_disallowed_closing and b > a:
            b -= 1
            tail = units[b]
        if tail.has_disallowed_closing:
            continue
        span = tail.end_ms - head.start_ms
        if span > max_ms or span < min_speech_ms:
            continue
        room_before = head.start_ms - (units[a - 1].end_ms if a > 0 else 0)
        room_after = (units[b + 1].start_ms if b + 1 < len(units) else timeline_end_ms) - (
            tail.end_ms
        )
        need = max(0, min_ms - span)
        after = min(max(0, room_after), (need + 1) // 2)
        before = min(max(0, room_before), need - after)
        after = min(max(0, room_after), need - before)
        if before + after < need:
            continue
        w = Window(
            window_id=_window_id(len(windows) + 1),
            first=head.first,
            last=tail.last,
            start_ms=head.start_ms - before,
            end_ms=tail.end_ms + after,
        )
        if silences:
            w = snap_window_to_silence(w, silences, words, min_ms=min_ms, max_ms=max_ms)
        snapped_duration_ms = w.end_ms - w.start_ms
        if snapped_duration_ms < min_ms or snapped_duration_ms > max_ms:
            continue
        windows.append(w)
    return filter_windows_by_duration(outside(windows, all_exclude), min_ms=min_ms, max_ms=max_ms)


def select[T](
    candidates: Sequence[T],
    *,
    count: int,
    window_of: Callable[[T], Window],
    score_of: Callable[[T], float],
    timeline: tuple[int, int],
) -> list[T]:
    """The best ``count`` candidates, best first: no overlaps, spread across the video.

    Each pick is the candidate with the highest score less
    :data:`_SPREAD_PENALTY` for every pick already in its third of the video,
    skipping anything that overlaps a pick or would put more than
    ``ceil(count / 2)`` picks in one third. So a clearly better moment wins
    wherever it is, and a near-tie goes to the stretch not yet represented.

    Only if that leaves slots empty does a second pass fill them without the
    thirds limit. The limit exists to stop five picks crowding one stretch while
    others have material, not to return fewer candidates than the video has - a
    talk whose speech is all in one third still gets ``count``.

    An exact tie in score goes to the window nearer the middle of the video.
    Openings and sign-offs are rarely the moment, and with time order as the
    only tie-break, the first window of an even-sounding video won every tie.
    """
    start, end = timeline
    third_ms = max(1.0, (end - start) / 3)
    middle = (start + end) / 2

    def third(window: Window) -> int:
        midpoint = (window.start_ms + window.end_ms) / 2
        return min(2, max(0, int((midpoint - start) // third_ms)))

    def rank_key(candidate: T) -> tuple[float, float, int, int]:
        window = window_of(candidate)
        off_middle = abs((window.start_ms + window.end_ms) / 2 - middle)
        return (-score_of(candidate), off_middle, window.start_ms, window.end_ms)

    ranked = sorted(candidates, key=rank_key)
    picked: list[T] = []
    per_third: Counter[int] = Counter()

    def best_next(per_third_cap: int | None) -> T | None:
        best: T | None = None
        best_key = -math.inf
        for candidate in ranked:
            # `ranked` is best score first and the penalty only lowers a key, so
            # nothing after this candidate can beat what is already held. A tie
            # keeps the earlier one: higher raw score, then nearer the middle.
            if score_of(candidate) <= best_key:
                break
            used = per_third[third(window_of(candidate))]
            if per_third_cap is not None and used >= per_third_cap:
                continue
            key = score_of(candidate) - _SPREAD_PENALTY * used
            if key > best_key:
                best, best_key = candidate, key
        return best

    for per_third_cap in (math.ceil(count / 2), None):
        while len(picked) < count:
            chosen = best_next(per_third_cap)
            if chosen is None:
                break
            picked.append(chosen)
            per_third[third(window_of(chosen))] += 1
            # Everything overlapping a pick (the pick included) is out for good,
            # so no later pass has to check a candidate against every pick.
            taken = window_of(chosen)
            ranked = [
                c
                for c in ranked
                if not (
                    window_of(c).start_ms < taken.end_ms and taken.start_ms < window_of(c).end_ms
                )
            ]

    picked.sort(key=rank_key)
    return picked
