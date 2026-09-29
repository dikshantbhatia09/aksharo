"""Builds the priority-ordered `LlmProvider` chain from `Settings` (brief section 2:
"adapters for Anthropic (primary) ... and one fallback").

`LLM_PROVIDER=mock` (the default, and CI's path — brief section 6) short-circuits
to the mock only, so a deployment with no vendor key still runs the queue, the
same precedent `WORKER_AI_ALLOW_MOCK` set for ASR.

2026-09-29: `LLM_PROVIDER=sarvam` puts Sarvam's chat model first, behind the
daily rupee budget (`budget.py`), then `LLM_FALLBACK_PROVIDER` (default
`ollama`: `LLM_FALLBACK_MODEL` on the local server at `LLM_BASE_URL`). Without
`SARVAM_API_KEY` the chain is the fallback alone. A caller that needs an answer
whatever happens (the highlight ranking, clip copy, the episode text) falls
back past the chain to its own rule-based answer, so no run ever fails because
of the model.
"""

from __future__ import annotations

from worker_ai.llm.budget import BudgetedLlmProvider, MemorySpendLedger, RedisSpendLedger
from worker_ai.llm.providers.anthropic import AnthropicLlmProvider
from worker_ai.llm.providers.base import LlmProvider
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.llm.providers.ollama import OllamaLlmProvider
from worker_ai.llm.providers.openai import OpenAiLlmProvider
from worker_ai.llm.providers.sarvam import SARVAM_LLM_DEFAULT_BASE_URL, SarvamLlmProvider
from worker_ai.logging_setup import get_logger
from worker_ai.settings import Settings

__all__ = ["build_llm_providers"]

_log = get_logger(__name__)

#: Sarvam models that reason before they answer: every call is paid for and
#: comes back empty, so the chain would pay and then fall through every time.
_REASONING_MODELS = frozenset({"sarvam-105b"})


def build_llm_providers(settings: Settings) -> tuple[LlmProvider, ...]:
    """Primary first, fallback second — `service.py` tries them in this order."""
    if settings.llm_provider == "mock":
        return (MockLlmProvider(),)

    providers: list[LlmProvider] = []
    if settings.llm_provider == "ollama":
        # No key required (M20 free-stack mode) — always constructible, so this
        # branch never falls through to the mock-on-no-key path below.
        providers.append(
            OllamaLlmProvider(base_url=settings.llm_base_url, model=settings.llm_model)
        )
    elif settings.llm_provider == "sarvam":
        if settings.sarvam_api_key:
            providers.append(_budgeted_sarvam(settings))
        else:
            _log.warning("LLM_PROVIDER=sarvam without SARVAM_API_KEY: using the fallback only")
    elif settings.llm_provider == "anthropic":
        if settings.anthropic_api_key:
            providers.append(AnthropicLlmProvider(api_key=settings.anthropic_api_key))
        if settings.openai_api_key:
            providers.append(OpenAiLlmProvider(api_key=settings.openai_api_key))
    elif settings.llm_provider == "openai":
        if settings.openai_api_key:
            providers.append(OpenAiLlmProvider(api_key=settings.openai_api_key))
        if settings.anthropic_api_key:
            providers.append(AnthropicLlmProvider(api_key=settings.anthropic_api_key))

    if settings.llm_provider == "sarvam":
        # The fallback is what a sarvam deployment runs on once the day's
        # budget is spent. For the others it is only added when nothing else
        # was configured: an anthropic/openai chain keeps the shape it had.
        fallback = _fallback(settings)
        if fallback is not None:
            providers.append(fallback)

    if not providers:
        # No key configured for the requested provider: fail closed to the mock
        # rather than silently making real calls with no credential.
        return (MockLlmProvider(),)
    # One line at boot that says what will be called, in order, and the cap:
    # the check after a deploy that the environment took.
    _log.info(
        "llm chain",
        extra={
            "chain": [f"{provider.name}:{provider.model}" for provider in providers],
            "dailyBudgetInr": settings.llm_daily_budget_inr,
        },
    )
    return tuple(providers)


def _budgeted_sarvam(settings: Settings) -> LlmProvider:
    if settings.llm_model in _REASONING_MODELS:
        _log.warning(
            "LLM_MODEL is a reasoning model: it answers with no content, so every call "
            "is paid for and then falls back",
            extra={"model": settings.llm_model},
        )
    sarvam = SarvamLlmProvider(
        settings.sarvam_api_key,
        base_url=settings.sarvam_base_url or SARVAM_LLM_DEFAULT_BASE_URL,
        model=settings.llm_model,
    )
    ledger = RedisSpendLedger(settings.redis_url) if settings.redis_url else MemorySpendLedger()
    return BudgetedLlmProvider(
        sarvam, ledger=ledger, daily_budget_inr=settings.llm_daily_budget_inr
    )


def _fallback(settings: Settings) -> LlmProvider | None:
    if settings.llm_fallback_provider == "ollama":
        return OllamaLlmProvider(base_url=settings.llm_base_url, model=settings.llm_fallback_model)
    return None
