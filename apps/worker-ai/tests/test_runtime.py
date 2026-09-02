"""The BullMQ handler: callback semantics and the retry contract with A08."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import pytest

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
    assert len(AI_QUEUES) == 9


def test_every_implemented_queue_has_a_processor() -> None:
    assert set(PROCESSORS) == set(IMPLEMENTED_AI_QUEUES)


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
    """There is no jobId to report against, so nothing is posted."""
    services = build_test_services()
    handler = make_handler("ai.vad", services)

    with pytest.raises(ValueError, match="CONTRACTS section 3"):
        await handler(FakeJob({"mediaId": "no-envelope"}), None)

    assert recorder(services).completions == []
    assert recorder(services).progress_calls == []


async def test_a_retryable_failure_with_attempts_left_posts_no_completion() -> None:
    """Completing now would move the row to `failed` and kill BullMQ's own retry."""
    services = build_test_services(store=_missing_object_store())
    handler = make_handler("ai.vad", services)
    job = FakeJob(envelope(mediaId=MEDIA_ID), attempts_made=0, attempts=2)

    with pytest.raises(JobFailureError, match=r"could not read"):
        await handler(job, None)

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

    with pytest.raises(JobFailureError, match="not implemented"):
        await handler(job, None)

    completion = recorder(services).completions[0]
    assert completion.status == "failed"
    assert completion.error is not None
    assert completion.error.code == "worker/not_implemented"
    assert completion.error.retryable is False


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

    with pytest.raises(JobFailureError, match="not implemented"):
        await handler(FakeJob(envelope()), None)


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
    with pytest.raises(JobFailureError, match="not implemented"):
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
