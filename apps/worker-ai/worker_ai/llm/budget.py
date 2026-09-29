"""A daily spending limit on the paid language model (2026-09-29).

``LLM_DAILY_BUDGET_INR`` (default ₹300) caps what the paid provider may cost in
one UTC day, across every job and every worker process. Each call's cost is
worked out from its tokens (`pricing.py`) and added to a per-day tally in Redis
(the same Redis BullMQ runs on). Once the tally reaches the budget, the paid
provider refuses every further call until midnight UTC, and the chain moves on
to the free fallback: nothing waits and nothing fails because of the limit.

The check comes before the call and the tally after it, so calls already in
flight when the limit is crossed still land: the day can overshoot by a few
calls (a paisa or two each), never by a job's worth.

Redis unreachable means the day's spend cannot be known, and the paid provider
is skipped rather than trusted: a limit that fails open is not a limit.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Final

from worker_ai.llm.pricing import call_cost_inr, inr_to_paise
from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmResponse, LlmUsage
from worker_ai.logging_setup import get_logger

__all__ = [
    "BudgetExhaustedError",
    "BudgetedLlmProvider",
    "MemorySpendLedger",
    "RedisSpendLedger",
    "SpendLedger",
    "utc_day",
]

_log = get_logger(__name__)

#: One key per UTC day. Micro-rupees, so the tally is an integer INCRBY.
_KEY_PREFIX: Final[str] = "montaj:llm:spend:v1:"
_MICRO: Final[int] = 1_000_000
#: Long enough to read yesterday's figure in the morning, short enough to go.
_KEY_TTL_S: Final[int] = 3 * 24 * 60 * 60


def utc_day(now: datetime) -> str:
    return now.astimezone(UTC).date().isoformat()


class SpendLedger(ABC):
    """Rupees spent on the paid model today (UTC)."""

    @abstractmethod
    async def spent_today(self) -> float:
        """Today's spend. :raises Exception: when it cannot be read."""
        raise NotImplementedError

    @abstractmethod
    async def add(self, inr: float) -> float:
        """Add a call's cost to today's spend; the new total."""
        raise NotImplementedError


class MemorySpendLedger(SpendLedger):
    """One process's tally: tests, and a worker with no Redis configured."""

    def __init__(self, *, clock: Callable[[], datetime] | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(UTC))
        self._micro: dict[str, int] = {}

    async def spent_today(self) -> float:
        return self._micro.get(utc_day(self._clock()), 0) / _MICRO

    async def add(self, inr: float) -> float:
        day = utc_day(self._clock())
        self._micro[day] = self._micro.get(day, 0) + max(0, round(inr * _MICRO))
        return self._micro[day] / _MICRO


class RedisSpendLedger(SpendLedger):
    """The tally every worker process shares, one key per UTC day."""

    def __init__(
        self,
        redis_url: str,
        *,
        client: Any = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._url = redis_url
        self._client = client
        self._clock = clock or (lambda: datetime.now(UTC))

    def _connect(self) -> Any:
        if self._client is None:
            from redis.asyncio import Redis

            self._client = Redis.from_url(self._url, decode_responses=True)
        return self._client

    def _key(self) -> str:
        return _KEY_PREFIX + utc_day(self._clock())

    async def spent_today(self) -> float:
        raw = await self._connect().get(self._key())
        if raw is None:
            return 0.0
        return int(raw) / _MICRO

    async def add(self, inr: float) -> float:
        key = self._key()
        client = self._connect()
        total = await client.incrby(key, max(0, round(inr * _MICRO)))
        await client.expire(key, _KEY_TTL_S)
        return int(total) / _MICRO


class BudgetExhaustedError(LlmError):
    """Today's paid-model budget is spent; the chain moves on to the fallback."""

    def __init__(self, provider: str, message: str) -> None:
        super().__init__(message, provider=provider, retryable=False)


class BudgetedLlmProvider(LlmProvider):
    """A paid provider behind the daily budget: the same calls, counted."""

    def __init__(
        self,
        inner: LlmProvider,
        *,
        ledger: SpendLedger,
        daily_budget_inr: float,
    ) -> None:
        self.inner = inner
        self.name = inner.name
        self.supported_regions = inner.supported_regions
        self.no_training = inner.no_training
        self.model = inner.model
        self.max_prompt_chars = inner.max_prompt_chars
        self._ledger = ledger
        self._budget_inr = max(0.0, daily_budget_inr) if math.isfinite(daily_budget_inr) else 0.0

    @property
    def daily_budget_inr(self) -> float:
        return self._budget_inr

    async def generate(self, request: LlmRequest) -> LlmResponse:
        try:
            spent = await self._ledger.spent_today()
        except Exception as error:  # the spend cannot be known: do not spend
            _log.warning(
                "llm budget unreadable; skipping the paid model",
                extra={"provider": self.name, "reason": str(error)[:200]},
            )
            raise BudgetExhaustedError(self.name, "today's LLM spend could not be read") from error
        if spent >= self._budget_inr:
            _log.info(
                "llm daily budget reached; using the fallback",
                extra={
                    "provider": self.name,
                    "spentInr": round(spent, 2),
                    "budgetInr": self._budget_inr,
                },
            )
            raise BudgetExhaustedError(
                self.name, f"today's LLM budget of Rs {self._budget_inr:g} is spent"
            )

        response = await self.inner.generate(request)
        cost = call_cost_inr(self.name, response.usage)
        try:
            total = await self._ledger.add(cost)
        except Exception as error:  # the call happened; only the tally is lost
            _log.warning(
                "llm spend could not be recorded",
                extra={
                    "provider": self.name,
                    "costInr": round(cost, 4),
                    "reason": str(error)[:200],
                },
            )
            total = spent + cost
        _log.info(
            "llm call",
            extra={
                "provider": self.name,
                "model": self.model,
                "inputTokens": response.usage.input_tokens,
                "outputTokens": response.usage.output_tokens,
                "costInr": round(cost, 4),
                "spentTodayInr": round(total, 2),
                "budgetInr": self._budget_inr,
            },
        )
        if response.usage.cost_minor is None:
            usage = response.usage
            response = LlmResponse(
                text=response.text,
                usage=LlmUsage(
                    input_tokens=usage.input_tokens,
                    output_tokens=usage.output_tokens,
                    cost_minor=inr_to_paise(cost),
                    currency=usage.currency,
                ),
                endpoint=response.endpoint,
            )
        return response

    async def aclose(self) -> None:
        await self.inner.aclose()
