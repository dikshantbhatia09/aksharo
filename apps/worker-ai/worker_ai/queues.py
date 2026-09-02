"""Queue names and the job envelope, frozen in ``docs/CONTRACTS.md`` section 3.

These literals must stay byte-identical to the TypeScript side: the API enqueues
with the Node client and this worker consumes with the Python one, so a typo here
is a silently empty queue rather than a compile error.
``apps/api/src/jobs/contracts/queue-names.test.ts`` parses this file and fails when
the two lists drift.

``montaj`` inside queue names is the engineering codename and is correct — the
brand rule (CONTRACTS section 0) covers user-visible strings only.
"""

from __future__ import annotations

from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

__all__ = [
    "AI_QUEUES",
    "AI_TRANSCRIBE_QUEUE",
    "IMPLEMENTED_AI_QUEUES",
    "QUEUE_NAMES",
    "CompletionStatus",
    "JobEnvelope",
    "bull_job_id",
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

#: Every queue this worker owns. `media.*`, `render.*` and `notify` belong to the
#: Node workers, so a job on one of them never reaches this process.
AI_QUEUES: Final[tuple[str, ...]] = tuple(name for name in QUEUE_NAMES if name.startswith("ai."))

#: The nine this worker implements (four from A09/A10, `ai.translate` and
#: `ai.transliterate` from A22, `ai.llm` from B11, `ai.pass` from B18,
#: `ai.clean` from B10); the rest are registered and answer `not_implemented`
#: so a producer gets a clear failure instead of a job that sits in Redis
#: forever. `ai.pass` itself still answers `worker/not_implemented` for any
#: `passType` other than `"autocut"` (`processors/autocut_pass.py`) — B19
#: adds `"reframe"`/`"zoom"` there.
IMPLEMENTED_AI_QUEUES: Final[tuple[str, ...]] = (
    "ai.vad",
    "ai.transcribe",
    "ai.align",
    "ai.diarise",
    "ai.translate",
    "ai.transliterate",
    "ai.llm",
    "ai.pass",
    "ai.clean",
)

AI_TRANSCRIBE_QUEUE: Final[str] = "ai.transcribe"

CompletionStatus = Literal["succeeded", "failed"]

_CONTRACT_MESSAGE: Final[str] = "job data does not match the CONTRACTS section 3 envelope"


class JobEnvelope(BaseModel):
    """Every job's ``data``, identical across queues (CONTRACTS section 3).

    Mirrors ``JobEnvelopeSchema`` in ``apps/api/src/jobs/contracts/job-envelope.ts``
    field for field, including the two rules a cross-language consumer depends on:
    every id is a **string**, and ``projectId`` is **omitted** rather than ``null``
    when the job has no project.
    """

    model_config = ConfigDict(populate_by_name=True, frozen=True, extra="ignore")

    job_id: str = Field(alias="jobId", min_length=1)
    attempt_id: str = Field(alias="attemptId", min_length=1)
    workspace_id: str = Field(alias="workspaceId", min_length=1)
    project_id: str | None = Field(default=None, alias="projectId", min_length=1)
    #: BullMQ priority; lower runs first, and the API never sends 0.
    priority: int = Field(default=0, ge=0)
    #: Deduplication key: the same key must never run twice concurrently.
    job_key: str = Field(alias="jobKey", min_length=1)
    #: ISO-8601.
    created_at: str = Field(alias="createdAt", min_length=1)
    payload: dict[str, Any]

    @property
    def bull_job_id(self) -> str:
        """The BullMQ custom id the API allocated: ``{jobId}-{attemptId}``."""
        return bull_job_id(self.job_id, self.attempt_id)

    def log_fields(self) -> dict[str, str]:
        """The identifiers every log line for this job carries."""
        fields = {
            "jobId": self.job_id,
            "attemptId": self.attempt_id,
            "workspaceId": self.workspace_id,
        }
        if self.project_id is not None:
            fields["projectId"] = self.project_id
        return fields


def bull_job_id(job_id: str, attempt_id: str) -> str:
    """BullMQ custom ids may not contain ``:`` — see ``queue.registry.ts``."""
    return f"{job_id}-{attempt_id}"


def is_job_envelope(value: object) -> bool:
    """True when ``value`` carries every field the contract requires."""
    if not isinstance(value, dict):
        return False
    try:
        JobEnvelope.model_validate(value)
    except ValidationError:
        return False
    return True


def parse_envelope(data: object) -> JobEnvelope:
    """Convert BullMQ ``job.data`` into a :class:`JobEnvelope`.

    :raises ValueError: when the job does not match the contract. A malformed job
        is a producer bug, so it fails immediately instead of retrying forever.
    """
    if not isinstance(data, dict):
        raise ValueError(_CONTRACT_MESSAGE)
    try:
        return JobEnvelope.model_validate(data)
    except ValidationError as error:
        fields = ", ".join(str(item["loc"][0]) for item in error.errors() if item["loc"])
        raise ValueError(f"{_CONTRACT_MESSAGE} ({fields})") from error
