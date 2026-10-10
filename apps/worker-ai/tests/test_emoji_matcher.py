"""Tests for Contextual Auto-Emoji Matcher (Pillar 4 §04).

Verifies:
- Accurate semantic tags for "millionaire", "fired", "exploded", "crying"
- Morphological inflections and punctuation cleaning
- Pacing throttle constraint (10 consecutive emotional words throttled to >= 2.8s gap)
- Performance SLA (60-second clip / 500 words in < 80ms)
"""

from __future__ import annotations

import time

from worker_ai.passes.emoji_matcher import (
    MatchedEmoji,
    match_transcript_emojis,
    match_word_emoji,
    stem_word,
)
from worker_ai.passes.text_fx import Word


def test_emoji_matcher_verifies_required_tags() -> None:
    """Verifies correct emoji and 3D vector asset mapping for the required terms:

    'millionaire', 'fired', 'exploded', 'crying'.
    """
    millionaire = match_word_emoji("millionaire")
    assert millionaire is not None
    entry_id, emoji_char, asset_svg, category = millionaire
    assert emoji_char == "💸"
    assert asset_svg == "3d-money-wings.svg"
    assert category == "finance"

    fired = match_word_emoji("fired")
    assert fired is not None
    entry_id, emoji_char, asset_svg, category = fired
    assert emoji_char == "🔥"
    assert asset_svg == "3d-fire.svg"
    assert category == "hype"

    exploded = match_word_emoji("exploded")
    assert exploded is not None
    entry_id, emoji_char, asset_svg, category = exploded
    assert emoji_char == "🚀"
    assert asset_svg == "3d-rocket.svg"
    assert category == "growth"

    crying = match_word_emoji("crying")
    assert crying is not None
    entry_id, emoji_char, asset_svg, category = crying
    assert emoji_char == "😭"
    assert asset_svg == "3d-crying.svg"
    assert category == "emotion"


def test_emoji_matcher_core_synsets() -> None:
    """Tests additional core short-form terms."""
    assert match_word_emoji("revenue")[1] == "💸"
    assert match_word_emoji("growth")[1] == "📈"
    assert match_word_emoji("mindblown")[1] == "🤯"
    assert match_word_emoji("died")[1] == "💀"
    assert match_word_emoji("warning")[1] == "⚠️"
    assert match_word_emoji("stop")[1] == "🛑"
    assert match_word_emoji("love")[1] == "❤️"
    assert match_word_emoji("trophy")[1] == "🏆"
    assert match_word_emoji("winner")[1] == "🏆"
    assert match_word_emoji("muscle")[1] == "💪"
    assert match_word_emoji("crown")[1] == "👑"


def test_stem_word_handles_inflections() -> None:
    assert "fire" in stem_word("fired")
    assert "cry" in stem_word("crying")
    assert "scale" in stem_word("scaling")
    assert "investment" in stem_word("investments")


def test_pacing_throttle_ten_consecutive_words() -> None:
    """Verifies that 10 consecutive emotional words spaced closely (500ms apart)

    only generate emojis according to the throttle rule (>= 2.8s spacing).
    """
    consecutive_words = [
        Word(wid="0:0", s=0, e=450, t="money"),
        Word(wid="0:1", s=500, e=950, t="fire"),
        Word(wid="0:2", s=1000, e=1450, t="rocket"),
        Word(wid="0:3", s=1500, e=1950, t="crying"),
        Word(wid="0:4", s=2000, e=2450, t="growth"),
        Word(wid="0:5", s=2500, e=2950, t="insane"),
        Word(wid="0:6", s=3000, e=3450, t="profit"),
        Word(wid="0:7", s=3500, e=3950, t="exploded"),
        Word(wid="0:8", s=4000, e=4450, t="dead"),
        Word(wid="0:9", s=4500, e=4950, t="target"),
    ]

    matched = match_transcript_emojis(consecutive_words, min_gap_ms=2800, window_ms=3000)

    # Word 0 at 0ms is accepted.
    # Words 1..5 (500ms..2500ms) are < 2800ms gap, so dropped.
    # Word 6 ("profit") at 3000ms is >= 2800ms from 0ms, so accepted.
    # Words 7..9 (3500ms..4500ms) are < 3000 + 2800 = 5800ms, so dropped.
    assert len(matched) == 2
    assert matched[0].text == "money"
    assert matched[0].start_ms == 0
    assert matched[1].text == "profit"
    assert matched[1].start_ms == 3000


def test_performance_sla_60_second_clip() -> None:
    """SLA: Emoji mapping speed <= 80ms for a 60-second clip transcript."""
    vocabulary = [
        "the", "quick", "brown", "fox", "made", "millions", "revenue",
        "and", "fired", "the", "rocket", "towards", "growth",
    ]
    words = [
        Word(wid=f"0:{i}", s=i * 200, e=i * 200 + 180, t=vocabulary[i % len(vocabulary)])
        for i in range(500)
    ]

    start = time.perf_counter()
    matched = match_transcript_emojis(words, min_gap_ms=2800)
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert elapsed_ms < 80.0  # Must be well under 80ms SLA
    assert len(matched) > 0
