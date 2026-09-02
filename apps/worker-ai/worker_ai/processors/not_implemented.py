"""Processors for the ``ai.*`` queues not yet implemented.

``ai.clean``, ``ai.pass`` and ``ai.llm`` are real queues in CONTRACTS section 3
and the API will happily enqueue onto them. A worker that simply did not consume
them would leave those jobs in Redis until the queue-wait sweeper failed them
half an hour later (``jobs.config.ts``), with no explanation attached.
``ai.translate`` and ``ai.transliterate`` were on this list through A09/A10/A11;
A22 gives them real processors (``processors/translate.py``,
``processors/transliterate.py``), registered ahead of this fallback in
``runtime.PROCESSORS``.

So the remaining queues are consumed and answered: one **non-retryable** failed
completion naming the work package that will implement the queue. The producer
gets a clear error in seconds, the credit hold is released, and the job lands on
the dead-letter path where an admin can replay it once the real processor ships
(A08b).
"""

from __future__ import annotations

from worker_ai.processors.context import JobContext, JobFailureError

__all__ = ["OWNERS", "process_not_implemented"]

#: Which work package owns each queue.
OWNERS: dict[str, str] = {
    "ai.clean": "B10 (audio clean)",
    "ai.pass": "B18/B19 (edit passes)",
    "ai.llm": "B11 (LLM features)",
}


async def process_not_implemented(context: JobContext) -> None:
    """Fail the job immediately, naming the work package that will implement it."""
    owner = OWNERS.get(context.queue, "a later work package")
    raise JobFailureError(
        "worker/not_implemented",
        f"{context.queue} is not implemented yet; it lands in {owner}",
        retryable=False,
    )
