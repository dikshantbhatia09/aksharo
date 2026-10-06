"""Unit and integration tests for TRIBE v2 client and neural highlight scoring."""

from __future__ import annotations

import httpx
import pytest

from worker_ai.highlights.contracts import HighlightProposal
from worker_ai.highlights.scoring import score
from worker_ai.highlights.tribe_client import (
    NeuralAttentionScore,
    TribeClient,
    TribeWindowInput,
)
from worker_ai.highlights.windows import Window, build_units, usable_words
from worker_ai.processors.highlights import _Candidate, _proposal, _Ranked, _score_all
from worker_ai.settings import load_settings


VALID_BASE_ENV = {
    "REDIS_URL": "redis://localhost:6379",
    "API_ORIGIN": "http://localhost:3001",
    "INTERNAL_CALLBACK_SECRET": "0" * 64,
}


def test_settings_loads_tribe_configuration() -> None:
    env = {
        **VALID_BASE_ENV,
        "WORKER_AI_TRIBE_URL": "http://192.168.1.150:8095",
        "WORKER_AI_TRIBE_ENABLED": "true",
        "WORKER_AI_TRIBE_TIMEOUT_SECONDS": "20.0",
    }
    settings = load_settings(env)
    assert settings.tribe_inference_url == "http://192.168.1.150:8095"
    assert settings.tribe_enabled is True
    assert settings.tribe_timeout_seconds == 20.0


def test_settings_tribe_defaults() -> None:
    settings = load_settings(VALID_BASE_ENV)
    assert settings.tribe_inference_url == ""
    assert settings.tribe_enabled is False
    assert settings.tribe_timeout_seconds == 15.0


@pytest.mark.asyncio
async def test_tribe_client_health_check_success(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TribeClient(
        base_url="http://macbook-host:8095",
        enabled=True,
    )

    class MockResponse:
        status_code = 200

        def json(self) -> dict[str, str]:
            return {"status": "ready", "device": "mps", "model": "tribe-v2"}

    class MockAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> MockAsyncClient:
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def get(self, url: str) -> MockResponse:
            assert url == "http://macbook-host:8095/health"
            return MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    health = await client.health()
    assert health is not None
    assert health["status"] == "ready"
    assert health["device"] == "mps"
    assert await client.is_available() is True


@pytest.mark.asyncio
async def test_tribe_client_health_check_ok_format(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TribeClient(
        base_url="http://192.168.1.5:8765",
        enabled=True,
    )

    class MockResponse:
        status_code = 200

        def json(self) -> dict[str, bool]:
            return {"ok": True}

    class MockAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> MockAsyncClient:
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def get(self, url: str) -> MockResponse:
            assert url == "http://192.168.1.5:8765/health"
            return MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    health = await client.health()
    assert health is not None
    assert health == {"ok": True}
    assert await client.is_available() is True


@pytest.mark.asyncio
async def test_tribe_client_health_check_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TribeClient(
        base_url="http://macbook-host:8095",
        enabled=True,
    )

    class MockAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> MockAsyncClient:
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def get(self, url: str) -> None:
            raise httpx.ConnectError("Connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    health = await client.health()
    assert health is None
    assert await client.is_available() is False


@pytest.mark.asyncio
async def test_tribe_client_predict_batch_success(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TribeClient(
        base_url="http://macbook-host:8095",
        enabled=True,
    )

    class MockResponse:
        status_code = 200

        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict[str, list[dict]]:
            return {
                "predictions": [
                    {
                        "windowId": "w-001",
                        "hookScore": 0.88,
                        "retentionScore": 0.92,
                        "immersionScore": 0.85,
                        "neuralViralIndex": 89.5,
                        "attentionCurve": [0.85, 0.90, 0.88, 0.92],
                        "dropoffRiskPoints": [],
                    }
                ]
            }

    class MockAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> MockAsyncClient:
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, url: str, json: dict) -> MockResponse:
            assert "batch-neural-attention" in url
            assert len(json["windows"]) == 1
            return MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    inputs = [
        TribeWindowInput(
            window_id="w-001",
            start_ms=1000,
            end_ms=15000,
            transcript_text="The biggest mistake founders make in early sales is not asking questions.",
        )
    ]
    results = await client.predict_batch(inputs)
    assert "w-001" in results
    score = results["w-001"]
    assert score.hook_score == 0.88
    assert score.retention_score == 0.92
    assert score.immersion_score == 0.85
    assert score.neural_viral_index == 89.5
    assert score.source == "tribe_v2_macbook"


@pytest.mark.asyncio
async def test_tribe_client_timeout_graceful_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TribeClient(
        base_url="http://macbook-host:8095",
        enabled=True,
    )

    class MockAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> MockAsyncClient:
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, url: str, json: dict) -> None:
            raise httpx.TimeoutException("Read timed out")

    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    inputs = [
        TribeWindowInput(
            window_id="w-001",
            start_ms=1000,
            end_ms=15000,
            transcript_text="Some text",
        )
    ]
    # Must not raise an exception; returns empty dict
    results = await client.predict_batch(inputs)
    assert results == {}


def test_heuristic_neural_prediction() -> None:
    client = TribeClient()
    inp = TribeWindowInput(
        window_id="w-002",
        start_ms=0,
        end_ms=12000,
        transcript_text="The secret to scaling revenue is actually focus and discipline.",
    )
    res = client.heuristic_neural_prediction(inp)
    assert res.window_id == "w-002"
    assert res.source == "heuristic_cortex"
    assert res.hook_score >= 0.80  # "secret" triggers hook token
    assert 0.0 <= res.retention_score <= 1.0
    assert 0.0 <= res.neural_viral_index <= 100.0


def test_proposal_generation_with_neural_signals() -> None:
    sentences = [
        "The secret to building great companies is never giving up on your core mission.",
        "Every single founder who succeeds has learned that lesson the hard way.",
    ]
    raw_words: list[dict[str, Any]] = []
    clock = 0
    for sentence in sentences:
        for token in sentence.split():
            raw_words.append(
                {
                    "wid": f"w{len(raw_words) + 1:05d}",
                    "text": token,
                    "startMs": clock,
                    "endMs": clock + 350,
                }
            )
            clock += 400
        clock += 500

    from worker_ai.highlights.contracts import HighlightsOptions
    options = HighlightsOptions(
        count=1,
        minDurationMs=3000,
        maxDurationMs=15000,
        contentGoal="reach",
        language="en",
    )
    scored = _score_all(raw_words, options, duration_ms=clock)
    assert scored is not None
    assert len(scored.candidates) > 0

    candidate = scored.candidates[0]
    neural_score = NeuralAttentionScore(
        window_id=candidate.window.window_id,
        hook_score=0.91,
        retention_score=0.88,
        immersion_score=0.84,
        neural_viral_index=88.5,
        source="tribe_v2_macbook",
    )

    ranked = _Ranked(
        candidate=candidate,
        potential=candidate.score.potential,
        neural=neural_score,
    )
    # Biological attention lift applied
    assert ranked.ranked_on > ranked.potential

    proposal = _proposal(ranked, scored)
    assert isinstance(proposal, HighlightProposal)
    # visualActivity updated from unmeasured 50 to neural immersion score 84%
    assert proposal.score_breakdown.visual_activity == 84
    # Hook boosted by neural hook score
    assert proposal.score_breakdown.hook >= 70

    # Proposal reasons should contain TRIBE v2 explanation
    tribe_reasons = [r for r in proposal.reasons if "TRIBE v2" in r.explanation]
    assert len(tribe_reasons) >= 1
    assert any(r.label in {"hook", "visual"} for r in tribe_reasons)


def test_tribe_client_nan_inf_safety() -> None:
    client = TribeClient()
    parsed = client._parse_single_item(
        "w-nan",
        {
            "hookScore": float("nan"),
            "retentionScore": float("inf"),
            "immersionScore": float("-inf"),
            "neuralViralIndex": float("nan"),
            "attentionCurve": [0.5, float("nan"), 0.8],
            "dropoffRiskPoints": [1000, "invalid", 2000],
        },
        latency_ms=10,
    )
    assert parsed is not None
    assert parsed.hook_score == 0.5
    assert parsed.retention_score == 0.5
    assert parsed.immersion_score == 0.5
    assert parsed.neural_viral_index == 50.0
    # Invalid floats filtered out
    assert parsed.attention_curve == (0.5, 0.8)
    assert parsed.dropoff_risk_points == (1000, 2000)


def test_tribe_client_empty_and_corrupt_response() -> None:
    client = TribeClient()
    assert client._parse_batch_response(None, 0) == {}
    assert client._parse_batch_response("not-a-dict", 0) == {}
    assert client._parse_batch_response({"predictions": "not-a-list"}, 0) == {}
    assert client._parse_batch_response({"predictions": [{"missing_id": 1}]}, 0) == {}


def test_ranking_model_reflects_tribe_tag() -> None:
    from worker_ai.highlights.contracts import ProposalReason, ScoreBreakdown
    from worker_ai.processors.highlights import _ranking_model

    p_without = HighlightProposal(
        window_id="w1",
        start_ms=1000,
        end_ms=5000,
        start_word_id="w001",
        end_word_id="w010",
        title="Test",
        transcript_excerpt="Test excerpt",
        potential_score=75,
        score_breakdown=ScoreBreakdown(
            hook=70, clarity=80, emotion=60, visual_activity=50, novelty=70, standalone_value=80, safety=100
        ),
        reasons=(ProposalReason(label="hook", explanation="Standard hook opening."),),
    )
    assert _ranking_model([p_without]) == "montaj-highlight-v2"

    p_with = p_without.model_copy(
        update={
            "reasons": (
                ProposalReason(
                    label="hook",
                    explanation="TRIBE v2 Neural Brain Encoder: High ventral attention peak in opening.",
                ),
            )
        }
    )
    assert _ranking_model([p_with]) == "montaj-highlight-v2+tribe-v2"
