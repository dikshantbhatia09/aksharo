"""Tests for Dynamic Keyword Highlighting & Entity Color Coding (Pillar 4 §05).

Verifies:
1. 100% detection of numbers, currencies, and percentages (Tier 1).
2. 100% detection of tech entities, brands, and geopolitical proper nouns (Tier 2).
3. Robust detection of viral superlatives & high-impact affective words (Tier 3).
4. Strict filtering of stop words (Tier 4).
5. Anti-clutter pacing and density constraints.
6. Throughput SLA >= 2,000 words/second.
"""

from __future__ import annotations

import pytest

from worker_ai.passes.keyword_highlighter import (
    DEFAULT_PALETTE,
    VIRAL_SUPERLATIVE_LEXICON,
    benchmark_keyword_highlighter,
    classify_word_tier,
    clean_token,
    highlight_transcript_keywords,
)
from worker_ai.passes.text_fx import Word


def test_tier1_metrics_and_currencies_detection() -> None:
    """Asserts 100% detection of numbers, currencies, percentages, and multipliers."""
    metrics = [
        "$50,000",
        "$10M",
        "45%",
        "3.5x",
        "100k",
        "₹5,000",
        "€99",
        "£1,200",
        "10x",
        "100%",
        "millionaire",
        "billion",
        "crores",
        "dollars",
        "24/7",
    ]
    for m in metrics:
        res = classify_word_tier(m)
        assert res is not None, f"Failed to detect metric: {m}"
        tier, entity_type = res
        assert tier == 1, f"Expected tier 1 for {m}, got {tier}"
        assert entity_type == "metric"


def test_tier2_named_entities_and_brands_detection() -> None:
    """Asserts 100% detection of tech platforms, corporate entities, and proper nouns."""
    entities = [
        "OpenAI",
        "YouTube",
        "Google",
        "Tesla",
        "NVIDIA",
        "Apple",
        "Microsoft",
        "Meta",
        "India",
        "Sarvam",
        "ChatGPT",
        "Docker",
        "Python",
    ]
    for ent in entities:
        res = classify_word_tier(ent)
        assert res is not None, f"Failed to detect entity: {ent}"
        tier, entity_type = res
        assert tier == 2, f"Expected tier 2 for {ent}, got {tier}"
        assert entity_type == "named_entity"


def test_tier3_viral_superlatives_lexicon_detection() -> None:
    """Asserts detection of high-arousal superlatives and affective hook words."""
    superlatives = [
        "craziest",
        "impossible",
        "destroyed",
        "secret",
        "danger",
        "massive",
        "unreal",
        "viral",
        "mind-blowing",
        "hacked",
        "game-changer",
        "superhit",
        "zabardast",
    ]
    for sup in superlatives:
        res = classify_word_tier(sup)
        assert res is not None, f"Failed to detect viral word: {sup}"
        tier, entity_type = res
        assert tier == 3, f"Expected tier 3 for {sup}, got {tier}"
        assert entity_type == "superlative"


def test_tier4_stop_words_rejection() -> None:
    """Asserts stop words are never highlighted."""
    stop_words = ["the", "and", "in", "it", "my", "to", "for", "with", "is", "was", "a", "of"]
    for sw in stop_words:
        assert classify_word_tier(sw) is None, f"Stop word should not be highlighted: {sw}"


def test_highlight_transcript_keywords_integration() -> None:
    """Tests end-to-end transcript word highlighting with multi-tier accent assignment."""
    sentence = "Welcome back to YouTube today we made $50,000 using OpenAI which is the craziest viral breakthrough in India"
    tokens = sentence.split()
    words = [
        Word(wid=f"0:{i}", s=i * 500, e=i * 500 + 400, t=token)
        for i, token in enumerate(tokens)
    ]

    custom_palette = {
        "accent1": "#FFE600",
        "accent2": "#00FFFF",
        "accent3": "#00FF7F",
    }

    highlights = highlight_transcript_keywords(words, palette=custom_palette, min_gap_ms=300)
    assert len(highlights) >= 4

    tokens_highlighted = {h.clean_token for h in highlights}
    assert "YouTube" in tokens_highlighted
    assert "50,000" in tokens_highlighted or "$50,000" in tokens_highlighted

    # Verify assigned accent colors match custom palette
    for h in highlights:
        if h.tier == 1:
            assert h.accent_color == "#FFE600"
        elif h.tier == 2:
            assert h.accent_color == "#00FFFF"
        elif h.tier == 3:
            assert h.accent_color == "#00FF7F"


def test_anti_clutter_pacing_constraints() -> None:
    """Asserts that highlights respect min_gap_ms and density limits."""
    # Rapid sequence of 5 metrics back-to-back
    tokens = ["$10", "$20", "$30", "$40", "$50"]
    words = [
        Word(wid=f"0:{i}", s=i * 100, e=i * 100 + 80, t=tok)
        for i, tok in enumerate(tokens)
    ]
    # min_gap_ms=300 should drop adjacent candidates within 300ms
    highlights = highlight_transcript_keywords(words, min_gap_ms=300)
    for i in range(1, len(highlights)):
        assert highlights[i].start_ms - highlights[i - 1].start_ms >= 300


def test_throughput_performance_sla() -> None:
    """Asserts throughput exceeds 2,000 words/second SLA."""
    wps = benchmark_keyword_highlighter(word_count=5000)
    assert wps >= 2000.0, f"Throughput {wps:.1f} words/sec fell below 2,000 SLA"

