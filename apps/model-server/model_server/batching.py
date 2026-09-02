"""Dynamic batching: the mechanism decision **D74** rests on.

X05's re-derivation in ``infra/gpu/COST.md §2`` gets ₹0.19 per media minute
*without* batching against a ₹0.09-0.13 band, and closes the gap with one lever:
"batched chunks keeping the card busy across requests". So batching here is not
an optimisation to add later, it is the reason the cost band is reachable at all,
and it is measured (``model_server_batch_size``) rather than assumed.

## How it works

One consumer task per batched route. A request puts ``(item, future)` on a queue
and awaits its future. The consumer takes the first item, then keeps taking for
up to ``window_s`` — 50 ms — or until ``max_size`` items are in hand, whichever
comes first, and hands the whole group to ``run`` as one call.

Three properties are load-bearing and each has a test:

* **The added latency is bounded by the window, and only the window.** A lone
  request does pay it — 50 ms — because the consumer cannot know that nothing is
  arriving 5 ms behind it without waiting to find out. Against a ten-minute
  chunk that takes tens of seconds to decode, 50 ms is noise; against the D74
  cost band it is the difference between a saturated card and an idle one. The
  bound is measured as ``model_server_batch_wait_seconds`` so a window that was
  mis-set is visible rather than inferred.
* **A failure fails only its own group.** ``run`` raising sets the exception on
  every future in that group and the consumer carries on; one malformed chunk
  must not wedge the endpoint.
* **Draining is ordered.** :meth:`aclose` stops accepting, lets the queued items
  through, and only then cancels the consumer — a SIGTERM in the middle of a
  batch must not drop the requests already admitted.

``run`` receives the group in submission order and must return one result per
item, in the same order. A length mismatch is a programming error in a backend
and is raised as one rather than silently mis-assigning transcripts.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass

from model_server.logging_setup import get_logger

__all__ = ["Batched", "DynamicBatcher"]

_log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class Batched[R]:
    """One request's result, plus what the batch it rode in looked like."""

    result: R
    #: How many requests went into the model call. Reported as ``usage.batchSize``.
    batch_size: int
    #: Seconds spent waiting in the window before the call started.
    wait_s: float
    #: Seconds the model call itself took, for the whole group.
    compute_s: float


class BatcherClosedError(RuntimeError):
    """A request arrived after :meth:`DynamicBatcher.aclose` began."""


class DynamicBatcher[T, R]:
    """Coalesce concurrent requests into one model call."""

    def __init__(
        self,
        run: Callable[[Sequence[T]], Awaitable[Sequence[R]]],
        *,
        max_size: int = 8,
        window_s: float = 0.05,
        name: str = "batcher",
    ) -> None:
        if max_size < 1:
            raise ValueError("max_size must be at least 1")
        self._run = run
        self._max_size = max_size
        self._window_s = max(0.0, window_s)
        self._name = name
        self._queue: asyncio.Queue[tuple[T, float, asyncio.Future[Batched[R]]]] = asyncio.Queue()
        self._consumer: asyncio.Task[None] | None = None
        self._closing = False

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Start the consumer task. Idempotent."""
        if self._consumer is None or self._consumer.done():
            self._closing = False
            self._consumer = asyncio.create_task(self._consume(), name=self._name)

    async def aclose(self) -> None:
        """Stop accepting, finish what is queued, then cancel the consumer."""
        self._closing = True
        consumer = self._consumer
        if consumer is None:
            return
        try:
            await asyncio.wait_for(self._queue.join(), timeout=self._window_s + 30.0)
        except TimeoutError:  # pragma: no cover - only on a wedged backend
            _log.warning("batcher drain timed out", extra={"batcher": self._name})
        consumer.cancel()
        with suppress(asyncio.CancelledError):
            await consumer
        self._consumer = None

    @property
    def depth(self) -> int:
        """Items waiting for a model call."""
        return self._queue.qsize()

    # -- submission ---------------------------------------------------------

    async def submit(self, item: T) -> Batched[R]:
        """Queue one item and wait for the group it lands in."""
        if self._closing:
            raise BatcherClosedError("the model server is draining")
        self.start()
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Batched[R]] = loop.create_future()
        self._queue.put_nowait((item, time.perf_counter(), future))
        return await future

    # -- the consumer -------------------------------------------------------

    async def _collect(self) -> list[tuple[T, float, asyncio.Future[Batched[R]]]]:
        """The first item, then everything that arrives inside the window."""
        first = await self._queue.get()
        group = [first]
        if self._max_size == 1 or self._window_s <= 0:
            return group
        deadline = time.perf_counter() + self._window_s
        while len(group) < self._max_size:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            try:
                group.append(await asyncio.wait_for(self._queue.get(), timeout=remaining))
            except TimeoutError:
                break
        return group

    async def _consume(self) -> None:
        while True:
            group = await self._collect()
            try:
                await self._dispatch(group)
            finally:
                for _ in group:
                    self._queue.task_done()

    async def _dispatch(self, group: list[tuple[T, float, asyncio.Future[Batched[R]]]]) -> None:
        started = time.perf_counter()
        items = [item for item, _, _ in group]
        try:
            results = await self._run(items)
        except Exception as error:  # one group's failure, re-raised on each of its futures
            for _, _, future in group:
                if not future.done():
                    future.set_exception(error)
            return

        compute_s = time.perf_counter() - started
        if len(results) != len(group):
            mismatch = RuntimeError(
                "batched backend returned "
                + str(len(results))
                + " results for "
                + str(len(group))
                + " requests"
            )
            for _, _, future in group:
                if not future.done():
                    future.set_exception(mismatch)
            return

        for (_, queued_at, future), result in zip(group, results, strict=True):
            if future.done():  # pragma: no cover - only if the caller was cancelled
                continue
            future.set_result(
                Batched(
                    result=result,
                    batch_size=len(group),
                    wait_s=max(0.0, started - queued_at),
                    compute_s=compute_s,
                )
            )
