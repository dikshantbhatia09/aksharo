"""Beat-aligned music bed starts (D05 follow-up, brief §1): snapping a music
item's `start_ms` to the nearest beat of the section's own BPM target, so a
bed's entry lands on-beat rather than a millisecond off.

Mirrors `packages/timemap/src/beats.ts`'s `alignCutBoundariesToBeats`
exactly (same tolerance constant, same "nearest beat within tolerance, never
inside a protected range, otherwise leave alone" rule) so the two grids never
disagree — this module is the Python side of that same algorithm, needed
because the worker has no dependency on the TS package. Pure and
deterministic: no network, no database, no queue.
"""

from __future__ import annotations

__all__ = ["DEFAULT_BEAT_SNAP_TOLERANCE_MS", "nearest_beat_ms", "snap_start_to_beat"]

#: Matches `DEFAULT_BEAT_SNAP_TOLERANCE_MS` in `packages/timemap/src/beats.ts`
#: (brief §3): a boundary snaps only if the nearest beat is within ±120 ms.
DEFAULT_BEAT_SNAP_TOLERANCE_MS = 120


def nearest_beat_ms(ms: int, bpm: int, anchor_ms: int = 0) -> int:
    """The nearest beat-grid instant to `ms`, for a grid at `bpm` phased by
    `anchor_ms`. Mirrors `beats.ts`'s `nearestBeatMs`."""
    interval_ms = 60_000 / bpm
    beat_index = round((ms - anchor_ms) / interval_ms)
    return round(anchor_ms + beat_index * interval_ms)


def _inside_any_range(ms: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start < ms < end for start, end in ranges)


def snap_start_to_beat(
    start_ms: int,
    *,
    bpm: int | None,
    protected_ranges: list[tuple[int, int]] | None = None,
    tolerance_ms: int = DEFAULT_BEAT_SNAP_TOLERANCE_MS,
    anchor_ms: int = 0,
) -> int:
    """Snaps `start_ms` to the nearest beat of `bpm`, within `tolerance_ms`
    and never landing inside a protected range. Returns `start_ms` unchanged
    when `bpm` is `None`/non-positive, the nearest beat is already
    `start_ms`, the nearest beat exceeds the tolerance, or the nearest beat
    would land inside a protected range — the same "leave it alone rather
    than snap to a worse beat" rule `alignCutBoundariesToBeats` follows."""
    if bpm is None or bpm <= 0:
        return start_ms
    protected_ranges = protected_ranges or []
    snapped = nearest_beat_ms(start_ms, bpm, anchor_ms)
    if snapped == start_ms:
        return start_ms
    if abs(snapped - start_ms) > tolerance_ms:
        return start_ms
    if _inside_any_range(snapped, protected_ranges):
        return start_ms
    return snapped
