"""Bearer auth on the four model routes, and its absence on health and metrics."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from model_server.settings import ConfigurationError, Settings
from tests.conftest import TOKEN, build_app, build_settings, inline, make_wav

ROUTES = (
    ("/transcribe", {"audio": "x"}),
    ("/align", {"audio": "x", "words": ["a"], "language": "hi"}),
    ("/diarise", {"audio": "x"}),
    ("/detect-language", {"audio": "x"}),
)


@pytest.mark.parametrize(("route", "body"), ROUTES)
def test_no_token_is_401(client: TestClient, route: str, body: dict[str, object]) -> None:
    response = client.post(route, json=body)
    assert response.status_code == 401
    envelope = response.json()["error"]
    assert envelope["code"] == "model-server/unauthorized"
    assert "requestId" in envelope


@pytest.mark.parametrize(("route", "body"), ROUTES)
def test_wrong_token_is_401(client: TestClient, route: str, body: dict[str, object]) -> None:
    response = client.post(route, json=body, headers={"authorization": "Bearer nope"})
    assert response.status_code == 401


def test_a_token_in_the_wrong_scheme_is_401(client: TestClient) -> None:
    response = client.post(
        "/transcribe", json={"audio": "x"}, headers={"authorization": "Basic " + TOKEN}
    )
    assert response.status_code == 401


def test_auth_is_checked_before_the_body_is_validated(client: TestClient) -> None:
    # A 401 must not tell an unauthenticated caller which fields it got wrong.
    response = client.post("/transcribe", json={"nonsense": 1})
    assert response.status_code == 401


def test_health_and_metrics_need_no_token(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 200
    assert client.get("/readyz").status_code == 200
    metrics = client.get("/metrics")
    assert metrics.status_code == 200
    assert "model_server_requests_total" in metrics.text


def test_an_empty_token_refuses_to_boot() -> None:
    with pytest.raises(ConfigurationError) as error:
        Settings.from_env({"MODEL_SERVER_DEVICE": "cpu"})
    assert "GPU_PROVIDER_TOKEN" in str(error.value)


def test_anonymous_is_possible_but_must_be_asked_for() -> None:
    settings = Settings.from_env(
        {"MODEL_SERVER_DEVICE": "cpu", "MODEL_SERVER_ALLOW_ANONYMOUS": "1"}
    )
    assert settings.token == ""
    app = build_app(settings=build_settings(token="", allow_anonymous=True))
    with TestClient(app) as client:
        response = client.post("/transcribe", json={"audio": inline(make_wav(1.0))})
    assert response.status_code == 200
