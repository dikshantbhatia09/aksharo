"""Proportional alignment refined by VAD boundaries — the always-available rung.

The bottom of the `09 §2` chain, and the only one that needs no model. It is what
runs behind Sarvam (which returns chunk-level timestamps only) until IndicWav2Vec
lands in A10, so it has to be *correct*, not merely present.

The algorithm, in three passes:

1. **Distribute by character length.** A word's share of the span is its length
   over the total, because letters are a better proxy for duration than word count
   — "matlab" takes longer to say than "toh".
2. **Snap onto speech.** The span's VAD speech regions are laid end to end and the
   proportional positions are mapped onto that timeline, so a word can never be
   placed inside a silence. A word whose share would carry it across a silence is
   cut short at the end of its own region rather than stretched over the gap —
   otherwise the editor would highlight it through seconds of nothing. With no
   regions the span itself is the timeline.
3. **Repair monotonicity.** Rounding and snapping can make two words share a
   boundary; a final forward pass guarantees ``s ≤ e`` for every word,
   ``e[i] ≤ s[i+1]`` between them, and every timing inside the span.

Pass 3 is what the property test pins, because it is the invariant everything
downstream — segmentation, `timemap`, the editor's word highlighting — assumes.
"""

from __future__ import annotations

from worker_ai.alignment.base import Aligner
from worker_ai.providers.base import AlignmentRequest, Word
from worker_ai.vad import SpeechRegion

__all__ = ["ProportionalAligner", "distribute"]


def distribute(
    words: tuple[str, ...],
    start_ms: int,
    end_ms: int,
    regions: tuple[SpeechRegion, ...] = (),
) -> tuple[tuple[int, int], ...]:
    """Timings for ``words`` across ``[start_ms, end_ms]``, snapped to ``regions``.

    Exported separately from the aligner so the maths can be property-tested
    without constructing a request.
    """
    count = len(words)
    if count == 0:
        return ()
    span = max(0, end_ms - start_ms)
    if span == 0:
        return tuple((start_ms, start_ms) for _ in words)

    weights = [max(1, len(word.strip()) or 1) for word in words]
    total = float(sum(weights))

    # The speech timeline: the region slices inside the span, or the span itself.
    slices = _speech_slices(start_ms, end_ms, regions)
    speech_total = sum(end - begin for begin, end in slices)
    if speech_total <= 0:
        slices = [(start_ms, end_ms)]
        speech_total = span

    cursor = 0.0
    timings: list[tuple[int, int]] = []
    for weight in weights:
        share = speech_total * weight / total
        word_start, start_slice = _project(cursor, slices)
        word_end, end_slice = _project(min(float(speech_total), cursor + share), slices)
        if end_slice != start_slice:
            # The word would otherwise straddle a silence and be highlighted over
            # it in the editor. It ends where its own speech region does.
            word_end = slices[start_slice][1]
        timings.append((word_start, word_end))
        cursor += share

    return _monotonic(timings, start_ms, end_ms)


def _speech_slices(
    start_ms: int, end_ms: int, regions: tuple[SpeechRegion, ...]
) -> list[tuple[int, int]]:
    """Region intersections with the span, in order."""
    slices: list[tuple[int, int]] = []
    for region in regions:
        begin = max(region.start_ms, start_ms)
        finish = min(region.end_ms, end_ms)
        if finish > begin:
            slices.append((begin, finish))
    return slices


def _project(offset: float, slices: list[tuple[int, int]]) -> tuple[int, int]:
    """Map an offset along the concatenated speech timeline back to wall time.

    Returns the wall time **and the index of the slice it landed in**, because the
    caller has to know when a word would cross from one speech region into the
    next.
    """
    remaining = offset
    for index, (begin, finish) in enumerate(slices):
        length = finish - begin
        if remaining <= length:
            return round(begin + remaining), index
        remaining -= length
    return slices[-1][1], len(slices) - 1


def _monotonic(
    timings: list[tuple[int, int]], start_ms: int, end_ms: int
) -> tuple[tuple[int, int], ...]:
    """Force ``start ≤ s ≤ e ≤ end`` and non-overlap, keeping the order given."""
    repaired: list[tuple[int, int]] = []
    floor = start_ms
    for begin, finish in timings:
        word_start = min(max(begin, floor), end_ms)
        word_end = min(max(finish, word_start), end_ms)
        repaired.append((word_start, word_end))
        floor = word_end
    return tuple(repaired)


class ProportionalAligner(Aligner):
    """Character-proportional distribution, snapped to VAD speech regions."""

    name = "proportional-vad"
    languages = ()  # every language; it is the fallback for all of them
    rank = 100

    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        end_ms = request.end_ms if request.end_ms is not None else request.start_ms
        timings = distribute(request.words, request.start_ms, end_ms, regions)
        return tuple(
            Word(s=start + request.offset_ms, e=end + request.offset_ms, t=text)
            for text, (start, end) in zip(request.words, timings, strict=True)
        )
