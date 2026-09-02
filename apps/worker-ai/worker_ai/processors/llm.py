"""``ai.llm`` — chapters, summary, hooks/titles/hashtags (B11).

Like ``ai.translate``, this processor is stateless: the producer
(``POST /projects/{id}/insights``) hands it the transcript text (language +
segments + optional media title — PII minimisation, brief section 2), the
workspace's region and which kind to generate. Nothing is read from the
database here; the completion (``apps/api/src/insights``) persists the result
to ``llm_outputs``.
"""

from __future__ import annotations

from typing import Any

from worker_ai.llm.region import RegionBlockedError
from worker_ai.llm.service import AllProvidersFailedError, InvalidOutputError, generate_insight
from worker_ai.llm.templates import transcript_from_payload
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.providers.base import ProviderSubmission

__all__ = ["process_llm"]

_VALID_KINDS = {"chapters", "summary", "hooks"}


async def process_llm(context: JobContext) -> ProcessorOutcome:
    kind = context.payload_str("kind", required=True)
    if kind not in _VALID_KINDS:
        raise JobFailureError(
            "worker/invalid_payload",
            f"ai.llm kind must be one of {sorted(_VALID_KINDS)}, got {kind!r}",
            retryable=False,
        )
    region = context.payload_str("region", default="in") or "in"
    transcript_raw = context.envelope.payload.get("transcript")
    if not isinstance(transcript_raw, dict):
        raise JobFailureError(
            "worker/invalid_payload", "ai.llm needs a transcript object", retryable=False
        )

    try:
        transcript = transcript_from_payload(transcript_raw)
    except (KeyError, TypeError, ValueError) as error:
        raise JobFailureError(
            "worker/invalid_payload", f"ai.llm transcript is malformed: {error}", retryable=False
        ) from error

    await context.progress(10, message=f"building {kind} prompt")

    try:
        result = await generate_insight(
            kind, transcript, context.services.llm_providers, region
        )
    except RegionBlockedError as error:
        raise JobFailureError("worker/region_not_supported", str(error), retryable=False) from error
    except AllProvidersFailedError as error:
        raise JobFailureError("worker/llm_provider_failed", str(error), retryable=True) from error
    except InvalidOutputError as error:
        raise JobFailureError("worker/llm_invalid_output", str(error), retryable=False) from error

    context.record(
        (
            ProviderSubmission(
                provider=result.provider,
                endpoint=result.endpoint,
                artefact="llm_output",
                region=result.region,
                # Enforced "no training" providers get zero-retention; an
                # unrecognised/local one defaults to vendor_default rather than
                # promising a retention class the worker cannot verify.
                retention_class="zero_retention" if result.provider != "mock" else "vendor_default",
            ),
        )
    )

    await context.progress(100, message="done")

    output: dict[str, Any] = {
        "templateId": result.template_id,
        "version": result.version,
        "provider": result.provider,
        "region": result.region,
        "output": result.output,
        "usage": result.usage,
        "providerSubmissions": context.submissions_wire(),
    }
    return ProcessorOutcome(result=output)
