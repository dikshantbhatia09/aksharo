"""Automated test suite for Multi-Modal AI Virality Scoring Engine (0-100).

Tests:
1. Universal virality formula bounds and component score distributions:
   - S_hook in [0, 30]
   - S_narrative in [0, 25]
   - S_energy in [0, 20]
   - S_trend in [0, 15]
   - S_pacing in [0, 10]
   - Total in [0, 100]
2. Viral short vs flat corporate monologue delta >= 35 points.
3. 3.5-second opening hook window isolator:
   - Curiosity gap detection
   - Contrarian opening assertion
   - Filler opening penalty ("So basically", "Um, yeah")
4. Narrative arc & completeness:
   - Clean sentence boundaries without trailing conjunctions
   - Trailing conjunction penalty ("and so...", "but anyway...")
5. Acoustic energy integration:
   - Pitch variance (Delta F0), volume dynamics, laughter probability, energy peaks
6. Topical & Trend keywords density:
   - Viral entity keywords (AI, money, productivity, controversy)
7. Speech cadence & pacing:
   - Optimal 150-190 WPM vs slow or rushed speech
   - Micro-pauses > 1.0s penalty
8. Tier badge thresholds:
   - VIRAL_GOLD >= 85
   - HIGH_POTENTIAL >= 70
   - MODERATE >= 50
   - STANDARD < 50
9. Deterministic scoring regression test.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np
import pytest

from worker_ai.highlights.acoustic import AcousticFeatures, analyze_pcm_window
from worker_ai.highlights.contracts import HighlightProposal
from worker_ai.highlights.scoring import (
    HOOK_WINDOW_MS,
    ViralityBreakdown,
    WindowSignals,
    WordFeatures,
    score,
    virality_index,
    virality_tier,
)
from worker_ai.highlights.windows import Word, build_units


def make_words_from_text(text: str, wpm: float = 160.0, start_offset_ms: int = 0) -> list[Word]:
    """Helper to generate Word objects with realistic timestamps matching a target WPM."""
    tokens = text.split()
    ms_per_word = int(round(60_000.0 / wpm))
    words: list[Word] = []
    clock = start_offset_ms
    for i, token in enumerate(tokens):
        duration = max(80, int(ms_per_word * 0.85))
        words.append(Word(wid=f"w{i}", text=token, start_ms=clock, end_ms=clock + duration))
        clock += ms_per_word
    return words


def get_signals(features: WordFeatures, words: list[Word]) -> WindowSignals:
    return features.signals(0, len(words) - 1, words[0].start_ms, words[-1].end_ms)



def test_virality_component_bounds_and_clamping() -> None:
    """All 5 component pillars must strictly remain within their mathematical domains."""
    # Viral text with rich hooks, trends, pacing, etc.
    text = (
        "Did you know the biggest secret about artificial intelligence? "
        "Most people never realize how OpenAI and ChatGPT will automate million dollar companies. "
        "Stop making this dangerous mistake today!"
    )
    words = make_words_from_text(text, wpm=165.0)
    features = WordFeatures(words, build_units(words, min_ms=10_000, max_ms=60_000))
    signals = get_signals(features, words)
    
    acoustic = AcousticFeatures(
        pitch_variance=0.85,
        volume_dynamics=0.80,
        laughter_probability=0.20,
        energy_peaks=0.90,
    )
    
    breakdown = virality_index(signals, acoustic=acoustic)
    
    assert 0.0 <= breakdown.hook <= 30.0
    assert 0.0 <= breakdown.narrative <= 25.0
    assert 0.0 <= breakdown.energy <= 20.0
    assert 0.0 <= breakdown.trend <= 15.0
    assert 0.0 <= breakdown.pacing <= 10.0
    assert 0 <= breakdown.total <= 100
    assert breakdown.tier in ("VIRAL_GOLD", "HIGH_POTENTIAL", "MODERATE", "STANDARD")


def test_viral_short_vs_flat_corporate_monologue_delta() -> None:
    """Core SLA: Viral short must outperform a flat corporate monologue by at least 35 points."""
    # 1. High-virality short: high hook, contrarian statement, trends, punchline, optimal 165 WPM
    viral_text = (
        "Did you know the biggest mistake founders make with artificial intelligence? "
        "Never invest millions into software before validating product market fit! "
        "OpenAI and Google proved that fast iteration beats raw capital every single time."
    )
    viral_words = make_words_from_text(viral_text, wpm=165.0)
    viral_features = WordFeatures(viral_words, build_units(viral_words, min_ms=10_000, max_ms=60_000))
    viral_signals = get_signals(viral_features, viral_words)
    viral_acoustic = AcousticFeatures(
        pitch_variance=0.85,
        volume_dynamics=0.90,
        laughter_probability=0.30,
        energy_peaks=0.80,
    )
    viral_result = virality_index(viral_signals, acoustic=viral_acoustic)

    # 2. Flat corporate monologue: filler opening, slow droning, no hook, trailing conjunction
    flat_text = (
        "Um, yeah, so basically as I was saying earlier during the quarterly meeting, "
        "the committee noted standard operational items and administrative protocols "
        "pertaining to miscellaneous documentation and so..."
    )
    # Slow 95 WPM, lots of pauses
    flat_words = make_words_from_text(flat_text, wpm=95.0)
    # Inject 1.5s pause
    if len(flat_words) > 5:
        flat_words[5] = Word(wid=flat_words[5].wid, text=flat_words[5].text, start_ms=flat_words[4].end_ms + 1500, end_ms=flat_words[4].end_ms + 1800)
    flat_features = WordFeatures(flat_words, build_units(flat_words, min_ms=10_000, max_ms=60_000))
    flat_signals = get_signals(flat_features, flat_words)
    flat_acoustic = AcousticFeatures(
        pitch_variance=0.15,
        volume_dynamics=0.10,
        laughter_probability=0.0,
        energy_peaks=0.05,
    )
    flat_result = virality_index(flat_signals, acoustic=flat_acoustic)

    score_delta = viral_result.total - flat_result.total
    assert score_delta >= 35, (
        f"Expected virality score delta >= 35 points, but got {score_delta} "
        f"(viral={viral_result.total}, flat={flat_result.total})"
    )
    assert viral_result.tier in ("VIRAL_GOLD", "HIGH_POTENTIAL")
    assert flat_result.tier in ("MODERATE", "STANDARD")


def test_hook_window_isolator_curiosity_and_contrarian() -> None:
    """The 3.5s hook window specifically rewards curiosity gaps and contrarian assertion."""
    hook_curiosity = (
        "What is the hidden secret that billionaires never tell anyone? "
        "They build systems that generate compound growth automatically."
    )
    words = make_words_from_text(hook_curiosity, wpm=170.0)
    features = WordFeatures(words, build_units(words, min_ms=10_000, max_ms=60_000))
    hook_analysis = features.hook_analysis(0, len(words) - 1, words[0].start_ms)

    assert hook_analysis.curiosity_gap >= 0.70
    assert hook_analysis.s_hook >= 18.0
    assert not hook_analysis.has_filler_opening


def test_hook_window_isolator_filler_penalties() -> None:
    """Weak filler openings ('So basically', 'Um, yeah') suffer heavy 80% penalty on S_hook."""
    filler_text = (
        "So basically what we were discussing was how to configure local proxy servers. "
        "It involves setting up the upstream port properly."
    )
    words = make_words_from_text(filler_text, wpm=160.0)
    features = WordFeatures(words, build_units(words, min_ms=10_000, max_ms=60_000))
    hook_analysis = features.hook_analysis(0, len(words) - 1, words[0].start_ms)

    assert hook_analysis.has_filler_opening is True
    # Filler penalty cuts s_hook down by 80% (multiplier 0.2)
    assert hook_analysis.s_hook < 10.0


def test_narrative_completeness_and_trailing_conjunction_penalty() -> None:
    """Clips ending on trailing conjunctions ('and so...', 'but anyway...') lose narrative points."""
    # Complete narrative arc
    complete_text = "Never underestimate the power of daily habits. They define your entire future."
    c_words = make_words_from_text(complete_text, wpm=160.0)
    c_feat = WordFeatures(c_words, build_units(c_words, min_ms=10_000, max_ms=60_000))
    c_sig = get_signals(c_feat, c_words)
    c_virality = virality_index(c_sig)

    # Incomplete narrative arc ending on dangling conjunction
    dangling_text = "Never underestimate the power of daily habits because they define your entire future and so"
    d_words = make_words_from_text(dangling_text, wpm=160.0)
    d_feat = WordFeatures(d_words, build_units(d_words, min_ms=10_000, max_ms=60_000))
    d_sig = get_signals(d_feat, d_words)
    d_virality = virality_index(d_sig)

    assert d_sig.trailing_conjunction is True
    assert c_sig.trailing_conjunction is False
    assert c_virality.narrative > d_virality.narrative


def test_topical_trend_density_scoring() -> None:
    """Trend keyword density (AI, OpenAI, revenue, bitcoin, crypto) increases S_trend."""
    trend_text = (
        "In this video we analyze OpenAI, ChatGPT and artificial intelligence automation. "
        "Discover how startups generate millions in profit and crypto revenue."
    )
    words = make_words_from_text(trend_text, wpm=160.0)
    feat = WordFeatures(words, build_units(words, min_ms=10_000, max_ms=60_000))
    sig = get_signals(feat, words)
    result = virality_index(sig)

    assert sig.trend_keywords >= 4
    assert result.trend >= 10.0  # Max is 15.0


def test_pacing_and_cadence_scoring() -> None:
    """Optimal 150-190 WPM receives top cadence score; micro-pauses > 1.0s deduct points."""
    # Optimal cadence (165 WPM, no long pauses)
    text = "Fast and crisp delivery keeps the viewer engaged from start to finish without any dead air."
    words = make_words_from_text(text, wpm=165.0)
    feat = WordFeatures(words, build_units(words, min_ms=10_000, max_ms=60_000))
    sig = get_signals(feat, words)
    opt_result = virality_index(sig)

    # Sluggish cadence (105 WPM with 2 long pauses > 1s)
    slow_words = make_words_from_text(text, wpm=105.0)
    # Add two 1.2s pauses
    slow_words[2] = Word(wid=slow_words[2].wid, text=slow_words[2].text, start_ms=slow_words[1].end_ms + 1200, end_ms=slow_words[1].end_ms + 1500)
    slow_words[5] = Word(wid=slow_words[5].wid, text=slow_words[5].text, start_ms=slow_words[4].end_ms + 1200, end_ms=slow_words[4].end_ms + 1500)
    slow_feat = WordFeatures(slow_words, build_units(slow_words, min_ms=10_000, max_ms=60_000))
    slow_sig = get_signals(slow_feat, slow_words)
    slow_result = virality_index(slow_sig)

    assert opt_result.pacing > slow_result.pacing
    assert opt_result.pacing >= 8.0


def test_tier_badge_thresholds() -> None:
    """Tier thresholds strictly follow the architecture specification."""
    assert virality_tier(100) == "VIRAL_GOLD"
    assert virality_tier(85) == "VIRAL_GOLD"
    assert virality_tier(84) == "HIGH_POTENTIAL"
    assert virality_tier(70) == "HIGH_POTENTIAL"
    assert virality_tier(69) == "MODERATE"
    assert virality_tier(50) == "MODERATE"
    assert virality_tier(49) == "STANDARD"
    assert virality_tier(0) == "STANDARD"


def test_deterministic_scoring_regression() -> None:
    """Scores for identical inputs must be strictly deterministic across repeated runs."""
    text = (
        "Why is everyone obsessing over artificial intelligence in 2026? "
        "The truth is that autonomous systems change how every creator produces content."
    )
    words = make_words_from_text(text, wpm=160.0)
    acoustic = AcousticFeatures(0.7, 0.6, 0.1, 0.5)

    feat1 = WordFeatures(words, build_units(words, min_ms=10_000, max_ms=60_000))
    sig1 = get_signals(feat1, words)
    run1 = virality_index(sig1, acoustic=acoustic)

    feat2 = WordFeatures(words, build_units(words, min_ms=10_000, max_ms=60_000))
    sig2 = get_signals(feat2, words)
    run2 = virality_index(sig2, acoustic=acoustic)

    assert run1.hook == run2.hook
    assert run1.narrative == run2.narrative
    assert run1.energy == run2.energy
    assert run1.trend == run2.trend
    assert run1.pacing == run2.pacing
    assert run1.total == run2.total
    assert run1.tier == run2.tier


def test_acoustic_pcm_window_analysis_synthetic() -> None:
    """analyze_pcm_window extracts variance and volume dynamics from 16kHz PCM audio."""
    sample_rate = 16_000
    t = np.linspace(0, 1.0, sample_rate, endpoint=False)
    samples = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

    ac = analyze_pcm_window(samples, sample_rate, 0, 1000)
    assert 0.0 <= ac.pitch_variance <= 1.0
    assert 0.0 <= ac.volume_dynamics <= 1.0
    assert 0.0 <= ac.laughter_probability <= 1.0
    assert 0.0 <= ac.energy_peaks <= 1.0
