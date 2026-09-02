"""The ``model_server_*`` series: the names METRICS.md section 11 registers."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from tests.conftest import inline, make_wav

METRICS_DOC = Path(__file__).resolve().parents[3] / "infra" / "observability" / "METRICS.md"


def scrape(client: TestClient) -> str:
    return client.get("/metrics").text


def test_a_served_request_moves_the_cost_counters(client: TestClient, auth: dict[str, str]) -> None:
    client.post("/transcribe", json={"audio": inline(make_wav(4.0))}, headers=auth)
    text = scrape(client)
    assert 'model_server_requests_total{route="/transcribe",status="200"} 1.0' in text
    assert (
        'model_server_audio_seconds_total{model="large-v3-turbo",route="/transcribe"} 4.0' in text
    )
    assert "model_server_compute_seconds_total" in text
    assert "model_server_realtime_factor_bucket" in text
    assert "model_server_batch_size_bucket" in text
    assert "model_server_request_duration_seconds_bucket" in text


def test_the_memory_ledger_is_published(client: TestClient) -> None:
    text = scrape(client)
    assert "model_server_memory_budget_bytes" in text
    assert "model_server_memory_reserved_bytes 0.0" in text


def test_readiness_and_drain_are_gauges(client: TestClient) -> None:
    text = scrape(client)
    assert 'model_server_model_ready{model="asr"} 1.0' in text
    assert "model_server_draining 0.0" in text


def test_an_auth_failure_is_counted_by_reason(client: TestClient) -> None:
    client.post("/transcribe", json={"audio": "x"})
    assert 'model_server_rejected_total{reason="auth"} 1.0' in scrape(client)


def test_every_published_series_is_registered_in_metrics_md(
    client: TestClient, auth: dict[str, str]
) -> None:
    """A metric name is as frozen as an API route; an unregistered one is a bug.

    METRICS.md is the contract the dashboards and alert rules bind to, so a series
    this app publishes without a row in that file is a panel nobody can write.
    """
    assert METRICS_DOC.is_file(), "infra/observability/METRICS.md is missing"
    document = METRICS_DOC.read_text(encoding="utf-8")

    client.post("/transcribe", json={"audio": inline(make_wav(1.0))}, headers=auth)
    published = {
        match.group(1)
        for match in re.finditer(r"^# (?:HELP|TYPE) (model_server_[a-z_]+)", scrape(client), re.M)
    }
    assert published, "the app published no model_server_* series at all"

    for name in sorted(published):
        # prometheus_client reports histograms and counters by their base name;
        # METRICS.md registers the scraped form, so both are accepted.
        assert name in document or name + "_total" in document or name + "_seconds" in document, (
            name + " is published but not registered in infra/observability/METRICS.md"
        )
