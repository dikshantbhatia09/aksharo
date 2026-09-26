"""The BullMQ handler: callback semantics and the retry contract with A08."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import pytest
from bullmq import UnrecoverableError

from worker_ai.callbacks import CallbackAck, JobCompletion
from worker_ai.processors import JobFailureError
from worker_ai.queues import AI_QUEUES, IMPLEMENTED_AI_QUEUES
from worker_ai.runtime import (
    PROCESSORS,
    build_services,
    close_services,
    drain,
    make_handler,
    queues_for,
)
from worker_ai.settings import load_settings

from .conftest import ATTEMPT_ID, JOB_ID, MEDIA_ID, VALID_ENV, FakeJob, envelope
from .test_processors import RecordingCallbacks, recorder
from .test_processors import build_services as build_test_services

# ---------------------------------------------------------------------------
# Queue wiring
# ---------------------------------------------------------------------------


def test_the_worker_owns_every_ai_queue_and_nothing_else() -> None:
    settings = load_settings(VALID_ENV)
    assert queues_for(settings) == AI_QUEUES
    assert all(name.startswith("ai.") for name in AI_QUEUES)
    # Ten since REP-005 added `ai.highlights`. The worker CONSUMES all ten and
    # implements nine; the tenth answers `worker/not_implemented` until Wave 4.
    assert len(AI_QUEUES) == 11


def test_every_implemented_queue_has_a_processor() -> None:
    assert set(PROCESSORS) == set(IMPLEMENTED_AI_QUEUES)


def test_a_registered_queue_without_a_processor_is_declared_not_implemented() -> None:
    """A queue in AI_QUEUES but not IMPLEMENTED_AI_QUEUES must be deliberate.

    The runtime answers `worker/not_implemented` for it, which is a clear failure
    for a producer rather than a job that waits in Redis forever. REP-005 created
    the first such queue; this pins the invariant so the next one is a decision
    rather than an oversight.
    """
    unimplemented = set(AI_QUEUES) - set(IMPLEMENTED_AI_QUEUES)
    assert unimplemented == set()
    assert not any(name in PROCESSORS for name in unimplemented)


def test_a_pool_can_be_pinned_to_a_subset_of_queues() -> None:
    settings = load_settings({**VALID_ENV, "WORKER_AI_QUEUES": "ai.vad, ai.transcribe"})
    assert queues_for(settings) == ("ai.vad", "ai.transcribe")


def test_a_queue_this_worker_does_not_own_is_refused() -> None:
    settings = load_settings({**VALID_ENV, "WORKER_AI_QUEUES": "ai.vad,media.probe"})
    with pytest.raises(ValueError, match=r"media\.probe"):
        queues_for(settings)


def test_build_services_wires_everything_from_the_environment() -> None:
    services = build_services(load_settings(VALID_ENV), callbacks=build_test_services().callbacks)
    assert services.routing.version == 2
    assert services.vad.name == "energy"
    assert services.aligners.resolve("hi").name == "proportional-vad"
    assert services.diarisers.resolve().name == "noop-single-speaker"
    # No R2 credentials in the test environment, so there is no store.
    assert services.derived_store is None


def test_build_services_creates_a_store_when_r2_is_configured() -> None:
    services = build_services(
        load_settings(
            {
                **VALID_ENV,
                "R2_ENDPOINT": "http://localhost:9000",
                "R2_BUCKET_DERIVED": "montaj-derived",
                "R2_ACCESS_KEY": "key",
                "R2_SECRET_KEY": "secret",
            }
        ),
        callbacks=build_test_services().callbacks,
    )
    assert services.derived_store is not None
    assert services.derived_store.bucket == "montaj-derived"


async def test_close_services_releases_the_clients() -> None:
    services = build_test_services()
    await close_services(services)


# ---------------------------------------------------------------------------
# The handler
# ---------------------------------------------------------------------------


async def test_a_successful_job_reports_progress_then_completes(wav_file: Path) -> None:
    services = build_test_services()
    handler = make_handler("ai.vad", services)
    job = FakeJob(envelope(mediaId=MEDIA_ID, audioUri=str(wav_file)))

    result = await handler(job, "lock-token")

    calls = recorder(services)
    assert calls.progress_calls[0][0] == 0
    assert calls.progress_calls[0][1] == "ai.vad started"
    assert len(calls.completions) == 1
    completion = calls.completions[0]
    assert completion.status == "succeeded"
    assert completion.result == result
    assert completion.usage is not None
    assert result["chunkPlan"][0]["startMs"] == 0


async def test_a_malformed_envelope_fails_before_any_callback() -> None:
    """There is no jobId to report against, so nothing is posted.

    The same bytes arrive on every attempt, so BullMQ is told not to retry.
    """
    services = build_test_services()
    handler = make_handler("ai.vad", services)

    with pytest.raises(UnrecoverableError, match="CONTRACTS section 3") as raised:
        await handler(FakeJob({"mediaId": "no-envelope"}), None)

    assert isinstance(raised.value.__cause__, ValueError)
    assert recorder(services).completions == []
    assert recorder(services).progress_calls == []


async def test_a_retryable_failure_with_attempts_left_posts_no_completion() -> None:
    """Completing now would move the row to `failed` and kill BullMQ's own retry."""
    services = build_test_services(store=_missing_object_store())
    handler = make_handler("ai.vad", services)
    job = FakeJob(envelope(mediaId=MEDIA_ID), attempts_made=0, attempts=2)

    with pytest.raises(JobFailureError, match=r"could not read") as raised:
        await handler(job, None)

    # The plain error, not BullMQ's UnrecoverableError: this one must be retried.
    assert not isinstance(raised.value, UnrecoverableError)
    assert recorder(services).completions == []


async def test_a_retryable_failure_on_the_final_attempt_completes_and_flags_it() -> None:
    services = build_test_services(store=_missing_object_store())
    handler = make_handler("ai.vad", services)
    job = FakeJob(envelope(mediaId=MEDIA_ID), attempts_made=1, attempts=2)

    with pytest.raises(JobFailureError, match=r"could not read"):
        await handler(job, None)

    completion = recorder(services).completions[0]
    assert completion.status == "failed"
    assert completion.final_attempt is True
    assert completion.error is not None
    assert completion.error.code == "worker/storage_unavailable"
    assert completion.error.retryable is True


async def test_a_non_retryable_failure_completes_on_the_first_attempt() -> None:
    """`retryable: false` is what sends the job to the dead-letter path (A08b)."""
    services = build_test_services()
    handler = make_handler("ai.not-implemented-test", services)
    job = FakeJob(envelope(), attempts_made=0, attempts=2)

    with pytest.raises(UnrecoverableError, match="not implemented"):
        await handler(job, None)

    completion = recorder(services).completions[0]
    assert completion.status == "failed"
    assert completion.error is not None
    assert completion.error.code == "worker/not_implemented"
    assert completion.error.retryable is False


async def test_a_non_retryable_failure_tells_bullmq_not_to_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BullMQ retries any exception except its own UnrecoverableError.

    Re-raising the JobFailureError itself ran a failed job again on attempts 2
    and 3 although the API had already dead-lettered the row after attempt 1.
    """
    services = build_test_services()
    runs: list[int] = []

    async def refuse(context: Any) -> None:
        runs.append(context.attempts_made)
        raise JobFailureError("worker/invalid_payload", "the payload is wrong", retryable=False)

    monkeypatch.setitem(PROCESSORS, "ai.vad", refuse)
    handler = make_handler("ai.vad", services)

    with pytest.raises(UnrecoverableError, match="the payload is wrong") as raised:
        await handler(FakeJob(envelope(), attempts_made=0, attempts=3), None)

    # The job's own failure travels as the cause, for the logs.
    assert isinstance(raised.value.__cause__, JobFailureError)
    assert raised.value.__cause__.code == "worker/invalid_payload"
    assert runs == [0]
    # Reported to the API before BullMQ is told, and reported once.
    completions = recorder(services).completions
    assert len(completions) == 1
    assert completions[0].error is not None
    assert completions[0].error.retryable is False


async def test_a_job_the_api_has_already_settled_is_not_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A redelivered job whose row is terminal would redo the work for nothing."""
    ran: list[str] = []

    async def must_not_run(context: Any) -> None:
        ran.append(context.queue)

    class _Settled(RecordingCallbacks):
        async def progress(
            self,
            job_id: str,
            attempt_id: str,
            progress: float,
            *,
            eta_ms: int | None = None,
            message: str | None = None,
        ) -> CallbackAck:
            await super().progress(job_id, attempt_id, progress, eta_ms=eta_ms, message=message)
            return CallbackAck(
                applied=False, job_id=job_id, status="failed", reason="already_completed"
            )

    services = build_test_services()
    object.__setattr__(services, "callbacks", _Settled())
    monkeypatch.setitem(PROCESSORS, "ai.vad", must_not_run)
    handler = make_handler("ai.vad", services)

    with pytest.raises(UnrecoverableError, match="already_completed"):
        await handler(FakeJob(envelope(), attempts_made=1, attempts=2), None)

    assert ran == []
    assert recorder(services).completions == []


@pytest.mark.parametrize(
    ("reason", "raises"),
    [("stale_attempt", True), ("already_completed", True), (None, False), ("other", False)],
)
async def test_only_a_settled_row_stops_the_job(
    monkeypatch: pytest.MonkeyPatch, reason: str | None, raises: bool
) -> None:
    """An `applied: false` ack for any other reason is not a refusal to run."""
    ran: list[str] = []

    async def processor(context: Any) -> None:
        ran.append(context.queue)

    class _Unapplied(RecordingCallbacks):
        async def progress(
            self,
            job_id: str,
            attempt_id: str,
            progress: float,
            *,
            eta_ms: int | None = None,
            message: str | None = None,
        ) -> CallbackAck:
            return CallbackAck(applied=False, job_id=job_id, status="running", reason=reason)

    services = build_test_services()
    object.__setattr__(services, "callbacks", _Unapplied())
    monkeypatch.setitem(PROCESSORS, "ai.vad", processor)
    handler = make_handler("ai.vad", services)

    if raises:
        with pytest.raises(UnrecoverableError):
            await handler(FakeJob(envelope()), None)
        assert ran == []
    else:
        await handler(FakeJob(envelope()), None)
        assert ran == ["ai.vad"]


async def test_a_failed_first_progress_call_does_not_stop_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No answer is not "settled": progress stays best-effort."""
    ran: list[str] = []

    async def processor(context: Any) -> None:
        ran.append(context.queue)

    class _NoProgress(RecordingCallbacks):
        async def progress(
            self,
            job_id: str,
            attempt_id: str,
            progress: float,
            *,
            eta_ms: int | None = None,
            message: str | None = None,
        ) -> CallbackAck:
            raise RuntimeError("the API is restarting")

    services = build_test_services()
    object.__setattr__(services, "callbacks", _NoProgress())
    monkeypatch.setitem(PROCESSORS, "ai.vad", processor)
    handler = make_handler("ai.vad", services)

    await handler(FakeJob(envelope()), None)

    assert ran == ["ai.vad"]
    assert recorder(services).completions[0].status == "succeeded"


async def test_an_unclassified_error_is_treated_as_transient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    services = build_test_services()

    async def explode(context: Any) -> None:
        raise ZeroDivisionError("a bug")

    monkeypatch.setitem(PROCESSORS, "ai.vad", explode)
    handler = make_handler("ai.vad", services)

    with pytest.raises(ZeroDivisionError):
        await handler(FakeJob(envelope(), attempts_made=1, attempts=2), None)

    completion = recorder(services).completions[0]
    assert completion.error is not None
    assert completion.error.code == "worker/unhandled"
    assert completion.error.retryable is True


async def test_a_failing_completion_callback_does_not_mask_the_job_failure() -> None:
    """The job's own error still surfaces - and BullMQ may retry it.

    The API never heard about this failure, so telling BullMQ "do not retry"
    would leave the row running for good: production has no stuck-job sweep.
    """

    class _Broken:
        async def progress(self, *args: Any, **kwargs: Any) -> Any:
            return None

        async def complete(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("the API is down")

        async def aclose(self) -> None:
            return None

    services = build_test_services()
    object.__setattr__(services, "callbacks", _Broken())
    handler = make_handler("ai.not-implemented-test", services)

    with pytest.raises(JobFailureError, match="not implemented") as raised:
        await handler(FakeJob(envelope(), attempts_made=0, attempts=2), None)

    assert not isinstance(raised.value, UnrecoverableError)


async def test_an_unreported_non_retryable_failure_is_reported_by_the_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The API restarting while the failure is posted must not strand the row.

    The first attempt cannot deliver its failure, so BullMQ retries; the retry
    fails the same way, delivers the report, and only then stops BullMQ.
    """

    class _DownOnce(RecordingCallbacks):
        def __init__(self) -> None:
            super().__init__()
            self.refused = 0

        async def complete(
            self, job_id: str, attempt_id: str, completion: JobCompletion
        ) -> CallbackAck:
            if self.refused == 0:
                self.refused += 1
                raise RuntimeError("the API is restarting")
            return await super().complete(job_id, attempt_id, completion)

    async def refuse(context: Any) -> None:
        raise JobFailureError("worker/invalid_payload", "the payload is wrong", retryable=False)

    callbacks = _DownOnce()
    services = build_test_services()
    object.__setattr__(services, "callbacks", callbacks)
    monkeypatch.setitem(PROCESSORS, "ai.vad", refuse)
    handler = make_handler("ai.vad", services)

    with pytest.raises(JobFailureError) as first:
        await handler(FakeJob(envelope(), attempts_made=0, attempts=2), None)
    assert not isinstance(first.value, UnrecoverableError)
    assert callbacks.completions == []

    with pytest.raises(UnrecoverableError, match="the payload is wrong"):
        await handler(FakeJob(envelope(), attempts_made=1, attempts=2), None)
    assert len(callbacks.completions) == 1
    assert callbacks.completions[0].error is not None
    assert callbacks.completions[0].error.retryable is False


def _scratch_directories() -> set[Path]:
    """Scratch directories this worker has left behind in the system temp area."""
    return set(Path(tempfile.gettempdir()).glob("montaj-*"))


async def test_the_scratch_directory_is_removed_even_when_a_job_fails() -> None:
    """Media reaches disk only inside the scratch directory, and only while it runs."""
    services = build_test_services(store=_missing_object_store())
    handler = make_handler("ai.vad", services)
    before = _scratch_directories()

    with pytest.raises(JobFailureError, match=r"could not read"):
        await handler(FakeJob(envelope(mediaId=MEDIA_ID)), None)

    assert _scratch_directories() - before == set()


async def test_the_handler_reads_the_attempt_budget_from_the_job_options() -> None:
    services = build_test_services()
    handler = make_handler("ai.not-implemented-test", services)

    job = FakeJob(envelope())
    job.opts = {}
    job.attempts = 1
    with pytest.raises(UnrecoverableError, match="not implemented"):
        await handler(job, None)
    assert recorder(services).completions[0].final_attempt is True


async def test_the_completion_is_addressed_to_the_envelopes_job_and_attempt(
    wav_file: Path,
) -> None:
    posted: list[tuple[str, str]] = []

    class _Recording(RecordingCallbacks):
        async def progress(
            self,
            job_id: str,
            attempt_id: str,
            progress: float,
            *,
            eta_ms: int | None = None,
            message: str | None = None,
        ) -> CallbackAck:
            posted.append((job_id, attempt_id))
            return await super().progress(
                job_id, attempt_id, progress, eta_ms=eta_ms, message=message
            )

        async def complete(
            self, job_id: str, attempt_id: str, completion: JobCompletion
        ) -> CallbackAck:
            posted.append((job_id, attempt_id))
            return await super().complete(job_id, attempt_id, completion)

    services = build_test_services()
    object.__setattr__(services, "callbacks", _Recording())
    handler = make_handler("ai.vad", services)
    await handler(FakeJob(envelope(mediaId=MEDIA_ID, audioUri=str(wav_file))), None)

    assert set(posted) == {(JOB_ID, ATTEMPT_ID)}


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------


async def test_drain_closes_every_worker() -> None:
    closed: list[str] = []

    class _Worker:
        def __init__(self, name: str) -> None:
            self.name = name

        async def close(self) -> None:
            closed.append(self.name)

    await drain([_Worker("a"), _Worker("b")])
    assert sorted(closed) == ["a", "b"]


async def test_drain_of_nothing_is_a_no_op() -> None:
    await drain([])


async def test_drain_survives_a_worker_that_refuses_to_close() -> None:
    class _Stuck:
        async def close(self) -> None:
            raise RuntimeError("redis went away")

    await drain([_Stuck()])


def _missing_object_store() -> Any:
    from worker_ai.storage import ObjectStore

    class _Missing:
        def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
            raise RuntimeError("NoSuchKey")

        def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
            raise RuntimeError("NoSuchKey")

        def upload_file(self, Filename: str, Bucket: str, Key: str) -> None:  # noqa: N803
            raise RuntimeError("NoSuchKey")

    return ObjectStore(bucket="derived", client=_Missing())
