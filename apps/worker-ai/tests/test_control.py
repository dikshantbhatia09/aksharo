"""FastAPI control app."""

from __future__ import annotations

from fastapi.testclient import TestClient

from worker_ai import __version__
from worker_ai.control import create_app


def test_health_reports_ok_and_the_consumed_queues() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "version": __version__,
        "queues": ["ai.transcribe"],
    }


def test_openapi_document_describes_health() -> None:
    with TestClient(create_app()) as client:
        document = client.get("/openapi.json").json()
    assert "/health" in document["paths"]
