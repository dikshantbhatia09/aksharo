"""Queue names and the job envelope, frozen in ``docs/CONTRACTS.md`` section 3.

These literals must stay byte-identical to the TypeScript side: the API enqueues
with the Node client and this worker consumes with the Python one, so a typo here
is a silently empty queue rather than a compile error.

``montaj`` inside queue names is the engineering codename and is correct — the
brand rule (CONTRACTS section 0) covers user-visible strings only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final, Literal

__all__ = [
    "AI_TRANSCRIBE_QUEUE",
    "QUEUE_NAMES",
    "JobEnvelope",
    "is_job_envelope",
    "parse_envelope",
]

QUEUE_NAMES: Final[tuple[str, ...]] = (
    "media.probe",
    "media.proxy",
    "ai.vad",
    "ai.transcribe",
    "ai.align",
    "ai.diarise",
    "ai.translate",
    "ai.transliterate",
    "ai.clean",
    "ai.pass",
    "ai.llm",
    "render.video",
    "render.subtitle",
    "notify",
)

#: The only queue A01 consumes. A09 adds ai.vad, ai.align, ai.diarise and the rest.
AI_TRANSCRIBE_QUEUE: Final[str] = "ai.transcribe"

CompletionStatus = Literal["succeeded", "failed"]


@dataclass(frozen=True, slots=True)
class JobEnvelope:
    """Every job's ``data``, identical across queues (CONTRACTS section 3)."""

    job_id: str
    attempt_id: str
    workspace_id: str
    priority: int
    #: Deduplication key: the same key must never run twice concurrently.
    job_key: str
    #: ISO-8601.
    created_at: str
    payload: dict[str, Any]
    project_id: str | None = None


_REQUIRED_FIELDS: Final[tuple[str, ...]] = (
    "jobId",
    "attemptId",
    "workspaceId",
    "jobKey",
    "createdAt",
    "payload",
)


def is_job_envelope(value: object) -> bool:
    """True when ``value`` carries every field the contract requires."""
    if not isinstance(value, dict):
        return False
    for field in _REQUIRED_FIELDS:
        if field not in value:
            return False
        if field != "payload" and not isinstance(value[field], str):
            return False
    return isinstance(value["payload"], dict)


def parse_envelope(data: object) -> JobEnvelope:
    """Convert BullMQ ``job.data`` into a :class:`JobEnvelope`.

    :raises ValueError: when the job does not match the contract. A malformed job
        is a producer bug, so it fails immediately instead of retrying forever.
    """
    if not is_job_envelope(data):
        raise ValueError("job data does not match the CONTRACTS section 3 envelope")

    assert isinstance(data, dict)  # noqa: S101 - narrowed by is_job_envelope
    project_id = data.get("projectId")
    priority = data.get("priority", 0)

    return JobEnvelope(
        job_id=str(data["jobId"]),
        attempt_id=str(data["attemptId"]),
        workspace_id=str(data["workspaceId"]),
        priority=int(priority) if isinstance(priority, int | float | str) else 0,
        job_key=str(data["jobKey"]),
        created_at=str(data["createdAt"]),
        payload=dict(data["payload"]),
        project_id=str(project_id) if isinstance(project_id, str) else None,
    )
