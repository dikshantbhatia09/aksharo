"""Tests for Cross-Lingual Word Timing Allocator (Pillar 4 §09, Step 4).

Verifies that:
1. Total translated sentence duration strictly matches original sentence duration.
2. Word timings are monotonically increasing and non-overlapping.
3. Sentence terminals (. ? !) receive duration bonus for natural spoken pause cadence.
4. Edge cases (single token, empty string, zero duration, inverted bounds) are handled safely.
5. `translate_segments` integration populates `words` when timing is provided.
"""

from __future__ import annotations

import pytest

from worker_ai.translate.timing import (
    CrossLingualWordTiming,
    allocate_cross_lingual_timing_ms,
    allocate_cross_lingual_timing_sec,
    compute_word_weight,
)
from worker_ai.translate.service import (
    translate_segments,
    TranslateSegmentsResult,
)
from worker_ai.translate.providers.base import (
    TranslationProvider,
    TranslationRequest,
    TranslationResult,
    TranslatedSegment,
)


def test_word_weight_punctuation_bonuses():
    # Regular word
    w_hello = compute_word_weight("hello")
    assert w_hello == 5.0

    # Sentence terminal (. ? ! ।)
    w_sentence_end = compute_word_weight("hello.")
    assert w_sentence_end == 5.0 + 2.0

    # Clause pause (, ; :)
    w_clause_pause = compute_word_weight("hello,")
    assert w_clause_pause == 5.0 + 1.0


def test_timing_allocator_total_duration_strict_match():
    start_ms = 1200
    end_ms = 4750
    text = "Never give up on your biggest dreams, they are closer than you think!"

    words = allocate_cross_lingual_timing_ms(text, start_ms, end_ms)

    assert len(words) > 0
    # First word starts at start_ms
    assert words[0].start_ms == start_ms
    # Last word ends strictly at end_ms
    assert words[-1].end_ms == end_ms
    # Total duration strictly equals original duration
    assert words[-1].end_ms - words[0].start_ms == end_ms - start_ms

    # Check monotonicity and valid bounds
    for i in range(len(words)):
        w = words[i]
        assert w.start_ms <= w.end_ms
        if i > 0:
            assert w.start_ms >= words[i - 1].end_ms


def test_timing_allocator_second_resolution():
    start_sec = 0.5
    end_sec = 2.8
    text = "Bonjour le monde merveilleux."

    words = allocate_cross_lingual_timing_sec(text, start_sec, end_sec)

    assert len(words) == 4
    assert words[0].start_ms == 500
    assert words[-1].end_ms == 2800
    assert round(words[-1].end_sec, 2) == 2.8


def test_timing_allocator_single_token():
    start_ms = 100
    end_ms = 900
    text = "Action!"

    words = allocate_cross_lingual_timing_ms(text, start_ms, end_ms)

    assert len(words) == 1
    assert words[0].text == "Action!"
    assert words[0].start_ms == 100
    assert words[0].end_ms == 900


def test_timing_allocator_empty_and_zero_duration():
    # Empty text
    assert allocate_cross_lingual_timing_ms("", 100, 500) == []
    assert allocate_cross_lingual_timing_ms("   ", 100, 500) == []

    # Zero duration
    words = allocate_cross_lingual_timing_ms("Quick test", 100, 100)
    assert len(words) == 2
    assert words[0].start_ms == 100
    assert words[0].end_ms == 100
    assert words[1].start_ms == 100
    assert words[1].end_ms == 100

    # Inverted bounds
    words = allocate_cross_lingual_timing_ms("Quick test", 500, 100)
    assert len(words) == 2
    assert words[0].start_ms == 500
    assert words[0].end_ms == 500


class DummyProvider(TranslationProvider):
    name = "dummy"

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        return TranslationResult(
            segments=tuple(
                TranslatedSegment(
                    segment_id=s.segment_id,
                    text=f"Translated: {s.text}",
                )
                for s in request.segments
            )
        )


@pytest.mark.asyncio
async def test_translate_segments_with_timing_allocator():
    provider = DummyProvider()
    segments = (
        ("seg-1", "नमस्ते दुनिया"),
        ("seg-2", "यह एक परीक्षण है"),
    )
    timing = {
        "seg-1": (0, 1500),
        "seg-2": (1600, 3200),
    }

    result = await translate_segments(
        (provider,),
        segments=segments,
        source_language="hi",
        target_language="en",
        timing=timing,
    )

    assert len(result.segments) == 2
    seg1 = result.segments[0]
    assert seg1.segment_id == "seg-1"
    assert len(seg1.words) > 0
    assert seg1.words[0].start_ms == 0
    assert seg1.words[-1].end_ms == 1500
    assert seg1.words[-1].end_ms - seg1.words[0].start_ms == 1500

    seg2 = result.segments[1]
    assert seg2.segment_id == "seg-2"
    assert len(seg2.words) > 0
    assert seg2.words[0].start_ms == 1600
    assert seg2.words[-1].end_ms == 3200

