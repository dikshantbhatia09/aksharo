"""The daily budget on the paid model (`worker_ai.llm.budget`, `pricing.py`)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from worker_ai.llm.budget import (
    BudgetedLlmProvider,
    BudgetExhaustedError,
    MemorySpendLedger,
    RedisSpendLedger,
)
from worker_ai.llm.calls import Deadline, complete_json
from worker_ai.llm.pricing import LLM_PRICES_INR_PER_MILLION_TOKENS, call_cost_inr, inr_to_paise
from worker_ai.llm.providers.base import LlmRequest, LlmUsage
from worker_ai.llm.service import generate_insight
from worker_ai.llm.templates import TranscriptInput, TranscriptSegment

from .fake_llm import FakeLlm

REQUEST = LlmRequest(system="s", user="u", max_tokens=100, temperature=0.1)


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def paid(reply: str = '{"ok": true}', **kwargs: Any) -> FakeLlm:
    return FakeLlm(
        lambda _request: reply,
        name="sarvam",
        model="sarvam-105b-conversations",
        regions=frozenset({"in"}),
        usage=LlmUsage(input_tokens=1_000_000, output_tokens=1_000_000),
        **kwargs,
    )


def test_the_price_is_one_constant_and_only_sarvam_costs_money() -> None:
    price = LLM_PRICES_INR_PER_MILLION_TOKENS["sarvam"]
    assert (price.input_inr, price.output_inr) == (29.28, 73.2)
    usage = LlmUsage(input_tokens=2_000, output_tokens=500)
    assert call_cost_inr("sarvam", usage) == pytest.approx(2_000 * 29.28e-6 + 500 * 73.2e-6)
    assert call_cost_inr("ollama", usage) == 0.0
    assert call_cost_inr("mock", usage) == 0.0
    assert inr_to_paise(0.0951) == 10


async def test_the_memory_ledger_counts_per_utc_day() -> None:
    clock = Clock(datetime(2026, 9, 29, 23, 0, tzinfo=UTC))
    ledger = MemorySpendLedger(clock=clock)
    await ledger.add(1.25)
    await ledger.add(0.5)
    assert await ledger.spent_today() == pytest.approx(1.75)
    clock.now = datetime(2026, 9, 30, 0, 5, tzinfo=UTC)
    assert await ledger.spent_today() == 0.0


class FakeRedis:
    def __init__(self, *, fail: bool = False) -> None:
        self.values: dict[str, int] = {}
        self.ttls: dict[str, int] = {}
        self.fail = fail

    async def get(self, key: str) -> str | None:
        if self.fail:
            raise ConnectionError("redis is down")
        value = self.values.get(key)
        return None if value is None else str(value)

    async def incrby(self, key: str, amount: int) -> int:
        if self.fail:
            raise ConnectionError("redis is down")
        self.values[key] = self.values.get(key, 0) + amount
        return self.values[key]

    async def expire(self, key: str, seconds: int) -> bool:
        self.ttls[key] = seconds
        return True


async def test_the_redis_ledger_keeps_micro_rupees_under_a_dated_key() -> None:
    client = FakeRedis()
    clock = Clock(datetime(2026, 9, 29, 10, 0, tzinfo=UTC))
    ledger = RedisSpendLedger("redis://x", client=client, clock=clock)

    assert await ledger.spent_today() == 0.0
    assert await ledger.add(0.123456) == pytest.approx(0.123456)
    assert client.values == {"montaj:llm:spend:v1:2026-09-29": 123_456}
    assert client.ttls["montaj:llm:spend:v1:2026-09-29"] == 3 * 24 * 60 * 60
    assert await ledger.spent_today() == pytest.approx(0.123456)


async def test_under_budget_the_call_is_made_and_counted() -> None:
    ledger = MemorySpendLedger()
    inner = paid()
    provider = BudgetedLlmProvider(inner, ledger=ledger, daily_budget_inr=300)

    response = await provider.generate(REQUEST)

    assert json.loads(response.text) == {"ok": True}
    assert len(inner.requests) == 1
    assert await ledger.spent_today() == pytest.approx(102.48)
    assert response.usage.cost_minor == 10_248
    # The wrapper stands in for the provider everywhere a name or region is read.
    assert (provider.name, provider.model) == ("sarvam", "sarvam-105b-conversations")
    assert provider.supports_region("in") and not provider.supports_region("eu")


async def test_once_the_budget_is_spent_no_paid_call_is_made() -> None:
    ledger = MemorySpendLedger()
    await ledger.add(300.0)
    inner = paid()
    provider = BudgetedLlmProvider(inner, ledger=ledger, daily_budget_inr=300)

    with pytest.raises(BudgetExhaustedError) as excinfo:
        await provider.generate(REQUEST)
    assert excinfo.value.retryable is False
    assert inner.requests == []


async def test_a_zero_budget_turns_the_paid_model_off() -> None:
    inner = paid()
    provider = BudgetedLlmProvider(inner, ledger=MemorySpendLedger(), daily_budget_inr=0)
    with pytest.raises(BudgetExhaustedError):
        await provider.generate(REQUEST)
    assert inner.requests == []


async def test_an_unreadable_tally_fails_closed() -> None:
    inner = paid()
    ledger = RedisSpendLedger("redis://x", client=FakeRedis(fail=True))
    provider = BudgetedLlmProvider(inner, ledger=ledger, daily_budget_inr=300)
    with pytest.raises(BudgetExhaustedError):
        await provider.generate(REQUEST)
    assert inner.requests == []


async def test_a_spent_budget_hands_the_call_to_the_free_fallback() -> None:
    ledger = MemorySpendLedger()
    await ledger.add(301.0)
    sarvam = BudgetedLlmProvider(paid('{"by": "sarvam"}'), ledger=ledger, daily_budget_inr=300)
    ollama = FakeLlm(lambda _request: '{"by": "ollama"}', name="ollama", model="qwen2.5:3b")

    reply = await complete_json(
        (sarvam, ollama), lambda _provider: REQUEST, what="test", deadline=Deadline(60)
    )

    assert reply is not None
    assert reply.value == {"by": "ollama"}
    assert (reply.provider, reply.model) == ("ollama", "qwen2.5:3b")


async def test_the_insights_templates_fall_through_a_spent_budget_too() -> None:
    ledger = MemorySpendLedger()
    await ledger.add(500.0)
    sarvam = BudgetedLlmProvider(paid(), ledger=ledger, daily_budget_inr=300)
    ollama = FakeLlm(
        lambda _request: {"chapters": [{"startMs": 0, "title": "Shuruaat"}]},
        name="ollama",
        model="qwen2.5:3b",
    )
    transcript = TranscriptInput(
        language="hi-Latn",
        duration_ms=10_000,
        segments=(TranscriptSegment(0, 10_000, "aaj hum paise ki baat karenge"),),
    )

    result = await generate_insight("chapters", transcript, (sarvam, ollama), "in")

    assert result.provider == "ollama"
    assert result.output["chapters"][0]["title"] == "Shuruaat"
