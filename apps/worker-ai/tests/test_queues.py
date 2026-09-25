"""The queue contract must not drift from CONTRACTS section 3 or from the Node side."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from worker_ai.queues import (
    AI_TRANSCRIBE_QUEUE,
    QUEUE_NAMES,
    is_job_envelope,
    parse_envelope,
)

REPO_ROOT = Path(__file__).resolve().parents[3]

VALID_JOB: dict[str, Any] = {
    "jobId": "01JBQ8Z2W4N7Y0K3M5P8R1T6V9",
    "attemptId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VA",
    "workspaceId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VB",
    "projectId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VC",
    "priority": 5,
    "jobKey": "ai.transcribe:01JBQ8Z2W4N7Y0K3M5P8R1T6VD",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "payload": {"mediaId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VD"},
}


def test_lists_all_twenty_frozen_queue_names() -> None:
    assert len(QUEUE_NAMES) == 20
    assert len(set(QUEUE_NAMES)) == len(QUEUE_NAMES)
    assert AI_TRANSCRIBE_QUEUE == "ai.transcribe"
    assert AI_TRANSCRIBE_QUEUE in QUEUE_NAMES


def test_queue_names_match_the_node_worker() -> None:
    """Node enqueues and Python consumes: a typo here is a silently empty queue."""
    node = (REPO_ROOT / "apps" / "worker-media" / "src" / "queues.ts").read_text(encoding="utf-8")
    block = node.split("QUEUE_NAMES = [", 1)[1].split("] as const", 1)[0]
    assert tuple(re.findall(r'"([a-z.]+)"', block)) == QUEUE_NAMES


def test_accepts_a_well_formed_envelope() -> None:
    assert is_job_envelope(VALID_JOB) is True
    envelope = parse_envelope(VALID_JOB)
    assert envelope.job_id == VALID_JOB["jobId"]
    assert envelope.project_id == VALID_JOB["projectId"]
    assert envelope.payload == {"mediaId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VD"}


def test_accepts_an_envelope_without_the_optional_project_id() -> None:
    source = {key: value for key, value in VALID_JOB.items() if key != "projectId"}
    assert parse_envelope(source).project_id is None


@pytest.mark.parametrize(
    "field",
    ["jobId", "attemptId", "workspaceId", "jobKey", "createdAt", "payload"],
)
def test_rejects_a_job_missing_a_contract_field(field: str) -> None:
    source = {key: value for key, value in VALID_JOB.items() if key != field}
    assert is_job_envelope(source) is False
    with pytest.raises(ValueError, match="CONTRACTS section 3"):
        parse_envelope(source)


@pytest.mark.parametrize("value", [None, "ai.transcribe", 42, [], {"payload": {}}])
def test_rejects_non_envelopes(value: object) -> None:
    assert is_job_envelope(value) is False
