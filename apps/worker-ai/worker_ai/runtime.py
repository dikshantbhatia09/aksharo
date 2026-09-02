"""The worker runtime: one handler per queue, and the retry contract with A08.

## Callback semantics

```
job arrives -> progress(0)            -> the API flips the row to `running`
             -> processor runs        -> progress(...) throttled
             -> complete(succeeded)   -> the API settles credits and fans out
```

The API is idempotent on ``(jobId, attemptId)``, so a replay answers 200 with
``applied: false`` and changes nothing; this runtime logs that and treats it as
success, because it means the state it wanted is already recorded.

## Retry semantics — the part that is easy to get wrong

A08 gives every ``ai.*`` job **two** BullMQ attempts, but the `jobs` row has a
**single** ``attemptId``. So a failed completion posted on the first BullMQ attempt
moves the row to `failed`, and the second attempt's completion is then rejected as
``already_completed`` — the retry would be invisible to the product. The rule that
falls out of that:

| Failure                        | Completion posted?         | Exception re-raised? |
| ------------------------------ | -------------------------- | -------------------- |
| retryable, attempts remain     | **no**                     | yes — BullMQ retries |
| retryable, final attempt       | yes, `finalAttempt: true`  | yes — BullMQ fails   |
| non-retryable (any attempt)    | yes, `error.retryable:false` | yes                |
| envelope does not parse        | no (there is no jobId)     | yes                  |

`finalAttempt` and `error.retryable=false` are exactly the two flags
``markDeadLetterIfFinal`` in ``jobs.service.ts`` reads, so a job that has run out of
road lands in the DLQ with its last error attached. The exception is always
re-raised so BullMQ's own accounting matches the API's.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from worker_ai.alignment import AlignerRegistry
from worker_ai.cache import MemoryResultCache, NullResultCache, RedisResultCache, ResultCache
from worker_ai.callbacks import CallbackClient, JobCompletion, JobError
from worker_ai.clean.processor import process_clean
from worker_ai.diarisation import DiariserRegistry
from worker_ai.lid import (
    GpuLanguageIdentifier,
    IndicLidClassifier,
    LanguageIdentifier,
    WhisperLanguageIdentifier,
)
from worker_ai.logging_setup import get_logger
from worker_ai.processors import (
    JobContext,
    JobFailureError,
    ProcessorOutcome,
    Services,
    process_align,
    process_diarise,
    process_not_implemented,
    process_transcribe,
    process_translate,
    process_transliterate,
    process_vad,
)
from worker_ai.providers.registry import build_registry
from worker_ai.queues import AI_QUEUES, parse_envelope
from worker_ai.routing import RoutingTable, load_overrides, load_routing_table
from worker_ai.settings import Settings
from worker_ai.storage import ObjectStore, StorageError
from worker_ai.translate.providers.base import TranslationProvider
from worker_ai.translate.providers.indictrans2 import IndicTrans2Provider
from worker_ai.translate.providers.llm import LLMTranslateProvider
from worker_ai.translate.providers.sarvam_mayura import (
    SARVAM_TRANSLATE_DEFAULT_BASE_URL,
    SarvamMayuraProvider,
)
from worker_ai.transliterate import (
    IndicXlitHttpProvider,
    RuleTableTransliterationProvider,
    TransliterationProvider,
)
from worker_ai.vad import load_vad

__all__ = [
    "PROCESSORS",
    "Handler",
    "Processor",
    "build_services",
    "make_handler",
    "queues_for",
]

_log = get_logger(__name__)

#: A processor takes a context and returns an outcome (or nothing, for a stub that
#: always raises).
Processor = Callable[[JobContext], Awaitable[ProcessorOutcome | None]]

#: What BullMQ calls: ``(job, token) -> result``.
Handler = Callable[[Any, str | None], Awaitable[dict[str, Any]]]

PROCESSORS: dict[str, Processor] = {
    "ai.vad": process_vad,
    "ai.transcribe": process_transcribe,
    "ai.align": process_align,
    "ai.diarise": process_diarise,
    "ai.translate": process_translate,
    "ai.transliterate": process_transliterate,
    "ai.clean": process_clean,
}


def queues_for(settings: Settings) -> tuple[str, ...]:
    """Which queues this process consumes.

    ``WORKER_AI_QUEUES`` narrows it — useful for pinning a GPU pool to
    ``ai.transcribe`` while a CPU pool takes ``ai.vad`` (`05 §10`). An unknown name
    is a configuration error and is refused rather than silently ignored.
    """
    if not settings.queues:
        return AI_QUEUES
    unknown = [name for name in settings.queues if name not in AI_QUEUES]
    if unknown:
        raise ValueError(
            f"WORKER_AI_QUEUES names queues this worker does not own: {', '.join(unknown)}"
        )
    return tuple(settings.queues)


def build_services(settings: Settings, *, callbacks: CallbackClient | None = None) -> Services:
    """Build the process-wide collaborators once."""
    store: ObjectStore | None = None
    if settings.derived_bucket.configured:
        try:
            store = ObjectStore.from_settings(settings.derived_bucket)
        except StorageError as error:  # pragma: no cover - boto3 construction failure
            _log.warning("derived store unavailable", extra={"reason": str(error)})

    return Services(
        settings=settings,
        callbacks=callbacks
        or CallbackClient(settings.api_origin, settings.internal_callback_secret),
        providers=build_registry(settings),
        routing=build_routing_table(settings),
        aligners=AlignerRegistry.from_settings(settings),
        diarisers=DiariserRegistry.from_settings(settings),
        vad=load_vad(settings.vad_model_path),
        derived_store=store,
        cache=build_cache(settings),
        language_id=build_language_identifier(settings),
        text_lid=IndicLidClassifier(settings.indiclid_dir),
        transliteration=build_transliteration_provider(settings),
        translation_providers=build_translation_providers(settings),
    )


def build_transliteration_provider(settings: Settings) -> TransliterationProvider:
    """`09 §4`: IndicXlit when `WORKER_AI_INDICXLIT_URL` names a served model,
    the dependency-free rule table (``transliterate/tables.py``) otherwise.

    No `apps/model-server` route exists yet for IndicXlit (A22's decision: see
    ``transliterate/provider.py``), so the HTTP path is here for the day one is
    added, and every deployment today runs on the rule table.
    """
    if settings.indicxlit_base_url:
        return IndicXlitHttpProvider(base_url=settings.indicxlit_base_url)
    return RuleTableTransliterationProvider()


def build_translation_providers(settings: Settings) -> tuple[TranslationProvider, ...]:
    """`09 §4`'s chain: Sarvam Mayura -> IndicTrans2 (optional) -> LLM.

    Sarvam is skipped without `SARVAM_API_KEY`; IndicTrans2 is skipped without
    `WORKER_AI_INDICTRANS2_URL` (self-host, no public default — the brief calls
    it "optional, behind a flag" and the flag *is* the URL being set). The LLM
    adapter is always present: `LLM_PROVIDER=mock` (the worker's own default)
    needs no credential, so the chain is never empty.
    """
    providers: list[TranslationProvider] = []
    if settings.sarvam_api_key:
        providers.append(
            SarvamMayuraProvider(
                api_key=settings.sarvam_api_key,
                base_url=settings.sarvam_base_url or SARVAM_TRANSLATE_DEFAULT_BASE_URL,
            )
        )
    if settings.indictrans2_base_url:
        providers.append(IndicTrans2Provider(base_url=settings.indictrans2_base_url))
    providers.append(
        LLMTranslateProvider(
            provider=settings.llm_provider,
            anthropic_api_key=settings.anthropic_api_key,
            openai_api_key=settings.openai_api_key,
        )
    )
    return tuple(providers)


def build_routing_table(settings: Settings) -> RoutingTable:
    """``routing.yaml`` with the admin weights of `09 §1` laid over it.

    Two sources, in order: ``ROUTING_OVERRIDES_JSON`` in the environment, then
    the API's ``GET /internal/routing`` when ``WORKER_AI_ROUTING_OVERRIDES_FROM_API``
    is on. The API endpoint belongs to the admin console (B13) and does not exist
    on ``main`` yet, so the fetch is opt-in and a 404 is not an error — the worker
    logs it once and runs the table as written.
    """
    table = load_routing_table(settings.routing_file or None)
    overrides = load_overrides(settings.routing_overrides_json)
    if settings.routing_overrides_from_api:
        overrides = {**overrides, **fetch_routing_overrides(settings)}
    if not overrides:
        return table
    _log.info("routing overrides applied", extra={"lanes": len(overrides.get("lanes", {}) or {})})
    return table.apply_overrides(overrides)


def fetch_routing_overrides(settings: Settings) -> dict[str, Any]:
    """``GET {API_ORIGIN}/internal/routing``, signed like every internal call.

    Returns ``{}`` on any failure — a missing endpoint, a bad signature, an
    unreachable API. Routing weights are a tuning knob; a worker that refuses to
    boot without them would turn an admin-console outage into an ASR outage.
    """
    import hashlib
    import hmac
    import time

    import httpx2

    path = "/internal/routing"
    timestamp = str(int(time.time()))
    signature = hmac.new(
        settings.internal_callback_secret.encode("utf-8"),
        (timestamp + ".").encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    try:
        response = httpx2.get(
            settings.api_origin + path,
            headers={
                "x-montaj-timestamp": timestamp,
                "x-montaj-signature": signature,
            },
            timeout=5.0,
        )
    except httpx2.HTTPError as error:
        _log.warning("routing overrides unavailable", extra={"reason": type(error).__name__})
        return {}
    if response.status_code == 404:
        _log.info("the API exposes no /internal/routing yet; using routing.yaml as written")
        return {}
    if response.status_code >= 400:
        _log.warning("routing overrides refused", extra={"status": response.status_code})
        return {}
    try:
        parsed: Any = response.json()
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def build_cache(settings: Settings) -> ResultCache:
    """The `09 §1` result cache for this deployment."""
    kind = settings.cache_kind
    if kind == "redis":
        return RedisResultCache(settings.redis_url, max_entry_bytes=settings.cache_max_entry_bytes)
    if kind == "memory":
        return MemoryResultCache(max_entry_bytes=settings.cache_max_entry_bytes)
    return NullResultCache()


def build_language_identifier(settings: Settings) -> LanguageIdentifier | None:
    """Signal 1 of the two-signal LID (D14): the best acoustic model available.

    faster-whisper when the ``local-asr`` extra is installed, otherwise the D15
    model server, otherwise ``None`` — and ``None`` means ``ai.transcribe`` uses
    the language the routed ASR provider reported, which every adapter returns.
    """
    whisper = WhisperLanguageIdentifier(model_name=settings.whisper_model)
    if whisper.available() is None:
        return whisper
    gpu = GpuLanguageIdentifier(settings.gpu_provider_url, token=settings.gpu_provider_token)
    if gpu.available() is None:
        return gpu
    return None


def make_handler(queue: str, services: Services) -> Handler:
    """The BullMQ processor function for one queue."""
    processor = PROCESSORS.get(queue, process_not_implemented)

    async def handle(job: Any, token: str | None = None) -> dict[str, Any]:
        del token  # BullMQ renews the lock itself; A10 uses this for long ASR runs.
        # A malformed envelope is a producer bug with no jobId to report against,
        # so it fails loudly here and never reaches a callback.
        envelope = parse_envelope(job.data)
        context = JobContext(
            envelope=envelope,
            queue=queue,
            services=services,
            attempts_made=_int_attr(job, "attemptsMade", 0),
            max_attempts=_max_attempts(job),
        )
        log_fields = {**envelope.log_fields(), "queue": queue}
        _log.info("job received", extra={**log_fields, "bullJobId": getattr(job, "id", None)})

        try:
            await context.progress(0, message=f"{queue} started")
            outcome = await processor(context)
            result = outcome.result if outcome is not None else {}
            usage = outcome.usage if outcome is not None else None

            await services.callbacks.complete(
                envelope.job_id,
                envelope.attempt_id,
                JobCompletion(status="succeeded", result=result, usage=usage),
            )
            _log.info("job succeeded", extra=log_fields)
            return result
        except JobFailureError as failure:
            await _report_failure(context, failure.code, failure.message, failure.retryable)
            raise
        except Exception as error:
            # Anything unclassified is treated as transient: a bug that always
            # throws burns its two attempts and lands in the DLQ either way.
            await _report_failure(context, "worker/unhandled", str(error), True)
            raise
        finally:
            context.cleanup()

    return handle


async def _report_failure(context: JobContext, code: str, message: str, retryable: bool) -> None:
    """Post a failed completion when — and only when — the API should see one."""
    log_fields = {**context.envelope.log_fields(), "queue": context.queue, "code": code}

    if retryable and not context.final_attempt:
        # Stay quiet: the row must remain in flight so the next BullMQ attempt's
        # completion is not rejected as `already_completed`.
        _log.warning(
            "job failed; leaving it to BullMQ to retry",
            extra={**log_fields, "attemptsMade": context.attempts_made},
        )
        return

    _log.error("job failed", extra={**log_fields, "retryable": retryable})
    try:
        await context.services.callbacks.complete(
            context.envelope.job_id,
            context.envelope.attempt_id,
            JobCompletion(
                status="failed",
                error=JobError(code=code, message=message, retryable=retryable),
                final_attempt=True,
            ),
        )
    except Exception as error:
        _log.error(
            "could not report the failure to the API",
            extra={**log_fields, "reason": str(error)[:200]},
        )


def _int_attr(job: object, name: str, default: int) -> int:
    value = getattr(job, name, default)
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _max_attempts(job: object) -> int:
    """How many BullMQ attempts this job gets, from the options the API set."""
    opts = getattr(job, "opts", None)
    if isinstance(opts, dict):
        attempts = opts.get("attempts")
        if isinstance(attempts, int) and attempts > 0:
            return attempts
    return _int_attr(job, "attempts", 1) or 1


async def close_services(services: Services) -> None:
    """Release everything :func:`build_services` created."""
    await services.providers.aclose()
    await services.callbacks.aclose()
    await services.transliteration.aclose()
    for provider in services.translation_providers:
        await provider.aclose()


async def drain(workers: list[Any], timeout_s: float = 30.0) -> None:
    """Close every BullMQ worker, bounded, so a stuck job cannot block shutdown."""
    if not workers:
        return
    await asyncio.wait_for(
        asyncio.gather(*(worker.close() for worker in workers), return_exceptions=True),
        timeout=timeout_s,
    )
