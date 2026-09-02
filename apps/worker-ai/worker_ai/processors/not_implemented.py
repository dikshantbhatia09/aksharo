"""Processors for the ``ai.*`` queues A09 does not implement.

``ai.translate``, ``ai.transliterate``, ``ai.clean``, ``ai.pass`` and ``ai.llm``
are real queues in CONTRACTS section 3 and the API will happily enqueue onto them.
A worker that simply did not consume them would leave those jobs in Redis until the
queue-wait sweeper failed them half an hour later (``jobs.config.ts``), with no
explanation attached.

So they are consumed and answered: one **non-retryable** failed completion naming
the work package that will implement the queue. The producer gets a clear error in
seconds, the credit hold is released, and the job lands on the dead-letter path
where an admin can replay it once the real processor ships (A08b).
"""

from __future__ import annotations

from worker_ai.processors.context import JobContext, JobFailureError

__all__ = ["OWNERS", "process_not_implemented"]

#: Which work package owns each queue.
OWNERS: dict[str, str] = {
    "ai.translate": "A12 (scripts and translation)",
    "ai.transliterate": "A12 (scripts and translation)",
    "ai.clean": "A13 (audio clean)",
    "ai.pass": "A14 (edit passes)",
    "ai.llm": "A15 (LLM features)",
}


async def process_not_implemented(context: JobContext) -> None:
    """Fail the job immediately, naming the work package that will implement it."""
    owner = OWNERS.get(context.queue, "a later work package")
    raise JobFailureError(
        "worker/not_implemented",
        f"{context.queue} is not implemented yet; it lands in {owner}",
        retryable=False,
    )
