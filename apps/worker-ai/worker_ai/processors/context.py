"""What a processor is handed, and how it reports progress.

One :class:`JobContext` per job. It owns the envelope, the collaborators the
runtime built once for the whole process, and the scratch directory the job's
audio lives in — and it deletes that directory when the job ends, which is the
only reason media ever touches this pod's disk.

Progress is throttled rather than sent per chunk: a 90-minute file is nine chunks
but a 6-hour file is thirty-six, and each callback is a signed HTTP round trip
plus a Postgres write plus a WebSocket fan-out (`jobs.service.ts`). One percent of
movement, or three seconds, is the floor.

There is a ceiling too, and it is the more important number. **The progress
callback is the heartbeat** (A08b, `jobs.config.ts`): a worker that goes quiet for
longer than its queue's lock is declared stalled and its job is handed to a second
worker while the first is still running it. :meth:`JobContext.heartbeat` posts the
last known percentage whenever `heartbeat_interval_ms` has passed, so a chunk that
takes ten minutes to transcribe still keeps its job alive.
"""

from __future__ import annotations

import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from worker_ai.alignment import AlignerRegistry
from worker_ai.cache import NullResultCache, ResultCache, content_hash
from worker_ai.callbacks import CallbackAck, CallbackClient, JobUsage
from worker_ai.diarisation import DiariserRegistry
from worker_ai.lid import LanguageIdentifier, TextClassifier
from worker_ai.llm.providers.base import LlmProvider
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.logging_setup import get_logger
from worker_ai.policies import heartbeat_interval_ms, queue_policy_for
from worker_ai.providers.base import ProviderSubmission
from worker_ai.providers.registry import ProviderRegistry
from worker_ai.queues import JobEnvelope
from worker_ai.routing import RoutingTable
from worker_ai.settings import Settings
from worker_ai.storage import ObjectStore
from worker_ai.translate.providers.base import TranslationProvider
from worker_ai.transliterate import RuleTableTransliterationProvider, TransliterationProvider
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

    ``retryable=False`` completes the job as failed immediately, sends it to the
    dead-letter path, and is raised to BullMQ as its ``UnrecoverableError`` so
    the job is not run again (``runtime.make_handler``); ``True`` lets BullMQ
    retry until its attempts run out.
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
    #: The `09 §1` result cache. Never ``None``: a deployment without Redis gets
    #: :class:`~worker_ai.cache.NullResultCache`, so no call site needs a guard.
    cache: ResultCache = field(default_factory=NullResultCache)
    #: Signal 1 of the two-signal LID (D14). ``None`` when no acoustic LID model
    #: is installed, in which case the routed provider's own answer is used.
    language_id: LanguageIdentifier | None = None
    #: Signal 2: the local text classifier. ``None`` builds the default.
    text_lid: TextClassifier | None = None
    #: The A22 transliteration provider (`ai.transliterate`). Defaults to the
    #: dependency-free rule-table provider so a deployment with no
    #: `WORKER_AI_INDICXLIT_URL` still runs the queue.
    transliteration: TransliterationProvider = field(
        default_factory=RuleTableTransliterationProvider
    )
    #: The A22 translation provider chain (`ai.translate`), tried in order.
    #: Empty by default; `runtime.build_services` always supplies at least the
    #: LLM adapter (`mock` needs no credential), so this default only matters
    #: for a `Services` built directly in a unit test.
    translation_providers: tuple[TranslationProvider, ...] = ()
    #: The B11 `ai.llm` provider chain (primary, then fallback), tried in
    #: order and filtered by region compliance (`worker_ai.llm.region`).
    #: Defaults to the mock so a `Services` built directly in a unit test still
    #: runs the queue.
    llm_providers: tuple[LlmProvider, ...] = (MockLlmProvider(),)


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
    _content_digest: str = ""

    @property
    def settings(self) -> Settings:
        return self.services.settings

    @property
    def heartbeat_interval_s(self) -> float:
        """How often this queue's lock needs a progress call (A08b)."""
        return heartbeat_interval_ms(self.queue) / 1000

    @property
    def lock_duration_ms(self) -> int:
        """The lock this job is holding, for logging when a beat is late."""
        return queue_policy_for(self.queue).lock_duration_ms

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

    def content_digest(self, path: Path) -> str:
        """SHA-256 of the job's audio, computed once and remembered.

        The cache key of `09 §1` starts with a content hash. The media row does
        not carry one yet, so it is computed here — once per job, however many
        chunks the plan has, because hashing a two-hour wav three times would
        cost more than the cache saves.
        """
        if not self._content_digest:
            try:
                self._content_digest = content_hash(path)
            except OSError as error:  # a cache miss is always a safe answer
                _log.warning("could not hash the audio", extra={"reason": str(error)[:200]})
                return ""
        return self._content_digest

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

    async def start(self, *, message: str | None = None) -> CallbackAck | None:
        """The first progress call (0%), unthrottled, and the API's answer to it.

        The answer is the runtime's only chance to learn, before doing any work,
        that the row is already settled (``applied: false``). ``None`` when the
        call itself failed, which - like every progress call - is not fatal.
        """
        return await self._post_progress(0, message=message)

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
        await self._post_progress(percent, message=message, eta_ms=eta_ms)

    async def heartbeat(self, message: str | None = None) -> None:
        """Keep the job's lock alive when nothing has changed (A08b).

        Called from the slow paths — a chunk in flight, a batch vendor being
        polled — where minutes pass with no progress to report. It posts only when
        the heartbeat interval has actually elapsed, so calling it in a tight loop
        is free.
        """
        if time.monotonic() - self._last_progress_at < self.heartbeat_interval_s:
            return
        percent = self._last_progress if self._last_progress >= 0 else 0.0
        await self._post_progress(percent, message=message or "still working")

    async def _post_progress(
        self, percent: float, *, message: str | None = None, eta_ms: int | None = None
    ) -> CallbackAck | None:
        """The one call site that touches the progress endpoint."""
        self._last_progress = percent
        self._last_progress_at = time.monotonic()
        try:
            return await self.services.callbacks.progress(
                self.envelope.job_id,
                self.envelope.attempt_id,
                percent,
                message=message,
                eta_ms=eta_ms,
            )
        except Exception as error:  # progress is best-effort
            _log.warning(
                "progress callback failed",
                extra={
                    **self.envelope.log_fields(),
                    "queue": self.queue,
                    "lockDurationMs": self.lock_duration_ms,
                    "reason": str(error)[:200],
                },
            )
            return None
