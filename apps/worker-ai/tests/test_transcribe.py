"""The `ai.transcribe` stub processor."""

from __future__ import annotations

from typing import Any

import pytest

from worker_ai.processors import process_transcribe


class _FakeJob:
    """Stands in for a BullMQ Job, which ships no type information."""

    def __init__(self, data: object) -> None:
        self.id = "1"
        self.data = data
        self.progress: int | None = None

    async def updateProgress(self, value: int) -> None:  # noqa: N802 - BullMQ's name
        self.progress = value


VALID_JOB: dict[str, Any] = {
    "jobId": "01JBQ8Z2W4N7Y0K3M5P8R1T6V9",
    "attemptId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VA",
    "workspaceId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VB",
    "priority": 5,
    "jobKey": "ai.transcribe:01JBQ8Z2W4N7Y0K3M5P8R1T6VD",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "payload": {"mediaId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VD"},
}


async def test_completes_with_a_stub_result_and_reports_progress() -> None:
    job = _FakeJob(VALID_JOB)
    result = await process_transcribe(job)

    assert result["mediaId"] == "01JBQ8Z2W4N7Y0K3M5P8R1T6VD"
    assert result["stub"] is True
    assert result["words"] == []
    assert job.progress == 100


async def test_rejects_a_job_that_is_not_the_contract_envelope() -> None:
    job = _FakeJob({"mediaId": "no-envelope"})
    with pytest.raises(ValueError, match="CONTRACTS section 3"):
        await process_transcribe(job)
