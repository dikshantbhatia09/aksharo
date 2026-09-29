"""``ai.highlights`` never proposes a moment from a part the person skipped.

Steering (2026-09-29): the start form's "skip the first / last N minutes"
reaches the worker as ``options.excludeRanges`` on the transcript's own clock.
A window that overlaps one is dropped as it is enumerated - before scoring, so
a skipped intro cannot win on its hook, and a padded window is still looked for
when every sentence window falls inside what was skipped.
"""

from __future__ import annotations

from worker_ai.highlights.contracts import ExcludeRange
from worker_ai.highlights.windows import (
    Window,
    build_units,
    enumerate_windows,
    outside,
    padded_windows,
    usable_words,
)
from worker_ai.processors.highlights import discover

from .test_highlights import (
    MINUTE,
    STRONG_AT_12,
    STRONG_AT_16,
    discover_in,
    options,
    talk,
    talk_with_moments,
)


def span(start_ms: int, end_ms: int) -> ExcludeRange:
    return ExcludeRange.model_validate({"startMs": start_ms, "endMs": end_ms})


def window(start_ms: int, end_ms: int, window_id: str = "w-00001") -> Window:
    return Window(window_id=window_id, first=0, last=0, start_ms=start_ms, end_ms=end_ms)


def overlaps(proposal: dict[str, int], ranges: list[tuple[int, int]]) -> bool:
    return any(proposal["startMs"] < end and start < proposal["endMs"] for start, end in ranges)


def test_a_window_touching_a_skipped_range_is_kept_and_one_inside_it_is_not() -> None:
    windows = [
        window(0, 10_000, "w-00001"),
        window(10_000, 25_000, "w-00002"),
        window(24_000, 40_000, "w-00003"),
        window(60_000, 90_000, "w-00004"),
    ]
    kept = outside(windows, [span(0, 10_000), span(30_000, 40_000)])
    # Ids are the ones enumerated: a proposal still names its window.
    assert [w.window_id for w in kept] == ["w-00002", "w-00004"]
    assert outside(windows, None) == windows
    assert outside(windows, []) == windows


def test_enumerated_windows_skip_the_excluded_start() -> None:
    words = usable_words(talk_with_moments(6 * MINUTE, {}))
    units = build_units(words, min_ms=15_000, max_ms=60_000)
    every = enumerate_windows(units, min_ms=15_000, max_ms=60_000)
    kept = enumerate_windows(units, min_ms=15_000, max_ms=60_000, exclude=[span(0, 2 * MINUTE)])
    assert kept
    assert len(kept) < len(every)
    assert all(w.start_ms >= 2 * MINUTE for w in kept)


def test_a_padded_window_is_not_cut_into_a_skipped_range() -> None:
    # Speech in short islands far apart: no sentence window fits 15-60 s.
    islands = [
        *talk(["one two three four five six seven eight."], start_ms=0),
        *talk(["nine ten eleven twelve thirteen fourteen."], start_ms=40_000),
        *talk(["fifteen sixteen seventeen eighteen nineteen."], start_ms=80_000),
    ]
    words = usable_words(islands)
    units = build_units(words, min_ms=15_000, max_ms=60_000)
    padded = padded_windows(units, min_ms=15_000, max_ms=60_000, timeline_end_ms=120_000)
    assert padded
    kept = padded_windows(
        units,
        min_ms=15_000,
        max_ms=60_000,
        timeline_end_ms=120_000,
        exclude=[span(0, 30_000)],
    )
    assert all(w.start_ms >= 30_000 for w in kept)
    assert len(kept) < len(padded)


def test_no_proposal_comes_from_a_skipped_intro_or_outro() -> None:
    raw = talk_with_moments(20 * MINUTE, {MINUTE: STRONG_AT_12, 17 * MINUTE: STRONG_AT_16})
    ranges = [(0, 3 * MINUTE), (16 * MINUTE, 20 * MINUTE)]

    unsteered, _ = discover(raw, options(count=5))
    # Without the skips, the strong moments at the edges are proposed.
    assert any(overlaps(p.model_dump(by_alias=True), ranges) for p in unsteered)

    steered, considered = discover(
        raw,
        options(
            count=5,
            excludeRanges=[{"startMs": start, "endMs": end} for start, end in ranges],
        ),
    )
    assert steered
    assert considered > 0
    assert not any(overlaps(p.model_dump(by_alias=True), ranges) for p in steered)


def test_skipping_the_whole_video_is_an_empty_answer_not_an_error() -> None:
    raw = talk_with_moments(5 * MINUTE, {})
    proposals, considered = discover(
        raw, options(excludeRanges=[{"startMs": 0, "endMs": 5 * MINUTE + 1}])
    )
    assert proposals == []
    assert considered == 0


async def test_the_ranges_travel_from_the_payload_as_the_api_sends_them() -> None:
    raw = talk_with_moments(12 * MINUTE, {MINUTE: STRONG_AT_12, 9 * MINUTE: STRONG_AT_16})
    result = await discover_in(raw, excludeRanges=[{"startMs": 0, "endMs": 4 * MINUTE}])
    assert result["proposals"]
    assert all(p["startMs"] >= 4 * MINUTE for p in result["proposals"])
