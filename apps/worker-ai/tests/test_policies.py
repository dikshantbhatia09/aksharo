"""The A08b retry/stall policy must not drift from the TypeScript source.

`apps/api/src/jobs/jobs.config.ts` is the source of truth. `attempts` and
`backoff` reach a worker inside the BullMQ job options, but `lockDurationMs`,
`stalledIntervalMs` and `maxStalledCount` are `Worker` **constructor** options and
have to be read from that table by each worker package — so a drift here is not a
compile error anywhere, it is a job silently declared stalled and handed to a
second worker while the first is still transcribing it.

This file parses the TypeScript, the same way `test_queues.py` parses the queue
list and `apps/api/.../queue-names.test.ts` parses `queues.py`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from worker_ai.policies import (
    DEFAULT_QUEUE_POLICY,
    QUEUE_POLICY_BY_FAMILY,
    QUEUE_POLICY_OVERRIDES,
    QueuePolicy,
    heartbeat_interval_ms,
    queue_policy_for,
    worker_options,
)
from worker_ai.queues import AI_QUEUES

REPO_ROOT = Path(__file__).resolve().parents[3]
JOBS_CONFIG = REPO_ROOT / "apps" / "api" / "src" / "jobs" / "jobs.config.ts"

#: camelCase on the wire, snake_case here.
_FIELDS = {
    "attempts": "attempts",
    "backoffMs": "backoff_ms",
    "backoffJitter": "backoff_jitter",
    "lockDurationMs": "lock_duration_ms",
    "stalledIntervalMs": "stalled_interval_ms",
    "maxStalledCount": "max_stalled_count",
}


def _source() -> str:
    if not JOBS_CONFIG.is_file():  # pragma: no cover - the monorepo always has it
        pytest.skip(f"{JOBS_CONFIG} is missing")
    return JOBS_CONFIG.read_text(encoding="utf-8")


def _numbers(block: str) -> dict[str, float]:
    """Every `key: 1_234` or `key: 0.3` in a TypeScript object literal."""
    return {
        key: float(value.replace("_", ""))
        for key, value in re.findall(r"(\w+):\s*([0-9_]+(?:\.[0-9]+)?)\s*,", block)
        if key in _FIELDS
    }


def _object_after(source: str, start: re.Pattern[str]) -> str:
    """The braced literal that follows ``start``, brace-matched."""
    match = start.search(source)
    if match is None:  # pragma: no cover - a rename is a test failure, loudly
        raise AssertionError(f"could not find {start.pattern} in jobs.config.ts")
    tail = source[match.end() - 1 :]
    depth = 0
    for index, character in enumerate(tail):
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return tail[: index + 1]
    raise AssertionError("unbalanced braces in jobs.config.ts")  # pragma: no cover


def _as_policy(numbers: dict[str, float]) -> dict[str, float]:
    return {_FIELDS[key]: value for key, value in numbers.items()}


def _fields(policy: QueuePolicy) -> dict[str, float]:
    return {
        "attempts": float(policy.attempts),
        "backoff_ms": float(policy.backoff_ms),
        "backoff_jitter": float(policy.backoff_jitter),
        "lock_duration_ms": float(policy.lock_duration_ms),
        "stalled_interval_ms": float(policy.stalled_interval_ms),
        "max_stalled_count": float(policy.max_stalled_count),
    }


def test_the_default_policy_matches_the_typescript_source() -> None:
    block = _object_after(
        _source(), re.compile(r"export const DEFAULT_QUEUE_POLICY[^=]*=\s*Object\.freeze\(")
    )
    assert _as_policy(_numbers(block)) == _fields(DEFAULT_QUEUE_POLICY)


@pytest.mark.parametrize("family", ["media", "ai", "render", "notify"])
def test_every_family_policy_matches_the_typescript_source(family: str) -> None:
    table = _object_after(
        _source(), re.compile(r"export const QUEUE_POLICY_BY_FAMILY[^=]*=\s*Object\.freeze\(")
    )
    block = _object_after(table, re.compile(rf"\b{family}:\s*"))
    assert _as_policy(_numbers(block)) == _fields(QUEUE_POLICY_BY_FAMILY[family])


def test_the_family_table_lists_exactly_the_same_families() -> None:
    table = _object_after(
        _source(), re.compile(r"export const QUEUE_POLICY_BY_FAMILY[^=]*=\s*Object\.freeze\(")
    )
    families = set(re.findall(r"^\s{2}(\w+):\s*\{", table, re.MULTILINE))
    assert families == set(QUEUE_POLICY_BY_FAMILY)


def test_the_per_queue_overrides_match_the_typescript_source() -> None:
    table = _object_after(
        _source(), re.compile(r"export const QUEUE_POLICY_OVERRIDES[^=]*=\s*Object\.freeze\(")
    )
    from_ts = {
        queue: {
            key: int(value.replace("_", ""))
            for key, value in re.findall(r"(\w+):\s*([0-9_]+)", body)
        }
        for queue, body in re.findall(r'"([\w.]+)":\s*\{([^}]*)\}', table)
    }
    assert from_ts == QUEUE_POLICY_OVERRIDES


def test_the_heartbeat_is_a_third_of_the_lock_in_both_languages() -> None:
    source = _source()
    body = source.split("export function heartbeatIntervalMs", 1)[1].split("}", 1)[0]
    assert "lockDurationMs / 3" in body
    for queue in AI_QUEUES:
        assert heartbeat_interval_ms(queue) == queue_policy_for(queue).lock_duration_ms // 3


# ---------------------------------------------------------------------------
# The resolved values, spelled out so a reader can check them against the README
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("queue", "lock_ms", "stall_ms"),
    [
        ("ai.transcribe", 600_000, 60_000),
        ("ai.diarise", 600_000, 60_000),
        ("ai.align", 300_000, 60_000),
        # No override: the `ai` family defaults.
        ("ai.vad", 120_000, 30_000),
        ("ai.translate", 120_000, 30_000),
        ("ai.llm", 120_000, 30_000),
    ],
)
def test_the_resolved_ai_policies(queue: str, lock_ms: int, stall_ms: int) -> None:
    policy = queue_policy_for(queue)
    assert policy.lock_duration_ms == lock_ms
    assert policy.stalled_interval_ms == stall_ms
    assert policy.attempts == 2
    assert policy.max_stalled_count == 1


def test_an_unknown_family_falls_back_to_the_default() -> None:
    assert queue_policy_for("mystery.queue") == DEFAULT_QUEUE_POLICY
    assert queue_policy_for("mystery") == DEFAULT_QUEUE_POLICY


def test_a_ten_minute_lock_gives_a_two_hour_recording_room_to_breathe() -> None:
    """`ai.transcribe` is sized for the worst realistic case, not the median."""
    assert queue_policy_for("ai.transcribe").lock_duration_ms == 10 * 60_000
    assert heartbeat_interval_ms("ai.transcribe") == 200_000


def test_worker_options_carry_the_policy_to_bullmq() -> None:
    options = worker_options(
        "ai.transcribe", redis_url="redis://localhost:6379", concurrency=4, prefix="a09"
    )
    assert options == {
        "connection": "redis://localhost:6379",
        "concurrency": 4,
        "prefix": "a09",
        "lockDuration": 600_000,
        "lockRenewTime": 200_000,
        "stalledInterval": 60_000,
        "maxStalledCount": 1,
    }


def test_worker_options_renew_the_lock_before_the_heartbeat_could_miss_it() -> None:
    """Renewal and heartbeat share a cadence: two missed beats still hold the lock."""
    for queue in AI_QUEUES:
        options: dict[str, Any] = worker_options(
            queue, redis_url="redis://x", concurrency=1, prefix="bull"
        )
        assert options["lockRenewTime"] == heartbeat_interval_ms(queue)
        assert int(options["lockRenewTime"]) * 3 <= int(options["lockDuration"])
