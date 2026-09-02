"""Batching, at the unit level and through the live route.

The acceptance criterion is "≥ 2 chunks per model call under concurrent load",
and it is measured the only way it can honestly be measured: the fake backend
records ``len(jobs)`` on every call, and the test asserts against that record
rather than against a timing.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

import pytest

from model_server.batching import DynamicBatcher
from tests.conftest import FakeAsr, build_app, build_settings, inline, make_wav

# ---------------------------------------------------------------------------
# The batcher itself
# ---------------------------------------------------------------------------


async def test_concurrent_submissions_share_one_call() -> None:
    calls: list[int] = []

    async def run(items: Sequence[int]) -> list[int]:
        calls.append(len(items))
        return [item * 2 for item in items]

    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=8, window_s=0.05)
    batcher.start()
    results = await asyncio.gather(*(batcher.submit(value) for value in range(6)))
    await batcher.aclose()

    assert [batched.result for batched in results] == [0, 2, 4, 6, 8, 10]
    assert len(calls) == 1, "six concurrent submissions should be one model call"
    assert calls[0] == 6
    assert all(batched.batch_size == 6 for batched in results)


async def test_a_batch_never_exceeds_max_size() -> None:
    calls: list[int] = []

    async def run(items: Sequence[int]) -> list[int]:
        calls.append(len(items))
        return list(items)

    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=3, window_s=0.05)
    batcher.start()
    await asyncio.gather(*(batcher.submit(value) for value in range(7)))
    await batcher.aclose()

    assert max(calls) == 3
    assert sum(calls) == 7


async def test_a_lone_request_pays_the_window_and_no_more() -> None:
    """The batching latency cost, stated as a bound rather than assumed away.

    A lone request waits the window, because the consumer cannot know nothing is
    arriving 5 ms behind it without waiting to find out. What must hold is that
    it waits the window and not a multiple of it.
    """

    async def run(items: Sequence[int]) -> list[int]:
        return list(items)

    window = 0.1
    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=8, window_s=window)
    batcher.start()
    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await batcher.submit(1)
    elapsed = loop.time() - started
    await batcher.aclose()

    assert result.batch_size == 1
    assert window <= elapsed < window * 3
    assert result.wait_s >= window


async def test_one_failing_group_does_not_wedge_the_batcher() -> None:
    attempts: list[int] = []

    async def run(items: Sequence[int]) -> list[int]:
        attempts.append(len(items))
        if items[0] < 0:
            raise RuntimeError("bad chunk")
        return list(items)

    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=1, window_s=0.0)
    batcher.start()
    with pytest.raises(RuntimeError, match="bad chunk"):
        await batcher.submit(-1)
    assert (await batcher.submit(5)).result == 5
    await batcher.aclose()
    assert len(attempts) == 2


async def test_a_backend_that_returns_the_wrong_count_is_an_error_not_a_mix_up() -> None:
    async def run(items: Sequence[int]) -> list[int]:
        return list(items)[:-1]

    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=4, window_s=0.05)
    batcher.start()
    with pytest.raises(RuntimeError, match="results for"):
        await asyncio.gather(batcher.submit(1), batcher.submit(2))
    await batcher.aclose()


async def test_max_size_one_disables_grouping() -> None:
    calls: list[int] = []

    async def run(items: Sequence[int]) -> list[int]:
        calls.append(len(items))
        return list(items)

    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=1, window_s=0.05)
    batcher.start()
    await asyncio.gather(batcher.submit(1), batcher.submit(2), batcher.submit(3))
    await batcher.aclose()
    assert calls == [1, 1, 1]


# ---------------------------------------------------------------------------
# Through the route
# ---------------------------------------------------------------------------


async def test_concurrent_transcribes_reach_the_model_as_one_call() -> None:
    """The acceptance criterion: ≥ 2 chunks per model call under concurrent load."""
    import httpx
    from httpx import ASGITransport

    asr = FakeAsr(delay_s=0.02)
    app = build_app(asr=asr, settings=build_settings(batch_max_size=8, batch_window_ms=50))
    audio = inline(make_wav(1.0))
    headers = {"authorization": "Bearer test-gpu-token"}

    transport = ASGITransport(app=app)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://gpu.test") as client,
    ):
        responses = await asyncio.gather(
            *(client.post("/transcribe", json={"audio": audio}, headers=headers) for _ in range(4))
        )

    assert all(response.status_code == 200 for response in responses)
    assert max(asr.batch_sizes) >= 2, (
        "four concurrent chunks produced only " + repr(asr.batch_sizes) + " per call"
    )
    reported = [response.json()["usage"]["batchSize"] for response in responses]
    assert max(reported) >= 2
    # Batched GPU seconds are the group's wall clock divided by the group size:
    # the card was busy once, not four times.
    for response in responses:
        usage = response.json()["usage"]
        assert usage["gpuSeconds"] <= 0.02 * 4 / usage["batchSize"] + 0.5
