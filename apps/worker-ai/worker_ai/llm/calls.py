"""One JSON answer from the first provider in the chain that gives a usable one.

The insights templates (`service.py`) fail their job when every provider fails,
because the person asked for that output and can ask again. The features built
on this module (the highlight ranking, clip copy, the episode text) are parts of
a run, and a run must never fail because of the model: :func:`complete_json`
returns ``None`` when nothing usable came back, and each caller then answers by
its own rules instead.

What counts as a failure, and moves the call on to the next provider: an HTTP
error or a timeout (after the provider's own retry), the day's budget being
spent (`budget.py`), a reply with no JSON object in it, or one the caller's
``accept`` refuses. The mock is never part of such a chain: it cannot judge a
moment or write a caption, and a deployment with only the mock simply takes the
rule-based answer.

Every call is also bounded by a :class:`Deadline` shared by the whole job, so a
slow local model on a busy GPU cannot hold a run's discovery for longer than
its budget of minutes: past it, calls are not made and the callers answer by
rule.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from worker_ai.llm.json_reply import extract_json_object
from worker_ai.llm.pricing import call_cost_inr
from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmUsage
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.logging_setup import get_logger

__all__ = [
    "CallLedger",
    "Deadline",
    "JsonReply",
    "ProviderUse",
    "complete_json",
    "model_chain",
]

_log = get_logger(__name__)

#: Attempts per provider for a retryable error (a 429, a 5xx, a dropped
#: connection) before the chain moves on.
_ATTEMPTS_PER_PROVIDER = 2
_BACKOFF_S = 0.5


def model_chain(providers: Sequence[LlmProvider], region: str) -> tuple[LlmProvider, ...]:
    """The providers that may take this workspace's words and can actually judge.

    Region pinning is the same rule as `region.py`: a provider that does not
    serve the workspace's region is skipped (an EU workspace never reaches an
    Indian endpoint). An unknown region leaves nothing, which means the
    rule-based answer: failing closed.
    """
    return tuple(
        provider
        for provider in providers
        if not isinstance(provider, MockLlmProvider) and provider.supports_region(region)
    )


class Deadline:
    """How long the model may still take, for everything one job asks of it."""

    def __init__(self, seconds: float, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._ends = clock() + max(0.0, seconds)

    def remaining(self) -> float:
        return max(0.0, self._ends - self._clock())

    @property
    def passed(self) -> bool:
        return self.remaining() <= 0.0


@dataclass(frozen=True, slots=True)
class JsonReply:
    value: dict[str, Any]
    provider: str
    model: str
    usage: LlmUsage


@dataclass(frozen=True, slots=True)
class ProviderUse:
    """A provider one job's words went to: for its `provider_submissions` rows."""

    model: str
    endpoint: str
    no_training: bool


@dataclass(slots=True)
class CallLedger:
    """What one job's model calls used: for its usage line and its logs."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_inr: float = 0.0
    providers: dict[str, ProviderUse] = field(default_factory=dict)

    def record(self, provider: LlmProvider, usage: LlmUsage, endpoint: str = "") -> None:
        self.calls += 1
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens
        self.cost_inr += call_cost_inr(provider.name, usage)
        self.providers.setdefault(
            provider.name,
            ProviderUse(model=provider.model, endpoint=endpoint, no_training=provider.no_training),
        )

    @property
    def paid_provider(self) -> tuple[str, str] | None:
        """``(name, model)`` of the provider that cost money, else the first used."""
        for name, use in self.providers.items():
            if call_cost_inr(name, LlmUsage(input_tokens=1_000_000)) > 0:
                return name, use.model
        first = next(iter(self.providers.items()), None)
        return None if first is None else (first[0], first[1].model)


async def complete_json(
    chain: Sequence[LlmProvider],
    request_for: Callable[[LlmProvider], LlmRequest],
    *,
    what: str,
    deadline: Deadline,
    accept: Callable[[dict[str, Any]], bool] | None = None,
    ledger: CallLedger | None = None,
) -> JsonReply | None:
    """The first usable JSON object from ``chain``, or ``None``.

    ``request_for`` builds the request per provider, so a caller can send a
    local model a shorter prompt than a hosted one. ``what`` names the call in
    the logs ("highlight judgements"), never its content.
    """
    for provider in chain:
        if deadline.passed:
            _log.warning("llm deadline passed; answering by rule", extra={"what": what})
            return None
        request = request_for(provider)
        try:
            response = await _call(provider, request, deadline)
        except LlmError as error:
            _log.warning(
                "llm call failed; trying the next provider",
                extra={"what": what, "provider": provider.name, "reason": str(error)[:200]},
            )
            continue
        if ledger is not None:
            ledger.record(provider, response.usage, response.endpoint)
        value = extract_json_object(response.text)
        if value is None or (accept is not None and not accept(value)):
            _log.warning(
                "llm reply unusable; trying the next provider",
                extra={
                    "what": what,
                    "provider": provider.name,
                    "reason": "no JSON object" if value is None else "refused by its checks",
                },
            )
            continue
        return JsonReply(
            value=value, provider=provider.name, model=provider.model, usage=response.usage
        )
    return None


async def _call(provider: LlmProvider, request: LlmRequest, deadline: Deadline) -> Any:
    for attempt in range(_ATTEMPTS_PER_PROVIDER):
        remaining = deadline.remaining()
        if remaining <= 0:
            raise LlmError("deadline passed", provider=provider.name, retryable=False)
        try:
            return await asyncio.wait_for(provider.generate(request), timeout=remaining)
        except TimeoutError as error:
            raise LlmError(
                "deadline passed mid-call", provider=provider.name, retryable=False
            ) from error
        except LlmError as error:
            if not error.retryable or attempt == _ATTEMPTS_PER_PROVIDER - 1:
                raise
        await asyncio.sleep(min(_BACKOFF_S * (2**attempt), deadline.remaining()))
    raise LlmError("unreachable", provider=provider.name, retryable=False)  # pragma: no cover
