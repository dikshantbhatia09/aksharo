"""Startup, readiness, partial-failure isolation and the SIGTERM drain."""

from __future__ import annotations

import asyncio
import signal

from fastapi.testclient import TestClient

from model_server.metrics import Metrics
from model_server.models.registry import ModelRegistry
from tests.conftest import (
    BrokenBackend,
    FakeAligner,
    FakeAsr,
    FakeDiariser,
    build_app,
    build_settings,
    inline,
    make_wav,
)


def test_models_load_once_at_startup_not_per_request(auth: dict[str, str]) -> None:
    asr = FakeAsr()
    loads: list[int] = []
    original = asr.load

    def counting_load() -> None:
        loads.append(1)
        original()

    asr.load = counting_load  # type: ignore[method-assign]
    app = build_app(asr=asr)
    with TestClient(app) as client:
        for _ in range(3):
            client.post("/transcribe", json={"audio": inline(make_wav(1.0))}, headers=auth)
    assert loads == [1], "the weights must load once, at startup, never per request"


def test_readyz_is_false_before_startup_and_true_after() -> None:
    app = build_app()
    # Before the lifespan runs, no backend is resident.
    assert app.state.registry.ready() is False
    with TestClient(app) as client:
        body = client.get("/readyz").json()
        assert body["ready"] is True
        assert set(body["models"]) == {"asr", "align", "diarise"}
        assert body["models"]["diarise"]["model"].startswith("pyannote/")


def test_one_broken_backend_does_not_stop_the_others(auth: dict[str, str]) -> None:
    """A worker that can diarise but not transcribe is better than a crash loop."""
    settings = build_settings(preload=("asr", "align", "diarise"))
    app = build_app(settings=settings, asr=BrokenBackend())
    with TestClient(app) as client:
        # ASR was required and failed, so the worker is not ready overall...
        ready = client.get("/readyz")
        assert ready.status_code == 503
        assert ready.json()["models"]["asr"]["ready"] is False
        assert "no weights in this image" in ready.json()["models"]["asr"]["error"]

        refused = client.post("/transcribe", json={"audio": inline(make_wav(1.0))}, headers=auth)
        assert refused.status_code == 503
        assert "no weights in this image" in refused.json()["error"]["message"]

        served = client.post("/diarise", json={"audio": inline(make_wav(1.0))}, headers=auth)
        assert served.status_code == 200


def test_readyz_is_503_while_a_required_model_is_missing() -> None:
    app = build_app(settings=build_settings(preload=("asr",)), asr=BrokenBackend())
    with TestClient(app) as client:
        response = client.get("/readyz")
        assert response.status_code == 503
        assert "no weights in this image" in response.json()["reason"]


def test_healthz_answers_without_touching_a_model() -> None:
    """Liveness must not fail while 3 GB of weights page in."""
    app = build_app(settings=build_settings(preload=("asr",)), asr=BrokenBackend())
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}


def test_draining_turns_readiness_off_and_refuses_new_work(auth: dict[str, str]) -> None:
    app = build_app()
    with TestClient(app) as client:
        app.state.service.draining = True
        assert client.get("/readyz").status_code == 503

        response = client.post("/transcribe", json={"audio": inline(make_wav(1.0))}, headers=auth)
        assert response.status_code == 503
        assert "draining" in response.json()["error"]["message"]
        assert response.headers["retry-after"]


async def test_shutdown_unloads_the_models_and_stops_the_batcher() -> None:
    app = build_app()
    async with app.router.lifespan_context(app):
        assert app.state.registry.ready() is True
    assert app.state.registry.ready() is False
    assert app.state.service.draining is True


def test_the_registry_reports_load_seconds_and_readiness_as_metrics() -> None:
    metrics = Metrics.create()
    registry = ModelRegistry(
        asr=FakeAsr(), aligner=FakeAligner(), diariser=FakeDiariser(), required=("asr",)
    )
    registry.load(device="cpu", metrics=metrics)
    from prometheus_client import generate_latest

    text = generate_latest(metrics.registry).decode()
    assert 'model_server_model_ready{model="asr"} 1.0' in text
    assert 'model_server_model_load_seconds{device="cpu",model="asr"}' in text


def test_engine_versions_only_name_resident_models() -> None:
    registry = ModelRegistry(
        asr=FakeAsr(), aligner=None, diariser=FakeDiariser(), required=("asr", "diarise")
    )
    assert registry.engine_versions() == {}
    registry.load()
    versions = registry.engine_versions()
    assert versions["asr"] == "large-v3-turbo"
    assert versions["diarise.licence"] == "CC-BY-4.0"
    assert "align" not in versions


def test_the_drain_handler_flips_readiness_before_uvicorn_winds_down() -> None:
    from model_server.__main__ import _install_drain_handler

    app = build_app()
    previous = signal.getsignal(signal.SIGTERM)
    try:
        with TestClient(app):
            _install_drain_handler(app)
            assert app.state.service.draining is False
            installed = signal.getsignal(signal.SIGTERM)
            assert callable(installed)
            installed(signal.SIGTERM, None)
            assert app.state.service.draining is True
    finally:
        signal.signal(signal.SIGTERM, previous)


def test_a_slow_request_already_in_flight_survives_the_drain(auth: dict[str, str]) -> None:
    """Graceful means in-flight work finishes; only new work is turned away."""
    asr = FakeAsr(delay_s=0.2)
    app = build_app(asr=asr)

    async def exercise() -> None:
        import httpx
        from httpx import ASGITransport

        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=ASGITransport(app=app), base_url="http://gpu.test"
            ) as client,
        ):
            task = asyncio.create_task(
                client.post("/transcribe", json={"audio": inline(make_wav(1.0))}, headers=auth)
            )
            # Wait for the model call to actually begin, so the drain
            # lands mid-flight rather than before the request was admitted.
            await asyncio.to_thread(asr.entered.wait, 5.0)
            app.state.service.draining = True
            response = await task
            assert response.status_code == 200

    asyncio.run(exercise())


def test_a_backend_left_out_of_preload_is_never_loaded(auth: dict[str, str]) -> None:
    """MODEL_SERVER_PRELOAD selects what loads, not just what gates readiness.

    A CPU worker that only transcribes must not pay to page pyannote into memory,
    and its `/diarise` must say why rather than pretend.
    """
    diariser = FakeDiariser()
    app = build_app(settings=build_settings(preload=("asr",)), diariser=diariser)
    with TestClient(app) as client:
        assert client.get("/readyz").status_code == 200
        assert diariser.ready is False

        response = client.post("/diarise", json={"audio": inline(make_wav(1.0))}, headers=auth)
        assert response.status_code == 503
        assert "MODEL_SERVER_PRELOAD" in response.json()["error"]["message"]
