"""Tests for B-roll Semantic Query Generator & Pacing Engine (Pillar 6 §01)."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from .fake_llm import FakeLlm
from worker_ai.processors.broll_pass import (
    BROLL_MAX_DURATION_SEC,
    BROLL_MIN_DURATION_SEC,
    BROLL_MIN_GAP_SEC,
    BrollCueEvent,
    enforce_broll_pacing,
    generate_broll_cues,
    generate_heuristic_broll_cues,
)


def test_enforce_broll_pacing_hook_and_duration_clamping():
    raw_cues = [
        # In the hook: should be clamped or moved to >= 2.5s
        BrollCueEvent(start_sec=1.0, end_sec=2.0, context_phrase="hook start", search_query="intro", score=8.0),
        # Too short duration (1.0s): should be clamped to MIN (2.5s)
        BrollCueEvent(start_sec=15.0, end_sec=16.0, context_phrase="quick idea", search_query="idea", score=7.0),
        # Too long duration (6.0s): should be clamped to MAX (4.0s)
        BrollCueEvent(start_sec=30.0, end_sec=36.0, context_phrase="long topic", search_query="topic", score=9.0),
    ]

    paced = enforce_broll_pacing(raw_cues, total_duration_sec=60.0)

    for cue in paced:
        assert cue.start_sec >= 2.5, "No cue should start before hook avoidance threshold"
        duration = cue.end_sec - cue.start_sec
        assert BROLL_MIN_DURATION_SEC <= duration <= BROLL_MAX_DURATION_SEC, f"Duration {duration} out of bounds"


def test_enforce_broll_pacing_minimum_gap_and_pacing():
    raw_cues = [
        BrollCueEvent(start_sec=5.0, end_sec=8.0, context_phrase="ad spend", search_query="dashboard", score=9.0),
        # Crowded cue only 3 seconds after: should be dropped in favor of higher score
        BrollCueEvent(start_sec=8.0, end_sec=11.0, context_phrase="crowded cue", search_query="crowded", score=6.0),
        # Valid spaced cue (20s): should be retained
        BrollCueEvent(start_sec=20.0, end_sec=23.0, context_phrase="real estate", search_query="drone", score=8.5),
        # Valid spaced cue (35s): should be retained
        BrollCueEvent(start_sec=35.0, end_sec=38.0, context_phrase="rocket launch", search_query="space", score=9.2),
    ]

    paced = enforce_broll_pacing(raw_cues, total_duration_sec=60.0, min_gap_sec=10.0)

    assert len(paced) == 3
    starts = [c.start_sec for c in paced]
    assert starts == [5.0, 20.0, 35.0]

    for i in range(len(paced) - 1):
        gap = paced[i + 1].start_sec - paced[i].start_sec
        assert gap >= BROLL_MIN_GAP_SEC, f"Gap {gap} between cues violates minimum pacing of {BROLL_MIN_GAP_SEC}s"


def test_generate_heuristic_broll_cues_from_transcript_concepts():
    sentences = [
        {"startSec": 0.0, "endSec": 2.2, "text": "Welcome back to the channel everyone."},
        {"startSec": 4.5, "endSec": 7.8, "text": "Last quarter we spent $50,000 on Facebook ads to scale."},
        {"startSec": 18.0, "endSec": 21.5, "text": "Meanwhile the luxury real estate market completely collapsed."},
        {"startSec": 32.0, "endSec": 35.5, "text": "We built a rocket that could reach Mars in record time."},
    ]

    cues = generate_heuristic_broll_cues(sentences, total_duration_sec=60.0)

    assert len(cues) >= 2
    queries = " ".join(c.search_query.lower() for c in cues)
    assert "ad spend" in queries or "dashboard" in queries
    assert "real estate" in queries or "drone" in queries
    assert "rocket" in queries or "space" in queries


@pytest.mark.asyncio
async def test_generate_broll_cues_with_llm_chain():
    sentences = [
        {"startSec": 5.0, "endSec": 9.0, "text": "We invested heavily in stock market trading charts."},
        {"startSec": 22.0, "endSec": 25.0, "text": "Artificial intelligence algorithms took over everything."},
    ]

    fake_llm = FakeLlm(
        lambda req: {
            "broll_cues": [
                {
                    "start_sec": 5.2,
                    "end_sec": 8.5,
                    "context_phrase": "stock market trading",
                    "search_query": "stock market chart green candles 4k",
                    "score": 9.0,
                },
                {
                    "start_sec": 22.1,
                    "end_sec": 25.3,
                    "context_phrase": "artificial intelligence",
                    "search_query": "ai neural network glowing 4k",
                    "score": 8.8,
                },
            ]
        }
    )

    cues = await generate_broll_cues(
        sentences,
        total_duration_sec=60.0,
        chain=[fake_llm],
    )

    assert len(cues) == 2
    assert "stock market" in cues[0].search_query
    assert "ai" in cues[1].search_query.lower() or "neural" in cues[1].search_query.lower()
