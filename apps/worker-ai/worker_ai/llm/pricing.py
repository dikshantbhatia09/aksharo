"""What a language-model call costs, in rupees, from the tokens it used.

One table, so the daily budget (`budget.py`), the job's `costMinor` and the logs
can never disagree about a price. A provider missing from it costs nothing: a
local model (Ollama) runs on this machine, and the mock is not a call at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from worker_ai.llm.providers.base import LlmUsage

__all__ = [
    "LLM_PRICES_INR_PER_MILLION_TOKENS",
    "TokenPrice",
    "call_cost_inr",
    "inr_to_paise",
]


@dataclass(frozen=True, slots=True)
class TokenPrice:
    """Rupees per million tokens, sent and received."""

    input_inr: float
    output_inr: float


#: Sarvam's list price for its chat models (checked 2026-09-29): ₹29.28 per
#: million input tokens and ₹73.2 per million output tokens.
LLM_PRICES_INR_PER_MILLION_TOKENS: Final[dict[str, TokenPrice]] = {
    "sarvam": TokenPrice(input_inr=29.28, output_inr=73.2),
}


def call_cost_inr(provider: str, usage: LlmUsage) -> float:
    """The call's cost in rupees; zero for a provider with no price."""
    price = LLM_PRICES_INR_PER_MILLION_TOKENS.get(provider)
    if price is None:
        return 0.0
    return (
        max(0, usage.input_tokens) * price.input_inr
        + max(0, usage.output_tokens) * price.output_inr
    ) / 1_000_000


def inr_to_paise(inr: float) -> int:
    """Whole paise, rounded half up: the ``costMinor`` a job row carries."""
    return int(inr * 100 + 0.5)
