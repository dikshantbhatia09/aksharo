"""VAD-aligned chunk planning — decision **D14**, `09 §1.1`.

> nominal 10-minute chunks cut at the **longest silence within ±30 s** of each
> boundary; no overlap, no text de-duplication, never mid-word.

The rules as implemented, in the order they are applied to each boundary:

1. Walk to the nominal boundary: ``previous chunk start + 600 000 ms``.
2. Collect every silence gap that **overlaps** the ±30 s search window, clipped to
   that window, and take the longest one; ties go to the gap nearest the nominal
   boundary, so a file of even silences chunks evenly. Cut at that gap's midpoint.
3. With no gap in the window, look for a **speech-region edge** inside the window
   and cut at the one nearest the nominal boundary. That matters for a caller that
   supplies its own regions, where two of them can be exactly adjacent.
4. With neither, cut at the nominal boundary. This is reached only by audio with
   no silence at all across a full minute — one unbroken utterance — where no
   boundary can avoid speech. :func:`boundary_never_splits_speech` is how a caller
   detects it, and ``ai.vad`` logs it.
5. A boundary is clamped to stay after the chunk's start and before the end of the
   file, and a tail shorter than half a nominal chunk is absorbed into the last
   chunk rather than left as a stub.

Chunks are contiguous and non-overlapping: chunk *n* ends exactly where chunk
*n+1* begins, which is what makes ``"<chunkIdx>:<n>"`` word ids stable.
"""

from __future__ import annotations

from dataclasses import dataclass

from worker_ai.vad import SpeechRegion, silence_gaps

__all__ = [
    "BOUNDARY_SEARCH_MS",
    "NOMINAL_CHUNK_MS",
    "ChunkPlanEntry",
    "boundary_never_splits_speech",
    "plan_chunks",
]

#: Nominal chunk length (D14).
NOMINAL_CHUNK_MS = 10 * 60 * 1000

#: How far either side of the nominal boundary a silence may be found (D14).
BOUNDARY_SEARCH_MS = 30 * 1000

#: A trailing chunk shorter than this is merged into its predecessor.
_MIN_TAIL_MS = NOMINAL_CHUNK_MS // 2


@dataclass(frozen=True, slots=True)
class ChunkPlanEntry:
    """One chunk of the plan. ``chunk_idx`` is the ``<chunkIdx>`` of every word id."""

    chunk_idx: int
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms

    def to_wire(self) -> dict[str, int]:
        return {"chunkIdx": self.chunk_idx, "startMs": self.start_ms, "endMs": self.end_ms}


def plan_chunks(
    duration_ms: int,
    regions: tuple[SpeechRegion, ...],
    *,
    nominal_ms: int = NOMINAL_CHUNK_MS,
    search_ms: int = BOUNDARY_SEARCH_MS,
) -> tuple[ChunkPlanEntry, ...]:
    """Plan VAD-aligned chunks over a file of ``duration_ms``.

    :param regions: speech regions from :mod:`worker_ai.vad`, in order.
    :returns: contiguous chunks covering ``[0, duration_ms)``; a file at or under
        one nominal chunk is a single chunk and never touches the VAD.
    """
    if duration_ms <= 0:
        return ()
    if duration_ms <= nominal_ms:
        return (ChunkPlanEntry(chunk_idx=0, start_ms=0, end_ms=duration_ms),)

    gaps = silence_gaps(regions, duration_ms)
    boundaries: list[int] = []
    start = 0
    while duration_ms - start > nominal_ms:
        nominal = start + nominal_ms
        cut = _boundary_at(
            nominal,
            gaps,
            regions,
            search_ms=search_ms,
            floor_ms=start,
            ceiling_ms=duration_ms,
        )
        # Never go backwards, and always leave room for a non-empty tail.
        cut = max(start + 1, min(cut, duration_ms - 1))
        if duration_ms - cut < _MIN_TAIL_MS:
            break
        boundaries.append(cut)
        start = cut

    edges = [0, *boundaries, duration_ms]
    return tuple(
        ChunkPlanEntry(chunk_idx=index, start_ms=edges[index], end_ms=edges[index + 1])
        for index in range(len(edges) - 1)
    )


def _boundary_at(
    nominal_ms: int,
    gaps: tuple[tuple[int, int], ...],
    regions: tuple[SpeechRegion, ...],
    *,
    search_ms: int,
    floor_ms: int,
    ceiling_ms: int,
) -> int:
    """The cut point for one nominal boundary (steps 2-4 of the module docstring)."""
    window_start = nominal_ms - search_ms
    window_end = nominal_ms + search_ms

    best: tuple[int, int] | None = None  # (duration, midpoint)
    for gap_start, gap_end in gaps:
        clipped_start = max(gap_start, window_start)
        clipped_end = min(gap_end, window_end)
        if clipped_end <= clipped_start:
            continue
        duration = clipped_end - clipped_start
        midpoint = (clipped_start + clipped_end) // 2
        if best is None:
            best = (duration, midpoint)
            continue
        # Longest wins; a tie goes to the gap closest to the nominal boundary.
        if duration > best[0] or (
            duration == best[0] and abs(midpoint - nominal_ms) < abs(best[1] - nominal_ms)
        ):
            best = (duration, midpoint)

    if best is not None:
        return best[1]

    # No silence in the window. A region edge inside it is the next best thing:
    # still a point no word crosses.
    edges = [
        edge
        for region in regions
        for edge in (region.start_ms, region.end_ms)
        if window_start <= edge <= window_end and floor_ms < edge < ceiling_ms
    ]
    if edges:
        return min(edges, key=lambda edge: abs(edge - nominal_ms))

    # Wall-to-wall speech across the whole window: no boundary avoids a word, so
    # take the nominal one and let the caller report it.
    return nominal_ms


def boundary_never_splits_speech(
    plan: tuple[ChunkPlanEntry, ...], regions: tuple[SpeechRegion, ...]
) -> bool:
    """True when no internal chunk boundary falls strictly inside a speech region.

    Exported because it is the property the planner exists to guarantee, and both
    the unit test and the transcribe processor's assertion read it from here.
    """
    internal = {entry.start_ms for entry in plan[1:]}
    return not any(region.contains(edge) for edge in internal for region in regions)
