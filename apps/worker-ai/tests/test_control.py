"""FastAPI control app: /health, /providers and the /evals/run stub."""

from __future__ import annotations

from fastapi.testclient import TestClient

from worker_ai import __version__
from worker_ai.control import create_app
from worker_ai.providers.registry import build_registry
from worker_ai.queues import AI_QUEUES, IMPLEMENTED_AI_QUEUES
from worker_ai.routing import load_routing_table
from worker_ai.settings import load_settings

from .conftest import VALID_ENV


def test_health_reports_ok_and_the_consumed_queues() -> None:
    settings = load_settings(VALID_ENV)
    with TestClient(create_app(settings)) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "version": __version__,
        "queues": list(AI_QUEUES),
        "implemented": list(IMPLEMENTED_AI_QUEUES),
    }


def test_health_reflects_a_pool_pinned_to_one_queue() -> None:
    settings = load_settings({**VALID_ENV, "WORKER_AI_QUEUES": "ai.transcribe"})
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").json()["queues"] == ["ai.transcribe"]


def test_health_works_without_an_environment() -> None:
    """The default app is built at import time, before `load_settings` has run."""
    with TestClient(create_app()) as client:
        body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["queues"] == list(IMPLEMENTED_AI_QUEUES)


def test_providers_lists_every_adapter_with_its_reason() -> None:
    settings = load_settings(VALID_ENV)
    with TestClient(create_app(settings, vad_name="energy")) as client:
        body = client.get("/providers").json()

    rows = {row["name"]: row for row in body["providers"]}
    assert set(rows) == {
        "mock",
        "local-whisper",
        "serverless-whisper",
        "elevenlabs",
        "sarvam",
        "assemblyai",
    }
    assert rows["mock"]["enabled"] is True
    # Implemented, but this environment has no key, so it is off *with a reason*.
    assert rows["sarvam"]["implemented"] is True
    assert rows["sarvam"]["enabled"] is False
    assert "SARVAM_API_KEY" in rows["sarvam"]["reason"]
    assert rows["sarvam"]["flag"] == "asr.sarvam"
    assert rows["elevenlabs"]["capabilities"]["wordTimestamps"] is True
    assert rows["elevenlabs"]["costPerMinuteInr"] == 0.35
    assert body["vad"] == {"backend": "energy"}
    assert body["lid"]["codeMixThreshold"] == 0.3
    assert body["cache"]["backend"] in {"redis", "memory", "none"}


def test_providers_carries_the_routing_table_and_the_registries() -> None:
    settings = load_settings(VALID_ENV)
    with TestClient(create_app(settings)) as client:
        body = client.get("/providers").json()

    assert body["routing"]["version"] == 2
    assert next(lane["id"] for lane in body["routing"]["lanes"]) == "hinglish"
    assert [row["name"] for row in body["aligners"]][-1] == "proportional-vad"
    assert [row["name"] for row in body["diarisers"]][-1] == "noop-single-speaker"


def test_providers_reflects_an_injected_registry() -> None:
    """Injection is how a test describes a pod without touching the environment."""
    registry = build_registry(
        load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.example"})
    )
    with TestClient(create_app(providers=registry, routing=load_routing_table())) as client:
        rows = {row["name"]: row for row in client.get("/providers").json()["providers"]}
    assert rows["serverless-whisper"]["enabled"] is True


def test_providers_without_a_registry_lists_nothing_rather_than_failing() -> None:
    with TestClient(create_app()) as client:
        assert client.get("/providers").json()["providers"] == []


def test_evals_run_is_an_honest_stub() -> None:
    with TestClient(create_app()) as client:
        response = client.post("/evals/run", json={"set": "hinglish-mini"})

    assert response.status_code == 501
    body = response.json()
    assert body["status"] == "not_implemented"
    assert body["command"].startswith("python -m worker_ai.evals run --set hinglish-mini")
    assert "hinglish-mini" in body["availableSets"]


def test_evals_run_validates_its_body() -> None:
    with TestClient(create_app()) as client:
        assert client.post("/evals/run", json={"set": ""}).status_code == 422


def test_openapi_document_describes_every_route() -> None:
    with TestClient(create_app()) as client:
        document = client.get("/openapi.json").json()
    assert set(document["paths"]) == {"/health", "/providers", "/metrics", "/evals/run"}


def test_metrics_are_prometheus_text() -> None:
    """`09 §1`: latency, cost and quality tagged by provider and language."""
    from worker_ai.metrics import METRICS, MetricKey

    METRICS.reset()
    METRICS.record_call(
        MetricKey(provider="elevenlabs", language="hi", lane="hindi"),
        outcome="ok",
        media_seconds=12.5,
        cost_minor=8,
    )
    METRICS.record_cache(hit=True)
    METRICS.record_fallback(from_provider="sarvam", to_provider="elevenlabs")

    with TestClient(create_app()) as client:
        response = client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    body = response.text
    expected = (
        'montaj_asr_calls_total{lane="hindi",language="hi",'
        'outcome="ok",provider="elevenlabs"} 1'
    )
    assert expected in body
    assert "montaj_asr_media_seconds_total" in body
    assert 'montaj_asr_cache_total{outcome="hit"} 1' in body
    assert 'montaj_asr_fallbacks_total{from="sarvam",to="elevenlabs"} 1' in body
    METRICS.reset()
