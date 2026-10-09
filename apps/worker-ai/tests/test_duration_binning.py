"""Unit and integration tests for Target Duration Customization & Intelligent Binning (Pillar 2 §05)."""

from __future__ import annotations

from typing import Any

import pytest

from worker_ai.highlights import (
    DISALLOWED_CLOSINGS,
    DURATION_BINS_MS,
    HighlightsOptions,
    Window,
    Word,
    build_units,
    enumerate_windows,
    filter_windows_by_duration,
    padded_windows,
    snap_windows,
    words_to_silence_gaps,
)
from worker_ai.processors.highlights import discover


def _make_long_transcript_words(total_duration_ms: int = 240_000) -> list[dict[str, Any]]:
    """Generates a realistic multi-minute transcript with clean sentences every ~5 seconds."""
    sentences = [
        "Welcome back to our deep dive on modern software architecture and distributed systems.",
        "Today we are exploring how creator platforms optimize video duration for maximum retention.",
        "TikTok Creator Rewards requires every single video to exceed sixty seconds for monetization.",
        "On the other hand Instagram Reels rewards short punchy loops under thirty seconds.",
        "YouTube Shorts achieves the highest completion rates between thirty and fifty seconds.",
        "LinkedIn and X video audiences prefer ninety second to three minute analytical breakdowns.",
        "When we group syntactic sentence units using semantic knapsack combinatorics everything aligns.",
        "Zero clips are ever cut prematurely in the middle of an incomplete thought or clause.",
        "Every single candidate window strictly respects the minimum and maximum duration boundaries.",
        "Acoustic pause snapping adjusts timestamps to silence midpoints without violating user bounds.",
    ]
    raw_words: list[dict[str, Any]] = []
    cursor_ms = 500
    wid_counter = 1
    sentence_idx = 0

    while cursor_ms < total_duration_ms:
        sentence = sentences[sentence_idx % len(sentences)]
        tokens = sentence.split()
        for token in tokens:
            start_ms = cursor_ms
            end_ms = start_ms + 320
            raw_words.append(
                {
                    "wid": f"w-{wid_counter:05d}",
                    "text": token,
                    "startMs": start_ms,
                    "endMs": end_ms,
                }
            )
            wid_counter += 1
            cursor_ms = end_ms + 80
        # Add an acoustic pause (silence gap) of 800ms between sentences
        cursor_ms += 800
        sentence_idx += 1

    return raw_words


def _to_words(raw_words: list[dict[str, Any]]) -> list[Word]:
    return [
        Word(
            wid=item["wid"],
            text=item["text"],
            start_ms=item["startMs"],
            end_ms=item["endMs"],
        )
        for item in raw_words
    ]


@pytest.mark.parametrize(
    ("bin_name", "expected_min_ms", "expected_max_ms"),
    [
        ("UNDER_30", 15_000, 30_000),
        ("BETWEEN_30_60", 30_000, 60_000),
        ("BETWEEN_60_90", 60_000, 90_000),
        ("BETWEEN_90_180", 90_000, 180_000),
        ("AUTO", 20_000, 90_000),
    ],
)
def test_preset_duration_bins_strict_window_compliance(
    bin_name: str, expected_min_ms: int, expected_max_ms: int
) -> None:
    """Verifies 100.0% of generated windows satisfy the target duration bin bounds."""
    assert DURATION_BINS_MS[bin_name] == (expected_min_ms, expected_max_ms)

    raw_words = _make_long_transcript_words(240_000)
    words = _to_words(raw_words)
    silences = words_to_silence_gaps(words, duration_ms=245_000)

    units = build_units(words, min_ms=expected_min_ms, max_ms=expected_max_ms)
    windows = enumerate_windows(
        units,
        min_ms=expected_min_ms,
        max_ms=expected_max_ms,
        silences=silences,
        words=words,
    )

    assert len(windows) > 0, f"Expected candidate windows for bin {bin_name}"
    for w in windows:
        duration = w.end_ms - w.start_ms
        assert expected_min_ms <= duration <= expected_max_ms, (
            f"Window {w.window_id} duration {duration}ms violated {bin_name} "
            f"[{expected_min_ms}, {expected_max_ms}]"
        )
        # Semantic integrity check: last word must not be a hanging conjunction
        last_word = words[w.last].text.lower().rstrip(".,!?")
        assert last_word not in DISALLOWED_CLOSINGS


def test_custom_duration_range_45s_to_75s_compliance() -> None:
    """Verifies custom duration range (e.g. 45s-75s) strictly bounds all proposals."""
    min_ms = 45_000
    max_ms = 75_000
    raw_words = _make_long_transcript_words(240_000)
    words = _to_words(raw_words)
    silences = words_to_silence_gaps(words, duration_ms=245_000)

    opts = HighlightsOptions(
        count=5,
        minDurationMs=min_ms,
        maxDurationMs=max_ms,
        contentGoal="reach",
        language="en",
    )
    proposals, considered = discover(raw_words, opts, duration_ms=245_000, silences=silences)

    assert considered > 0
    assert len(proposals) > 0
    for proposal in proposals:
        duration_ms = proposal.end_ms - proposal.start_ms
        assert min_ms <= duration_ms <= max_ms, (
            f"Proposal {proposal.window_id} duration {duration_ms}ms outside [45000, 75000]"
        )


def test_tiktok_monetization_bin_60s_to_90s_proposals() -> None:
    """Verifies TikTok Creator Rewards bin (60s-90s) produces exclusively >= 60s clips."""
    min_ms, max_ms = DURATION_BINS_MS["BETWEEN_60_90"]
    raw_words = _make_long_transcript_words(240_000)
    words = _to_words(raw_words)
    silences = words_to_silence_gaps(words, duration_ms=245_000)

    opts = HighlightsOptions(
        count=5,
        minDurationMs=min_ms,
        maxDurationMs=max_ms,
        contentGoal="reach",
        language="en",
    )
    proposals, _ = discover(raw_words, opts, duration_ms=245_000, silences=silences)

    assert len(proposals) > 0
    for proposal in proposals:
        duration_ms = proposal.end_ms - proposal.start_ms
        assert 60_000 <= duration_ms <= 90_000


def test_filter_and_snap_windows_discard_out_of_bounds_candidates() -> None:
    """Verifies that windows falling outside [min_ms, max_ms] after snapping are discarded."""
    w_too_short = Window(window_id="w-1", first=0, last=2, start_ms=1_000, end_ms=14_500)
    w_valid = Window(window_id="w-2", first=0, last=5, start_ms=1_000, end_ms=25_000)
    w_too_long = Window(window_id="w-3", first=0, last=10, start_ms=1_000, end_ms=31_500)

    filtered = filter_windows_by_duration(
        [w_too_short, w_valid, w_too_long],
        min_ms=15_000,
        max_ms=30_000,
    )
    assert [w.window_id for w in filtered] == ["w-2"]

    snapped = snap_windows(
        [w_too_short, w_valid, w_too_long],
        silences=[(800, 1200), (24_800, 25_200)],
        min_ms=15_000,
        max_ms=30_000,
    )
    assert len(snapped) == 1
    assert snapped[0].window_id == "w-2"
    assert 15_000 <= (snapped[0].end_ms - snapped[0].start_ms) <= 30_000


def test_padded_windows_strict_bounds_enforcement() -> None:
    """Verifies padded_windows never returns a window outside [min_ms, max_ms]."""
    raw_words = _make_long_transcript_words(25_000)
    words = _to_words(raw_words[:25])  # ~12 seconds of speech
    units = build_units(words, min_ms=15_000, max_ms=30_000)
    silences = words_to_silence_gaps(words, duration_ms=30_000)

    padded = padded_windows(
        units,
        min_ms=15_000,
        max_ms=30_000,
        timeline_end_ms=30_000,
        silences=silences,
        words=words,
    )
    for w in padded:
        assert 15_000 <= (w.end_ms - w.start_ms) <= 30_000

