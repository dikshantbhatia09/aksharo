"""What a processor is handed, and how it reports progress.

One :class:`JobContext` per job. It owns the envelope, the collaborators the
runtime built once for the whole process, and the scratch directory the job's
audio lives in — and it deletes that directory when the job ends, which is the
only reason media ever touches this pod's disk.

Progress is throttled rather than sent per chunk: a 90-minute file is nine chunks
but a 6-hour file is thirty-six, and each callback is a signed HTTP round trip
plus a Postgres write plus a WebSocket fan-out (`jobs.service.ts`). One percent of
movement, or three seconds, is the floor.
"""

from __future__ import annotations

import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from worker_ai.alignment import AlignerRegistry
from worker_ai.callbacks import CallbackClient, JobUsage
from worker_ai.diarisation import DiariserRegistry
from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import ProviderSubmission
from worker_ai.providers.registry import ProviderRegistry
from worker_ai.queues import JobEnvelope
from worker_ai.routing import RoutingTable
from worker_ai.settings import Settings
from worker_ai.storage import ObjectStore
from worker_ai.vad import VadBackend

__all__ = ["JobContext", "JobFailureError", "ProcessorOutcome", "Services"]

_log = get_logger(__name__)

_MIN_PROGRESS_STEP = 1.0
_MIN_PROGRESS_INTERVAL_S = 3.0


@dataclass(frozen=True, slots=True)
class ProcessorOutcome:
    """What a processor hands back: the completion ``result`` and its ``usage``.

    Keeping usage out of ``result`` is deliberate — the API reads ``usage`` to
    settle credits and to fill ``jobs.provider`` / ``costMinor`` (CONTRACTS
    section 3), while ``result`` is opaque JSON it only stores.
    """

    result: dict[str, Any]
    usage: JobUsage | None = None


class JobFailureError(Exception):
    """A processor's own failure, carrying the CONTRACTS section 8 error code.

    ``retryable=False`` completes the job as failed immediately and sends it to
    the dead-letter path; ``True`` lets BullMQ retry until its attempts run out.
    """

    def __init__(self, code: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class Services:
    """Process-wide collaborators, built once by the runtime."""

    settings: Settings
    callbacks: CallbackClient
    providers: ProviderRegistry
    routing: RoutingTable
    aligners: AlignerRegistry
    diarisers: DiariserRegistry
    vad: VadBackend
    #: ``None`` when no derived bucket is configured — every audio-reading
    #: processor then fails with a clear message instead of a boto3 stack trace.
    derived_store: ObjectStore | None = None


@dataclass(slots=True)
class JobContext:
    """One job in flight."""

    envelope: JobEnvelope
    queue: str
    services: Services
    #: BullMQ's own attempt counter, used only to decide `finalAttempt`.
    attempts_made: int = 0
    max_attempts: int = 1
    submissions: list[ProviderSubmission] = field(default_factory=list)
    _workdir: Path | None = None
    _last_progress: float = -1.0
    _last_progress_at: float = 0.0

    @property
    def settings(self) -> Settings:
        return self.services.settings

    @property
    def final_attempt(self) -> bool:
        """True when BullMQ has no retry left after this run."""
        return self.attempts_made + 1 >= self.max_attempts

    @property
    def workdir(self) -> Path:
        """A private scratch directory, created on first use."""
        if self._workdir is None:
            self._workdir = Path(tempfile.mkdtemp(prefix=f"montaj-{self.envelope.job_id[:8]}-"))
        return self._workdir

    def cleanup(self) -> None:
        """Delete the scratch directory. Safe to call twice."""
        if self._workdir is not None:
            shutil.rmtree(self._workdir, ignore_errors=True)
            self._workdir = None

    def record(self, submissions: tuple[ProviderSubmission, ...]) -> None:
        """Remember external calls so the completion can carry them to the API."""
        self.submissions.extend(submissions)

    def submissions_wire(self) -> list[dict[str, Any]]:
        """``provider_submissions`` rows for the completion payload (`06`)."""
        return [submission.to_wire() for submission in self.submissions]

    def payload_str(self, key: str, *, required: bool = False, default: str = "") -> str:
        """Read a string from the job payload, failing the job when it is required."""
        value = self.envelope.payload.get(key)
        if isinstance(value, str) and value:
            return value
        if required:
            raise JobFailureError(
                "worker/invalid_payload",
                f"{self.queue} needs a {key} in the job payload",
                retryable=False,
            )
        return default

    async def progress(
        self, percent: float, *, message: str | None = None, eta_ms: int | None = None
    ) -> None:
        """Report progress, throttled, and never fatal.

        A dropped progress callback must not fail a job that is otherwise fine:
        the completion carries the truth, and the API's own sweeper handles a job
        that goes quiet.
        """
        now = time.monotonic()
        moved = percent - self._last_progress
        if (
            self._last_progress >= 0
            and moved < _MIN_PROGRESS_STEP
            and now - self._last_progress_at < _MIN_PROGRESS_INTERVAL_S
            and percent < 100
        ):
            return
        self._last_progress = percent
        self._last_progress_at = now
        try:
            await self.services.callbacks.progress(
                self.envelope.job_id,
                self.envelope.attempt_id,
                percent,
                message=message,
                eta_ms=eta_ms,
            )
        except Exception as error:
            _log.warning(
                "progress callback failed",
                extra={**self.envelope.log_fields(), "reason": str(error)[:200]},
            )
