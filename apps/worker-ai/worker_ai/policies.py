"""Retry, stall and heartbeat policy — the Python copy of A08b's table.

`apps/api/src/jobs/jobs.config.ts` is the source of truth. `attempts` and
`backoff` reach a worker inside the BullMQ job options, so they need no copy here;
**`lockDurationMs`, `stalledIntervalMs` and `maxStalledCount` are `Worker`
constructor options** and have to be read from the table by each worker package.
This module is that read, and `tests/test_policies.py` parses the TypeScript
source to prove the two have not drifted — the same guard the queue names have.

The three numbers, and why each one is what it is:

* **`lock_duration_ms`** — how long this worker may hold a job without renewing
  its lock. Too short and a long job is declared stalled and handed to a second
  worker *while the first is still transcribing it*, which is a double charge to
  the customer and a double call to the vendor; too long and a worker that really
  did die takes that long to be noticed. Ten minutes on `ai.transcribe` and
  `ai.diarise` is the worst realistic case: a two-hour recording on a cold GPU.
* **`stalled_interval_ms`** — how often the stall check runs.
* **`max_stalled_count`** — how many recoveries a job gets before it is failed
  outright. One on every `ai.*` queue: a job that stalls twice is not unlucky, it
  is killing its worker.

:func:`heartbeat_interval_ms` is a third of the lock — the standard safety factor,
so two consecutive missed beats still leave the lock alive. **The heartbeat is the
progress callback**: `JobsService.recordProgress` promotes a `queued` job to
`running` precisely so that one call does both jobs, which is why a long job that
has nothing new to report still posts its current percentage.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

__all__ = [
    "DEFAULT_QUEUE_POLICY",
    "QUEUE_POLICY_BY_FAMILY",
    "QUEUE_POLICY_OVERRIDES",
    "QueuePolicy",
    "heartbeat_interval_ms",
    "queue_policy_for",
    "worker_options",
]


@dataclass(frozen=True, slots=True)
class QueuePolicy:
    """One queue's retry and stall policy (``QueuePolicy`` in ``jobs.config.ts``)."""

    #: Total tries, not retries: 2 means one run and one retry.
    attempts: int
    #: Base delay of the exponential backoff.
    backoff_ms: int
    #: Fraction of the computed delay to randomise, 0-1 (BullMQ ``backoff.jitter``).
    backoff_jitter: float
    #: How long a worker may hold the job without renewing its lock.
    lock_duration_ms: int
    #: How often the stalled-job check runs.
    stalled_interval_ms: int
    #: How many times a job may be recovered from `stalled` before it is failed.
    max_stalled_count: int


#: Applied to any queue whose family is not in :data:`QUEUE_POLICY_BY_FAMILY`.
DEFAULT_QUEUE_POLICY: Final[QueuePolicy] = QueuePolicy(
    attempts=2,
    backoff_ms=10_000,
    backoff_jitter=0.3,
    lock_duration_ms=60_000,
    stalled_interval_ms=30_000,
    max_stalled_count=1,
)

#: Per-family defaults, keyed on the part of the queue name before the dot.
QUEUE_POLICY_BY_FAMILY: Final[dict[str, QueuePolicy]] = {
    "media": QueuePolicy(
        attempts=3,
        backoff_ms=5_000,
        backoff_jitter=0.2,
        lock_duration_ms=120_000,
        stalled_interval_ms=30_000,
        max_stalled_count=1,
    ),
    "ai": QueuePolicy(
        attempts=2,
        backoff_ms=15_000,
        backoff_jitter=0.3,
        lock_duration_ms=120_000,
        stalled_interval_ms=30_000,
        max_stalled_count=1,
    ),
    "render": QueuePolicy(
        attempts=2,
        backoff_ms=30_000,
        backoff_jitter=0.3,
        lock_duration_ms=300_000,
        stalled_interval_ms=60_000,
        max_stalled_count=1,
    ),
    "notify": QueuePolicy(
        attempts=5,
        backoff_ms=2_000,
        backoff_jitter=0.5,
        lock_duration_ms=30_000,
        stalled_interval_ms=15_000,
        max_stalled_count=2,
    ),
    "publish": QueuePolicy(
        attempts=1,
        backoff_ms=30_000,
        backoff_jitter=0.5,
        lock_duration_ms=120_000,
        stalled_interval_ms=30_000,
        max_stalled_count=1,
    ),
}

#: Queues whose work outlives the family lock. Only the differing fields appear,
#: exactly as in ``QUEUE_POLICY_OVERRIDES``.
QUEUE_POLICY_OVERRIDES: Final[dict[str, dict[str, int]]] = {
    "media.probe": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
    "media.proxy": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
    "media.acquire": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
    "media.clip": {"lockDurationMs": 300_000, "stalledIntervalMs": 60_000},
    "ai.highlights": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
    "ai.faces": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
    "ai.transcribe": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
    "ai.diarise": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
    "ai.align": {"lockDurationMs": 300_000, "stalledIntervalMs": 60_000},
    "render.video": {"lockDurationMs": 600_000, "stalledIntervalMs": 60_000},
}

#: Override keys, in the camelCase the TypeScript table uses, to Python fields.
_OVERRIDE_FIELDS: Final[dict[str, str]] = {
    "attempts": "attempts",
    "backoffMs": "backoff_ms",
    "backoffJitter": "backoff_jitter",
    "lockDurationMs": "lock_duration_ms",
    "stalledIntervalMs": "stalled_interval_ms",
    "maxStalledCount": "max_stalled_count",
}


def queue_policy_for(queue_name: str) -> QueuePolicy:
    """The policy for a queue: its family defaults, with any per-queue override."""
    family = queue_name.split(".")[0] or queue_name
    base = QUEUE_POLICY_BY_FAMILY.get(family, DEFAULT_QUEUE_POLICY)
    override = QUEUE_POLICY_OVERRIDES.get(queue_name)
    if override is None:
        return base
    fields = {
        _OVERRIDE_FIELDS[key]: value for key, value in override.items() if key in _OVERRIDE_FIELDS
    }
    return QueuePolicy(
        attempts=int(fields.get("attempts", base.attempts)),
        backoff_ms=int(fields.get("backoff_ms", base.backoff_ms)),
        backoff_jitter=float(fields.get("backoff_jitter", base.backoff_jitter)),
        lock_duration_ms=int(fields.get("lock_duration_ms", base.lock_duration_ms)),
        stalled_interval_ms=int(fields.get("stalled_interval_ms", base.stalled_interval_ms)),
        max_stalled_count=int(fields.get("max_stalled_count", base.max_stalled_count)),
    )


def heartbeat_interval_ms(queue_name: str) -> int:
    """How often a worker on this queue must post progress: a third of the lock."""
    return queue_policy_for(queue_name).lock_duration_ms // 3


def worker_options(
    queue_name: str, *, redis_url: str, concurrency: int, prefix: str
) -> dict[str, object]:
    """The `bullmq.Worker` options for one queue, policy included.

    Kept here rather than inline in ``__main__`` so the policy reaches the worker
    through exactly one call site, and so the integration test constructs its
    worker the same way production does.
    """
    policy = queue_policy_for(queue_name)
    return {
        "connection": redis_url,
        "concurrency": concurrency,
        "prefix": prefix,
        "lockDuration": policy.lock_duration_ms,
        # BullMQ renews at half the lock by default; a third matches the heartbeat
        # cadence and leaves room for one missed renewal.
        "lockRenewTime": policy.lock_duration_ms // 3,
        "stalledInterval": policy.stalled_interval_ms,
        "maxStalledCount": policy.max_stalled_count,
    }
