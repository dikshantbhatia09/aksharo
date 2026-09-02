"""Builds the priority-ordered `LlmProvider` chain from `Settings` (brief section 2:
"adapters for Anthropic (primary) ... and one fallback").

`LLM_PROVIDER=mock` (the default, and CI's path — brief section 6) short-circuits
to the mock only, so a deployment with no vendor key still runs the queue, the
same precedent `WORKER_AI_ALLOW_MOCK` set for ASR.
"""

from __future__ import annotations

from worker_ai.llm.providers.anthropic import AnthropicLlmProvider
from worker_ai.llm.providers.base import LlmProvider
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.llm.providers.openai import OpenAiLlmProvider
from worker_ai.settings import Settings

__all__ = ["build_llm_providers"]


def build_llm_providers(settings: Settings) -> tuple[LlmProvider, ...]:
    """Primary first, fallback second — `service.py` tries them in this order."""
    if settings.llm_provider == "mock":
        return (MockLlmProvider(),)

    providers: list[LlmProvider] = []
    if settings.llm_provider == "anthropic":
        if settings.anthropic_api_key:
            providers.append(AnthropicLlmProvider(api_key=settings.anthropic_api_key))
        if settings.openai_api_key:
            providers.append(OpenAiLlmProvider(api_key=settings.openai_api_key))
    elif settings.llm_provider == "openai":
        if settings.openai_api_key:
            providers.append(OpenAiLlmProvider(api_key=settings.openai_api_key))
        if settings.anthropic_api_key:
            providers.append(AnthropicLlmProvider(api_key=settings.anthropic_api_key))

    if not providers:
        # No key configured for the requested provider: fail closed to the mock
        # rather than silently making real calls with no credential.
        return (MockLlmProvider(),)
    return tuple(providers)
