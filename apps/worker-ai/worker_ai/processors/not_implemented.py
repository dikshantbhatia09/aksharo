"""Processors for the ``ai.*`` queues not yet implemented.

Every ``ai.*`` queue CONTRACTS section 3 names now has a real processor:
``ai.translate`` and ``ai.transliterate`` from A22, ``ai.llm`` from B11,
``ai.pass`` from B18, ``ai.clean`` from B10 (``worker_ai.clean.processor.
process_clean``), registered ahead of this fallback in ``runtime.PROCESSORS``.
``ai.pass`` itself still answers ``worker/not_implemented``, from inside its
own processor, for any ``passType`` this list does not yet know (reframe/zoom
lands in B19) — so it is not registered here any more.

This module stays in place for the next queue CONTRACTS grows: a worker that
simply did not consume an unimplemented queue would leave those jobs in Redis
until the queue-wait sweeper failed them half an hour later
(``jobs.config.ts``), with no explanation attached. So an unregistered queue
is consumed and answered: one **non-retryable** failed completion naming the
work package that will implement it. The producer gets a clear error in
seconds, the credit hold is released, and the job lands on the dead-letter
path where an admin can replay it once the real processor ships (A08b).
"""

from __future__ import annotations

from worker_ai.processors.context import JobContext, JobFailureError

__all__ = ["OWNERS", "process_not_implemented"]

#: Which work package owns each queue not yet implemented. Empty today — every
#: ``ai.*`` queue CONTRACTS section 3 names has a processor.
OWNERS: dict[str, str] = {}


async def process_not_implemented(context: JobContext) -> None:
    """Fail the job immediately, naming the work package that will implement it."""
    owner = OWNERS.get(context.queue, "a later work package")
    raise JobFailureError(
        "worker/not_implemented",
        f"{context.queue} is not implemented yet; it lands in {owner}",
        retryable=False,
    )
