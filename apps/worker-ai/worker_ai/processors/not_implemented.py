"""Processors for the ``ai.*`` queues not yet implemented.

``ai.clean`` is a real queue in CONTRACTS section 3 and the API will happily
enqueue onto it. A worker that simply did not consume it would leave those
jobs in Redis until the queue-wait sweeper failed them half an hour later
(``jobs.config.ts``), with no explanation attached.
``ai.translate``, ``ai.transliterate``, ``ai.llm`` and ``ai.pass`` were all on
this list through A09/A10/A11/B11/B18; A22, B11 and B18 give them real
processors (``processors/translate.py``, ``processors/transliterate.py``,
``processors/llm.py``, ``processors/autocut_pass.py``), registered ahead of
this fallback in ``runtime.PROCESSORS``. ``ai.pass`` itself still answers
`worker/not_implemented`, from inside its own processor, for any `passType`
this list does not yet know (reframe/zoom lands in B19) — so it is not
registered here any more.

So the remaining queue is consumed and answered: one **non-retryable** failed
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
}


async def process_not_implemented(context: JobContext) -> None:
    """Fail the job immediately, naming the work package that will implement it."""
    owner = OWNERS.get(context.queue, "a later work package")
    raise JobFailureError(
        "worker/not_implemented",
        f"{context.queue} is not implemented yet; it lands in {owner}",
        retryable=False,
    )
