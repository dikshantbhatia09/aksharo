"""Batching, at the unit level and through the live route.

The acceptance criterion is "≥ 2 chunks per model call under concurrent load",
and it is measured the only way it can honestly be measured: the fake backend
records ``len(jobs)`` on every call, and the test asserts against that record
rather than against a timing.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

import pytest

from model_server.batching import DynamicBatcher, WaitFor
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


# ---------------------------------------------------------------------------
# The window, on an injected clock
#
# These used to assert on the wall clock, and one of them flaked on a loaded
# runner against its own lower bound: asyncio.wait_for returned 6 ms early on a
# 100 ms window. The window logic is worth testing; the machine timer resolution
# is not. So the clock and the wait are injected, and what is asserted is the
# thing that can actually be wrong - that the deadline is absolute, and that the
# batcher asks for the time remaining rather than for the whole window again.
# ---------------------------------------------------------------------------

WINDOW = 0.05


class FakeClock:
    """A monotonic clock the test advances by hand. Never reads real time."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def scripted_wait_for(
    clock: FakeClock, script: Sequence[tuple[float, bool]], asked: list[float]
) -> WaitFor:
    """An asyncio.wait_for that plays a script instead of watching a clock.

    Each script entry is (seconds_to_burn, deliver): the fake advances the clock
    by seconds_to_burn, then either hands over the next queued item (deliver) or
    raises TimeoutError, which is what the batcher sees when the window closes.
    Off the end of the script it burns the whole requested timeout and gives up,
    which is the ordinary "nobody else arrived" case.

    Every requested timeout is recorded in ``asked``, and that list is the real
    assertion: it is how the test tells an absolute deadline from a window that
    restarts on each arrival.
    """
    steps = iter(script)

    async def wait_for(awaitable: Any, timeout_s: float) -> Any:
        asked.append(timeout_s)
        burn, deliver = next(steps, (timeout_s, False))
        clock.advance(burn)
        if deliver:
            return await awaitable
        awaitable.close()
        raise TimeoutError

    return wait_for


async def test_a_lone_request_waits_exactly_one_window() -> None:
    """The batching latency cost, as an exact number rather than a range.

    A lone request does pay the window, because the consumer cannot know that
    nothing is arriving 5 ms behind it without waiting to find out. What must
    hold is that it waits the window once.
    """

    async def run(items: Sequence[int]) -> list[int]:
        return list(items)

    clock = FakeClock()
    asked: list[float] = []
    batcher: DynamicBatcher[int, int] = DynamicBatcher(
        run,
        max_size=8,
        window_s=WINDOW,
        clock=clock,
        wait_for=scripted_wait_for(clock, [], asked),
    )
    batcher.start()
    result = await batcher.submit(1)
    await batcher.aclose()

    assert result.batch_size == 1
    # approx, not equality: the fake clock starts at 1000.0 so that the test
    # proves the arithmetic does not depend on a zero origin, and 1000.05 -
    # 1000.0 is not exactly 0.05 in binary floating point.
    assert asked == pytest.approx([WINDOW]), (
        "the batcher should ask for the window once, and once only"
    )
    assert result.wait_s == pytest.approx(WINDOW)
    assert result.compute_s == pytest.approx(0.0)


async def test_the_deadline_is_absolute_not_restarted_by_each_arrival() -> None:
    """A second arrival must not buy the group another full window.

    This is the bug the injected clock exists to catch: with a per-item window a
    steady trickle of requests holds the first one open indefinitely, and the p95
    the latency budget in 05 section 5.1 is built on quietly stops being true.
    """

    async def run(items: Sequence[int]) -> list[int]:
        return list(items)

    clock = FakeClock()
    asked: list[float] = []
    batcher: DynamicBatcher[int, int] = DynamicBatcher(
        run,
        max_size=8,
        window_s=WINDOW,
        clock=clock,
        # The first wait delivers a second item 40% of the way into the window,
        # so the second must be asked for the remaining 60%.
        wait_for=scripted_wait_for(clock, [(WINDOW * 0.4, True)], asked),
    )
    batcher.start()
    first, second = await asyncio.gather(batcher.submit(1), batcher.submit(2))
    await batcher.aclose()

    assert first.batch_size == 2
    assert second.batch_size == 2
    assert len(asked) == 2
    assert asked[0] == pytest.approx(WINDOW)
    assert asked[1] == pytest.approx(WINDOW * 0.6), (
        "the second wait asked for "
        + repr(asked[1])
        + "; a window that restarted per arrival would have asked for the whole "
        + repr(WINDOW)
        + " again"
    )
    assert first.wait_s == pytest.approx(WINDOW)


async def test_a_full_batch_departs_without_waiting_out_the_window() -> None:
    """Reaching max_size ends the collection immediately."""

    async def run(items: Sequence[int]) -> list[int]:
        return list(items)

    clock = FakeClock()
    asked: list[float] = []
    batcher: DynamicBatcher[int, int] = DynamicBatcher(
        run,
        max_size=2,
        window_s=WINDOW,
        clock=clock,
        wait_for=scripted_wait_for(clock, [(WINDOW * 0.1, True)], asked),
    )
    batcher.start()
    results = await asyncio.gather(batcher.submit(1), batcher.submit(2))
    await batcher.aclose()

    assert [batched.batch_size for batched in results] == [2, 2]
    assert len(asked) == 1, "a full batch must not wait out the rest of the window"
    assert results[0].wait_s == pytest.approx(WINDOW * 0.1)


@pytest.mark.parametrize(("max_size", "window_s"), [(1, WINDOW), (8, 0.0)])
async def test_batching_turned_off_never_waits_at_all(max_size: int, window_s: float) -> None:
    """MODEL_SERVER_BATCH_MAX_SIZE=1 is the documented CPU configuration.

    cost.md measures batching as a cost rather than a saving on CPU, so the off
    switch has to be genuinely off: no window, no wait, no clock consulted.
    """

    async def run(items: Sequence[int]) -> list[int]:
        return list(items)

    clock = FakeClock()
    asked: list[float] = []
    batcher: DynamicBatcher[int, int] = DynamicBatcher(
        run,
        max_size=max_size,
        window_s=window_s,
        clock=clock,
        wait_for=scripted_wait_for(clock, [], asked),
    )
    batcher.start()
    result = await batcher.submit(1)
    await batcher.aclose()

    assert result.batch_size == 1
    assert asked == []
    assert clock.now == 1000.0, "nothing should have consumed any time"


@pytest.mark.slow
async def test_the_window_is_real_seconds_on_the_real_clock() -> None:
    """The one window test that touches the wall clock, opt-in via RUN_SLOW=1.

    The injected-clock tests prove the arithmetic; this proves the arithmetic is
    wired to a real timer rather than to something that returns instantly. The
    bounds are deliberately loose - half a window to two windows - because
    anything tighter is a test of the runner timer resolution, which is what made
    the earlier version of this flake.
    """

    async def run(items: Sequence[int]) -> list[int]:
        return list(items)

    window = 0.2
    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=8, window_s=window)
    batcher.start()
    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await batcher.submit(1)
    elapsed = loop.time() - started
    await batcher.aclose()

    assert result.batch_size == 1
    assert window * 0.5 <= elapsed < window * 2


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
