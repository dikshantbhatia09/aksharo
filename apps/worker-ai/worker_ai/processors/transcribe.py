"""``ai.transcribe`` processor — STUB.

A09 replaces the body: VAD-aligned chunking, provider routing, the alignment
registry and global diarisation, with the result posted back through the signed
completion callback (CONTRACTS section 3). A01 proves the wiring — a job arrives,
is validated against the envelope contract, is logged and completes.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from worker_ai.logging_setup import get_logger
from worker_ai.queues import parse_envelope

__all__ = ["process_transcribe"]

_log = get_logger(__name__)


async def process_transcribe(job: Any, token: str | None = None) -> dict[str, Any]:
    """Handle one ``ai.transcribe`` job.

    :param job: BullMQ ``Job``; typed as ``Any`` because the ``bullmq`` package
        ships no type information.
    :param token: BullMQ lock token, unused until A09 renews locks on long jobs.
    :returns: the job result, stored by BullMQ and forwarded to the API.
    :raises ValueError: when the job does not match the CONTRACTS envelope.
    """
    del token  # A09 uses this to extend the lock during long transcriptions.

    envelope = parse_envelope(job.data)
    media_id = envelope.payload.get("mediaId")

    _log.info(
        "ai.transcribe received",
        extra={
            "jobId": envelope.job_id,
            "attemptId": envelope.attempt_id,
            "workspaceId": envelope.workspace_id,
            "projectId": envelope.project_id,
            "mediaId": media_id,
            "bullJobId": getattr(job, "id", None),
        },
    )

    await job.updateProgress(100)

    result: dict[str, Any] = {
        "mediaId": media_id or "unknown",
        "words": [],
        "language": None,
        "transcribedAt": datetime.now(UTC).isoformat(),
        "stub": True,
    }

    _log.info(
        "ai.transcribe completed (stub)",
        extra={"jobId": envelope.job_id, "stub": True},
    )
    return result
