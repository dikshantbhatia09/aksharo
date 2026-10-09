"""Tests for Scoring Diagnostic Rationale Engine (Pillar 2 §02: Explainable AI).

Validates:
1. Parsing and validation of diagnostic JSON response across edge cases.
2. Normalization of category, label, detail, and sentiment fields.
3. Rejection of malformed diagnostic payloads.
4. Rule-based heuristic fallback generator:
   - Audience inquiry question hook
   - Authentic humor and conversational laughter
   - Passionate delivery with acoustic dynamics
   - Slow lead-in filler penalty (WARNING)
   - Trailing conjunction ending (WARNING)
   - Creator polish recommendation (creatorTip)
5. End-to-end integration: all highlight proposals carry structured diagnostics.
"""

from __future__ import annotations

import pytest

from worker_ai.highlights.contracts import DiagnosticItem, HighlightProposal, ViralityDiagnostic
from worker_ai.highlights.rerank import (
    _parse_diagnostic,
    heuristic_diagnostic,
    parse_judgements,
)


def test_parse_valid_diagnostic_json() -> None:
    raw = {
        "overallSummary": "Explosive curiosity hook followed by clean narrative payoff.",
        "items": [
            {
                "category": "HOOK",
                "label": "Shocking Metric Opening",
                "detail": "Opens with 'I lost $40,000 in one week', triggering immediate curiosity gap.",
                "sentiment": "POSITIVE",
            },
            {
                "category": "FLOW",
                "label": "Smooth Progression",
                "detail": "Transitions directly from personal struggle to actionable business lesson.",
                "sentiment": "POSITIVE",
            },
            {
                "category": "RETENTION",
                "label": "Memorable Punchline",
                "detail": "Ends on a crisp takeaway suitable for saving or sharing.",
                "sentiment": "POSITIVE",
            },
        ],
        "creatorTip": "Add a punch-in camera zoom on second 03 to emphasize the shocking loss.",
    }

    diag = _parse_diagnostic(raw)
    assert diag is not None
    assert diag.overall_summary == "Explosive curiosity hook followed by clean narrative payoff."
    assert len(diag.items) == 3
    assert diag.items[0].category == "HOOK"
    assert diag.items[0].label == "Shocking Metric Opening"
    assert diag.items[0].sentiment == "POSITIVE"
    assert diag.creator_tip == "Add a punch-in camera zoom on second 03 to emphasize the shocking loss."


def test_parse_diagnostic_normalizes_case_and_drops_invalid_categories() -> None:
    raw = {
        "summary": "Solid clip overall.",
        "breakdown": [
            {
                "category": "hook",
                "label": "Sharp Question",
                "detail": "Direct inquiry to the listener.",
                "sentiment": "positive",
            },
            {
                "category": "INVALID_CATEGORY",
                "label": "Bad Cat",
                "detail": "Should be omitted.",
                "sentiment": "POSITIVE",
            },
            {
                "category": "emotion",
                "label": "Authentic Laugh",
                "detail": "Contains spontaneous reaction.",
                "sentiment": "UNKNOWN_SENTIMENT",
            },
        ],
        "improvement_tip": "Trim the pause before the final sentence.",
    }

    diag = _parse_diagnostic(raw)
    assert diag is not None
    assert len(diag.items) == 2
    assert diag.items[0].category == "HOOK"
    assert diag.items[0].sentiment == "POSITIVE"
    assert diag.items[1].category == "EMOTION"
    # Unknown sentiment defaults to NEUTRAL for EMOTION
    assert diag.items[1].sentiment == "NEUTRAL"
    assert diag.creator_tip == "Trim the pause before the final sentence."


def test_parse_diagnostic_malformed_returns_none() -> None:
    assert _parse_diagnostic(None) is None
    assert _parse_diagnostic("not a dict") is None
    assert _parse_diagnostic({}) is None
    assert _parse_diagnostic({"items": []}) is None
    assert _parse_diagnostic({"items": [{"category": "HOOK", "detail": ""}]}) is None


def test_heuristic_diagnostic_audience_inquiry() -> None:
    diag = heuristic_diagnostic(
        text="Why do 90% of creators fail on short form videos in 2026?",
        hook_score=92,
        standalone_score=85,
        payoff_score=80,
        has_question=True,
    )
    assert diag.overall_summary != ""
    hook_items = [item for item in diag.items if item.category == "HOOK"]
    assert len(hook_items) >= 1
    assert hook_items[0].label == "Audience Inquiry Hook"
    assert hook_items[0].sentiment == "POSITIVE"
    assert "curiosity" in hook_items[0].detail.lower()


def test_heuristic_diagnostic_authentic_humor() -> None:
    diag = heuristic_diagnostic(
        text="He looked at the chart and started laughing hysterically.",
        hook_score=75,
        standalone_score=75,
        payoff_score=70,
        laughter_prob=0.35,
        humour_score=8,
    )
    emotion_items = [item for item in diag.items if item.category == "EMOTION"]
    assert len(emotion_items) >= 1
    assert emotion_items[0].label == "Authentic Humor"
    assert emotion_items[0].sentiment == "POSITIVE"
    assert "humor" in emotion_items[0].detail.lower()


def test_heuristic_diagnostic_passionate_acoustic_delivery() -> None:
    diag = heuristic_diagnostic(
        text="You cannot afford to ignore this technological transformation right now!",
        hook_score=80,
        standalone_score=80,
        payoff_score=78,
        pitch_variance=0.85,
        volume_dynamics=0.80,
    )
    flow_items = [item for item in diag.items if item.category == "FLOW"]
    assert len(flow_items) >= 1
    assert flow_items[0].label == "Passionate Delivery"
    assert flow_items[0].sentiment == "POSITIVE"


def test_heuristic_diagnostic_slow_lead_in_filler_warning() -> None:
    diag = heuristic_diagnostic(
        text="Um, yeah, so basically what we were discussing earlier was this algorithm.",
        hook_score=42,
        standalone_score=60,
        payoff_score=55,
        has_filler=True,
    )
    hook_items = [item for item in diag.items if item.category == "HOOK"]
    assert len(hook_items) >= 1
    assert hook_items[0].sentiment == "WARNING"
    assert "Slow Contextual Lead-In" in hook_items[0].label
    assert diag.creator_tip is not None
    assert "trim" in diag.creator_tip.lower()


def test_heuristic_diagnostic_trailing_resolution_warning() -> None:
    diag = heuristic_diagnostic(
        text="Never invest money before knowing product market fit and so",
        hook_score=80,
        standalone_score=65,
        payoff_score=45,
        trailing_conjunction=True,
    )
    retention_items = [item for item in diag.items if item.category == "RETENTION"]
    assert len(retention_items) >= 1
    assert retention_items[0].sentiment == "WARNING"
    assert "Trailing Resolution" in retention_items[0].label
    assert diag.creator_tip is not None
    assert ("tighten" in diag.creator_tip.lower() or "trim" in diag.creator_tip.lower())


def test_parse_judgements_integrates_diagnostic_field() -> None:
    payload = {
        "moments": [
            {
                "id": "w-0100",
                "standalone": 8,
                "payoff": 8,
                "humour": 3,
                "hook": 9,
                "reelViable": True,
                "why": "Clear question and answer.",
                "diagnostic": {
                    "overallSummary": "High virality candidate.",
                    "items": [
                        {
                            "category": "HOOK",
                            "label": "Viral Opener",
                            "detail": "Starts with bold claim.",
                            "sentiment": "POSITIVE",
                        }
                    ],
                    "creatorTip": "Add zoom at 00:03.",
                },
            }
        ]
    }
    judgements = parse_judgements(payload, ["w-0100"], with_topic=False, model="test-model")
    assert "w-0100" in judgements
    judged = judgements["w-0100"]
    assert judged.diagnostic is not None
    assert judged.diagnostic.overall_summary == "High virality candidate."
    assert len(judged.diagnostic.items) == 1
    assert judged.diagnostic.creator_tip == "Add zoom at 00:03."

