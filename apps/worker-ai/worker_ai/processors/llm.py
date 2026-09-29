"""``ai.llm`` — chapters, summary, hooks/titles/hashtags (B11), and the episode pack.

Like ``ai.translate``, this processor is stateless: the producer
(``POST /projects/{id}/insights``) hands it the transcript text (language +
segments + optional media title — PII minimisation, brief section 2), the
workspace's region and which kind to generate. Nothing is read from the
database here; the completion (``apps/api/src/insights``) persists the result
to ``llm_outputs``.

``episode-pack`` (2026-09-29) is the text a creator posts with a whole video
(`worker_ai.llm.episode_pack`), written for a clips run's source video at no
charge to the person. Unlike the other kinds it never fails for the model's
sake: what the model cannot write is written by rule from the transcript.
"""

from __future__ import annotations

from typing import Any, Final

from worker_ai.callbacks import JobUsage
from worker_ai.llm.calls import CallLedger, model_chain
from worker_ai.llm.episode_pack import EPISODE_PACK_TEMPLATE_VERSION, write_episode_pack
from worker_ai.llm.pricing import inr_to_paise
from worker_ai.llm.region import RegionBlockedError
from worker_ai.llm.service import AllProvidersFailedError, InvalidOutputError, generate_insight
from worker_ai.llm.templates import TranscriptInput, transcript_from_payload
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.providers.base import ProviderSubmission

__all__ = ["process_llm"]

_log = get_logger(__name__)

_EPISODE_PACK: Final[str] = "episode-pack"
_VALID_KINDS = {"chapters", "summary", "hooks", _EPISODE_PACK}
_SCRIPT_MODES = {"auto", "roman", "native", "bilingual"}


def _retention(provider: str, no_training: bool) -> str:
    # Enforced "no training" providers get zero-retention; the mock, or a
    # provider with no signed terms saying so (Sarvam), is recorded under the
    # vendor's default rather than promising a class the worker cannot verify.
    return "zero_retention" if no_training and provider != "mock" else "vendor_default"


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

    if kind == _EPISODE_PACK:
        return await _process_episode_pack(context, region, transcript)

    await context.progress(10, message=f"building {kind} prompt")

    try:
        result = await generate_insight(kind, transcript, context.services.llm_providers, region)
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
                retention_class=_retention(result.provider, result.no_training),
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


async def _process_episode_pack(
    context: JobContext, region: str, transcript: TranscriptInput
) -> ProcessorOutcome:
    copy = context.envelope.payload.get("copy")
    copy_options = copy if isinstance(copy, dict) else {}
    language = copy_options.get("language")
    script_mode = copy_options.get("scriptMode")

    await context.progress(10, message="Writing the episode text")
    ledger = CallLedger()
    pack_language = (
        language if isinstance(language, str) and language.strip() else transcript.language
    )
    pack_script = script_mode if script_mode in _SCRIPT_MODES else "auto"
    try:
        pack = await write_episode_pack(
            transcript,
            language=pack_language,
            script_mode=pack_script,
            chain=model_chain(context.services.llm_providers, region),
            ledger=ledger,
        )
    except Exception:
        # Whatever went wrong on the model's side, the pack is written by rule.
        _log.exception("the episode text failed with the language model; writing it by rule")
        pack = await write_episode_pack(
            transcript, language=pack_language, script_mode=pack_script, chain=()
        )

    context.record(
        tuple(
            ProviderSubmission(
                provider=name,
                endpoint=use.endpoint,
                artefact="llm_output",
                region=region,
                retention_class=_retention(name, use.no_training),
            )
            for name, use in ledger.providers.items()
        )
    )
    await context.progress(100, message="done")

    paid = ledger.paid_provider
    cost_minor = inr_to_paise(ledger.cost_inr)
    output: dict[str, Any] = {
        "templateId": _EPISODE_PACK,
        "version": EPISODE_PACK_TEMPLATE_VERSION,
        "provider": pack.provider,
        "region": region,
        "output": pack.output,
        "usage": {
            "inputTokens": ledger.input_tokens,
            "outputTokens": ledger.output_tokens,
            "costMinor": cost_minor,
            "currency": "INR",
            **({} if not pack.model else {"model": pack.model}),
        },
        "providerSubmissions": context.submissions_wire(),
    }
    usage = (
        None
        if paid is None
        else JobUsage(provider=paid[0], model=paid[1] or None, cost_minor=cost_minor)
    )
    return ProcessorOutcome(result=output, usage=usage)
