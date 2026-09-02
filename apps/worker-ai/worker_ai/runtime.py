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
from worker_ai.callbacks import CallbackClient, JobCompletion, JobError
from worker_ai.diarisation import DiariserRegistry
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
    process_vad,
)
from worker_ai.providers.registry import build_registry
from worker_ai.queues import AI_QUEUES, parse_envelope
from worker_ai.routing import load_routing_table
from worker_ai.settings import Settings
from worker_ai.storage import ObjectStore, StorageError
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
        routing=load_routing_table(settings.routing_file or None),
        aligners=AlignerRegistry.default(),
        diarisers=DiariserRegistry.default(),
        vad=load_vad(settings.vad_model_path),
        derived_store=store,
    )


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


async def drain(workers: list[Any], timeout_s: float = 30.0) -> None:
    """Close every BullMQ worker, bounded, so a stuck job cannot block shutdown."""
    if not workers:
        return
    await asyncio.wait_for(
        asyncio.gather(*(worker.close() for worker in workers), return_exceptions=True),
        timeout=timeout_s,
    )
