"""Orchestration for `ai.llm`: build → call (retry) → validate (one repair) → return.

`generate_insight` is the single entry point `worker_ai/processors/llm.py`
calls. It is deliberately provider-registry-agnostic (a plain tuple of
providers in priority order) so a unit test can hand it two fakes and assert
the fallback and repair paths without any network.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from worker_ai.llm.normalize import normalize_insight_output
from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.llm.region import select_region_compliant_provider
from worker_ai.llm.schemas import ValidationOutcome, validate_output
from worker_ai.llm.templates import (
    TEMPLATE_CONFIG,
    TEMPLATE_VERSIONS,
    TranscriptInput,
    build_messages,
)

__all__ = ["AllProvidersFailedError", "InvalidOutputError", "LlmResult", "generate_insight"]

#: Attempts per provider before moving to the next one in priority order.
_MAX_ATTEMPTS_PER_PROVIDER = 2
_BACKOFF_BASE_S = 0.25


class AllProvidersFailedError(RuntimeError):
    """Every configured, region-compliant provider failed."""

    def __init__(self, errors: tuple[str, ...]) -> None:
        super().__init__(f"every LLM provider failed: {'; '.join(errors)}")
        self.errors = errors


class InvalidOutputError(RuntimeError):
    """The provider's output still failed schema validation after one repair attempt."""

    def __init__(self, errors: tuple[str, ...]) -> None:
        super().__init__(f"output failed schema validation twice: {'; '.join(errors)}")
        self.errors = errors


@dataclass(frozen=True, slots=True)
class LlmResult:
    template_id: str
    version: str
    provider: str
    region: str
    endpoint: str
    output: dict[str, Any]
    usage: dict[str, Any]


async def _call_with_retry(provider: LlmProvider, request: LlmRequest) -> Any:
    for attempt in range(_MAX_ATTEMPTS_PER_PROVIDER):
        try:
            return await provider.generate(request)
        except LlmError as error:
            if not error.retryable or attempt == _MAX_ATTEMPTS_PER_PROVIDER - 1:
                raise
            await asyncio.sleep(_BACKOFF_BASE_S * (2**attempt))
    raise LlmError(
        "unreachable: retry loop exited without returning or raising",
        provider=provider.name,
        retryable=False,
    )


async def generate_insight(
    kind: str,
    transcript: TranscriptInput,
    providers: tuple[LlmProvider, ...],
    region: str,
) -> LlmResult:
    """Build the prompt from the registry, call a region-compliant provider with
    retries, validate the output against the schema with one repair attempt.
    """
    version = TEMPLATE_VERSIONS.get(kind)
    if version is None:
        raise ValueError(f"no template registered for kind={kind!r}")
    config = TEMPLATE_CONFIG[kind]
    messages = build_messages(kind, transcript)  # type: ignore[arg-type]

    decision = select_region_compliant_provider(providers, region)
    provider = decision.provider

    request = LlmRequest(
        system=messages.system,
        user=messages.user,
        max_tokens=int(config["maxTokens"]),
        temperature=float(config["temperature"]),
        region=region,
    )

    errors: list[str] = []
    response = None
    # Try the region-compliant providers in the order given, starting from the
    # first that supports the region (already chosen), then the rest that also
    # support it — this is the primary/fallback chain (brief section 2).
    candidates = [p for p in providers if p.supports_region(region)]
    for candidate in candidates:
        try:
            if isinstance(candidate, MockLlmProvider):
                response = candidate.generate_for(kind, transcript)
            else:
                response = await _call_with_retry(candidate, request)
            provider = candidate
            break
        except LlmError as error:
            errors.append(f"{candidate.name}: {error}")
            continue

    if response is None:
        raise AllProvidersFailedError(tuple(errors))

    outcome = _parse_and_validate(kind, response.text, provider.name)
    if not outcome.ok:
        # One repair attempt: ask the SAME provider to fix the specific errors.
        # A small local model (Ollama, M20 free-stack mode) that got cut off
        # mid-JSON needs a different instruction than one that just missed a
        # schema constraint, so the repair message and token budget both
        # branch on that -- everything else about the retry is unchanged.
        if provider.name == "ollama" and _looks_truncated(outcome.errors):
            repair_user = (
                f"{messages.user}\n\n<repair>\nYour previous reply was cut off before the "
                "JSON finished. Reply again with ONLY complete, valid JSON, no prose, no "
                "markdown fences. Keep the entire reply under 150 words so it fits."
                "\n</repair>"
            )
            repair_max_tokens = max(int(config["maxTokens"]), _MIN_OLLAMA_REPAIR_TOKENS)
        else:
            repair_user = (
                f"{messages.user}\n\n<repair>\nYour previous reply did not match the "
                f"required JSON schema. Errors: {'; '.join(outcome.errors)}. "
                "Reply again with corrected strict JSON only, same shape as requested."
                "\n</repair>"
            )
            repair_max_tokens = int(config["maxTokens"])
        repair_request = LlmRequest(
            system=messages.system,
            user=repair_user,
            max_tokens=repair_max_tokens,
            temperature=float(config["temperature"]),
            region=region,
        )
        try:
            if isinstance(provider, MockLlmProvider):
                repaired = provider.generate_for(kind, transcript)
            else:
                repaired = await _call_with_retry(provider, repair_request)
        except LlmError as error:
            raise InvalidOutputError((*outcome.errors, str(error))) from error
        outcome = _parse_and_validate(kind, repaired.text, provider.name)
        if not outcome.ok:
            raise InvalidOutputError(outcome.errors)
        response = repaired

    if outcome.value is None:
        # Unreachable: every path above either raised or left `outcome.ok is
        # True`, and `validate_output` always sets `value` when `ok` is True.
        raise InvalidOutputError(("output missing after successful validation",))
    return LlmResult(
        template_id=kind,
        version=version,
        provider=provider.name,
        region=region,
        endpoint=response.endpoint,
        output=outcome.value,
        usage={
            "inputTokens": response.usage.input_tokens,
            "outputTokens": response.usage.output_tokens,
            "costMinor": response.usage.cost_minor,
            "currency": response.usage.currency,
        },
    )


#: A repair prompt for a truncated Ollama reply asks for a short reply, but
#: still needs headroom for the schema's largest fields (`summary.long` <=
#: 1200 chars) plus JSON structure overhead.
_MIN_OLLAMA_REPAIR_TOKENS = 2_048

#: Substrings `json.JSONDecodeError` uses for a reply that ran out of tokens
#: mid-value, as opposed to one that is simply the wrong shape.
_TRUNCATION_MARKERS = ("unterminated", "expecting")


def _looks_truncated(errors: tuple[str, ...]) -> bool:
    return any(
        error.lower().startswith("invalid json")
        and any(marker in error.lower() for marker in _TRUNCATION_MARKERS)
        for error in errors
    )


def _parse_and_validate(kind: str, text: str, provider_name: str = "") -> ValidationOutcome:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as error:
        return ValidationOutcome(ok=False, errors=(f"invalid JSON: {error}",), value=None)
    if not isinstance(raw, dict):
        return ValidationOutcome(ok=False, errors=("output is not a JSON object",), value=None)
    if provider_name == "ollama":
        # Small-model output normalisation (M20 increment 2b): a hosted
        # provider's output is validated as-is, unchanged from before this
        # existed.
        raw = normalize_insight_output(kind, raw)
    return validate_output(kind, raw)  # type: ignore[arg-type]
