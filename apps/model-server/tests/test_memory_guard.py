"""The memory guard: a deterministic 503 with Retry-After, never a CUDA OOM."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from model_server.errors import OverloadedError
from model_server.memory import MemoryGuard
from tests.conftest import FakeAsr, build_app, build_settings, inline, make_wav

MEGABYTE = 1024 * 1024


def test_estimate_grows_with_the_audio() -> None:
    guard = MemoryGuard(budget_bytes=100 * MEGABYTE, bytes_per_audio_second=MEGABYTE, floor_bytes=0)
    assert guard.estimate(0.0) == 0
    assert guard.estimate(10.0) == 10 * MEGABYTE
    assert guard.estimate(10.0, factor=2.0) == 20 * MEGABYTE


def test_a_reservation_is_released_even_when_the_body_raises() -> None:
    guard = MemoryGuard(budget_bytes=100 * MEGABYTE, bytes_per_audio_second=MEGABYTE, floor_bytes=0)
    with pytest.raises(ValueError, match="boom"), guard.reserve(10.0):
        assert guard.reserved_bytes == 10 * MEGABYTE
        raise ValueError("boom")
    assert guard.reserved_bytes == 0


def test_a_second_request_over_budget_is_refused_with_retry_after() -> None:
    guard = MemoryGuard(
        budget_bytes=10 * MEGABYTE,
        bytes_per_audio_second=MEGABYTE,
        floor_bytes=0,
        retry_after_s=7,
    )
    with guard.reserve(8.0):
        with pytest.raises(OverloadedError) as error, guard.reserve(8.0):
            pass  # pragma: no cover - the reservation must not be granted
        assert error.value.status_code == 503
        assert error.value.headers["retry-after"] == "7"
        assert error.value.details["budgetBytes"] == 10 * MEGABYTE
    # Released again once the first call finishes.
    with guard.reserve(8.0):
        assert guard.reserved_bytes == 8 * MEGABYTE


def test_a_request_larger_than_the_whole_budget_says_so() -> None:
    guard = MemoryGuard(budget_bytes=4 * MEGABYTE, bytes_per_audio_second=MEGABYTE, floor_bytes=0)
    with pytest.raises(OverloadedError, match="send a shorter chunk"), guard.reserve(600.0):
        pass  # pragma: no cover


def test_the_route_returns_503_with_retry_after_deterministically(auth: dict[str, str]) -> None:
    """A four-second clip against a budget that cannot hold it: always 503."""
    settings = build_settings(memory_budget_bytes=MEGABYTE, memory_bytes_per_audio_second=MEGABYTE)
    app = build_app(settings=settings)
    with TestClient(app) as client:
        for _ in range(3):
            response = client.post(
                "/transcribe", json={"audio": inline(make_wav(4.0))}, headers=auth
            )
            assert response.status_code == 503
            assert response.headers["retry-after"] == "5"
            assert response.json()["error"]["code"] == "model-server/overloaded"


def test_the_guard_counts_a_rejection_in_the_metrics(auth: dict[str, str]) -> None:
    settings = build_settings(memory_budget_bytes=MEGABYTE, memory_bytes_per_audio_second=MEGABYTE)
    app = build_app(settings=settings)
    with TestClient(app) as client:
        client.post("/transcribe", json={"audio": inline(make_wav(4.0))}, headers=auth)
        metrics = client.get("/metrics").text
    assert 'model_server_rejected_total{reason="memory_guard"} 1.0' in metrics


async def test_a_held_reservation_blocks_a_concurrent_request() -> None:
    """Two four-second chunks, a budget that fits one: the second one waits its turn."""
    import httpx
    from httpx import ASGITransport

    # The guard's per-request floor is 64 MiB, so a budget of 70 MiB holds
    # exactly one four-second chunk (64 + 4) and not two.
    settings = build_settings(
        memory_budget_bytes=70 * MEGABYTE,
        memory_bytes_per_audio_second=MEGABYTE,
        batch_max_size=1,
        batch_window_ms=0,
    )
    app = build_app(asr=FakeAsr(delay_s=0.15), settings=settings)
    audio = inline(make_wav(4.0))
    headers = {"authorization": "Bearer test-gpu-token"}

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://gpu.test") as client,
    ):
        first, second = await asyncio.gather(
            client.post("/transcribe", json={"audio": audio}, headers=headers),
            client.post("/transcribe", json={"audio": audio}, headers=headers),
        )

    statuses = sorted([first.status_code, second.status_code])
    assert statuses == [200, 503], "one should be served and one refused"
