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

Music notes and sound labels (``♪``, ``[Music]``) are not words here: Whisper
times them like speech, and a window of them was proposed as a moment.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final

from worker_ai.highlights.contracts import MIN_DURATION_MS
from worker_ai.highlights.text import carries_break, ends_clause, ends_sentence_before, is_speech

__all__ = [
    "PAUSE_MS",
    "WINDOW_BUDGET",
    "Unit",
    "Window",
    "Word",
    "build_units",
    "enumerate_windows",
    "padded_windows",
    "select",
    "sentence_ends",
    "spoken_count",
    "usable_words",
]

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


@dataclass(frozen=True, slots=True)
class Unit:
    """A sentence, or a piece of an overlong one: words ``first..last``."""

    first: int
    last: int
    start_ms: int
    end_ms: int
    #: The unit's last word closes a sentence (the last piece of a split one does).
    sentence_end: bool = False


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
        for low, high in _split_overlong(words, first, last, cap_ms):
            units.append(
                Unit(
                    first=low,
                    last=high,
                    start_ms=words[low].start_ms,
                    end_ms=words[high].end_ms,
                    sentence_end=ends[high],
                )
            )
    return units


def _window_id(sequence: int) -> str:
    # Five digits: the budget keeps ids below 100,000, so they sort as they were made.
    return f"w-{sequence:05d}"


def _end_ranges(units: Sequence[Unit], *, min_ms: int, max_ms: int) -> list[tuple[int, int]]:
    """For each unit, the units a window starting on it can end on: ``lo..hi``.

    ``lo`` is the first end that reaches ``min_ms`` and ``hi`` the last before
    one passes ``max_ms``; both only move forward as the start does, so this is
    one pass rather than one per start. ``lo > hi`` when nothing fits.
    """
    ranges: list[tuple[int, int]] = []
    lo = past = 0
    for a, head in enumerate(units):
        lo = max(lo, a)
        while lo < len(units) and units[lo].end_ms - head.start_ms < min_ms:
            lo += 1
        past = max(past, a)
        while past < len(units) and units[past].end_ms - head.start_ms <= max_ms:
            past += 1
        ranges.append((lo, past - 1))
    return ranges


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
    units: Sequence[Unit], *, min_ms: int, max_ms: int, budget: int = WINDOW_BUDGET
) -> list[Window]:
    """Every run of consecutive units whose span is within ``[min_ms, max_ms]``.

    Up to ``budget`` of them. Past it, starts are thinned first, down to one per
    stretch of ``budget / 8``, and then each start keeps an even share of its
    ends: every part of the video still has windows of every length, cut at its
    cleanest breaks.

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
            # Words can overlap, so a later unit can end earlier than the one before it.
            if tail.end_ms - head.start_ms < min_ms:
                continue
            windows.append(
                Window(
                    window_id=_window_id(len(windows) + 1),
                    first=head.first,
                    last=tail.last,
                    start_ms=head.start_ms,
                    end_ms=tail.end_ms,
                )
            )
    return windows


def padded_windows(
    units: Sequence[Unit], *, min_ms: int, max_ms: int, timeline_end_ms: int
) -> list[Window]:
    """For a transcript where no window fits: runs of units padded up to ``min_ms``.

    From each unit, take as many following units as fit in ``max_ms``, then
    widen the cut into the silence on either side - half before, half after,
    never past a neighbouring word, the start of the media or the end of the
    transcript. A run whose speech spans less than a third of the minimum is
    left out: fifteen seconds of silence around one word is not a moment.
    """
    min_speech_ms = max(MIN_DURATION_MS, min_ms // 3)
    windows: list[Window] = []
    for a, head in enumerate(units):
        b = a
        while b + 1 < len(units) and units[b + 1].end_ms - head.start_ms <= max_ms:
            b += 1
        tail = units[b]
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
        windows.append(
            Window(
                window_id=_window_id(len(windows) + 1),
                first=head.first,
                last=tail.last,
                start_ms=head.start_ms - before,
                end_ms=tail.end_ms + after,
            )
        )
    return windows


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
