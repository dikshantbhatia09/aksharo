"""``ai.dub``: the job flow against a scripted vendor (``httpx2.MockTransport``).

The vendor here is :class:`FakeSarvam`, a state machine answering the six calls
the way the contract says Sarvam does; the API is :class:`DubCallbacks`, which
records beats and checkpoints and can say the row was settled. Nothing leaves
the process. What these tests hold to, above all: the vendor's job id is
recorded before the job is started, and no attempt ever starts a second job
while a first one can still be resumed.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import httpx2
import pytest

from worker_ai.callbacks import CallbackAck, CallbackClient, CallbackError, JobCompletion
from worker_ai.dubbing.contracts import DubCancelResult, DubRunResult
from worker_ai.dubbing.sarvam import DubExport, SarvamDubbingClient
from worker_ai.processors.context import JobContext, JobFailureError, JobSettledError
from worker_ai.processors.dub import (
    ExportPlan,
    plan_exports,
    process_dub,
    sniff_audio_extension,
    vendor_paise,
)
from worker_ai.queues import parse_envelope
from worker_ai.storage import ObjectStore

from .conftest import envelope
from .test_processors import build_services

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "repurpose-contracts" / "fixtures"
PAYLOAD: dict[str, Any] = json.loads(
    (FIXTURES / "ai-dub-payload.v1.json").read_text(encoding="utf-8")
)
FRESH: dict[str, Any] = {key: value for key, value in PAYLOAD.items() if key != "resumeVendorJobId"}
PREFIX = str(PAYLOAD["destinationPrefix"])
SOURCE_KEY = str(PAYLOAD["source"]["key"])
BASE = "https://api.sarvam.test"
BLOB = "https://sarvamdub.blob.core.windows.net"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 2000
SRT = "1\n00:00:00,000 --> 00:00:02,500\nनमस्ते दोस्तों\n\n".encode()


async def _no_sleep(_seconds: float) -> None:
    return None


class FakeSarvam:
    """Sarvam's Dubbing API, scripted per test."""

    def __init__(
        self,
        *,
        statuses: list[dict[str, Any] | int] | None = None,
        exports: list[list[dict[str, Any]]] | None = None,
        create_status: int = 200,
        create_body: dict[str, Any] | None = None,
        start_status: int = 200,
        upload_status: int = 201,
    ) -> None:
        self.statuses = statuses or [{"status": "completed", "progress": 100}]
        self.exports = exports or [ready_exports("hi-IN", "ta-IN")]
        self.create_status = create_status
        self.create_body = create_body
        self.start_status = start_status
        self.upload_status = upload_status
        self.created: list[dict[str, Any]] = []
        self.started: list[str] = []
        self.uploaded: list[bytes] = []
        self.cancelled: list[str] = []
        self.polled = 0
        self.downloads: list[str] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        path = request.url.path
        if request.method == "POST" and path == "/dubbing/jobs":
            if self.create_status != 200:
                return httpx2.Response(self.create_status, json=self.create_body or {})
            self.created.append(json.loads(request.content))
            job = f"job-{len(self.created)}"
            return _ok({"job_id": job, "upload_url": f"{BLOB}/in/{job}/source.mp4?sig=S"})
        if request.method == "PUT" and str(request.url).startswith(BLOB):
            assert "api-subscription-key" not in request.headers
            self.uploaded.append(request.content)
            return httpx2.Response(self.upload_status)
        if request.method == "POST" and path.endswith("/start"):
            self.started.append(path.split("/")[3])
            return httpx2.Response(self.start_status, json={"message": "start refused"})
        if request.method == "POST" and path.endswith("/cancel"):
            self.cancelled.append(path.split("/")[3])
            return httpx2.Response(200, json={"status": "success"})
        if request.method == "GET" and path.endswith("/live-status"):
            answer = self.statuses[min(self.polled, len(self.statuses) - 1)]
            self.polled += 1
            if isinstance(answer, int):
                return httpx2.Response(answer, json={"message": "Job not found"})
            return _ok(answer)
        if request.method == "GET" and path.endswith("/export-status"):
            index = min(self.polled_exports, len(self.exports) - 1)
            self.polled_exports += 1
            return _ok({"exports": self.exports[index]})
        if request.method == "GET" and str(request.url).startswith("https://files.test/"):
            assert "api-subscription-key" not in request.headers
            self.downloads.append(path)
            if path.endswith(".srt"):
                return httpx2.Response(200, content=SRT, headers={"content-type": "text/plain"})
            return httpx2.Response(200, content=MP3, headers={"content-type": "audio/mpeg"})
        raise AssertionError(f"unexpected vendor call {request.method} {request.url}")

    polled_exports = 0


def _ok(data: dict[str, Any]) -> httpx2.Response:
    return httpx2.Response(200, json={"status": "success", "data": data})


def export(
    language: str, kind: str, *, status: str = "completed", url: bool = True, stale: bool = False
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": f"{language}-{kind}",
        "target_language": language,
        "export_type": kind,
        "status": status,
        "is_stale": stale,
        "created_at": "2026-10-04T10:00:00Z",
        "completed_at": "2026-10-04T10:05:00Z" if status == "completed" else None,
    }
    if url and status == "completed":
        ext = "srt" if kind == "srt" else "mp3"
        entry["download_url"] = f"https://files.test/{language}/{kind}.{ext}?sig=S"
    return entry


def ready_exports(*languages: str) -> list[dict[str, Any]]:
    return [export(lang, kind) for lang in languages for kind in ("audio", "srt")]


class DubCallbacks(CallbackClient):
    """The API: records beats and checkpoints; can say the row was settled."""

    def __init__(self) -> None:
        super().__init__("http://callbacks.invalid", "r" * 64)
        self.progress_calls: list[tuple[float, str | None]] = []
        self.checkpoints: list[dict[str, Any]] = []
        self.checkpoint_messages: list[str | None] = []
        self.completions: list[JobCompletion] = []
        #: After this many beats, every answer says the row is settled.
        self.settle_after: int | None = None
        self.settle_reason = "already_completed"
        self.checkpoint_error: Exception | None = None
        self.checkpoint_reason: str | None = None

    async def progress(
        self,
        job_id: str,
        attempt_id: str,
        progress: float,
        *,
        eta_ms: int | None = None,
        message: str | None = None,
    ) -> CallbackAck:
        self.progress_calls.append((progress, message))
        if self.settle_after is not None and len(self.progress_calls) > self.settle_after:
            return CallbackAck(
                applied=False, job_id=job_id, status="cancelled", reason=self.settle_reason
            )
        return CallbackAck(applied=True, job_id=job_id, status="running")

    async def checkpoint(
        self,
        job_id: str,
        attempt_id: str,
        progress: float,
        checkpoint: dict[str, str | int | float | bool | None],
        *,
        message: str | None = None,
    ) -> CallbackAck:
        if self.checkpoint_error is not None:
            raise self.checkpoint_error
        if self.checkpoint_reason is not None:
            return CallbackAck(
                applied=False, job_id=job_id, status="cancelled", reason=self.checkpoint_reason
            )
        self.checkpoints.append(dict(checkpoint))
        self.checkpoint_messages.append(message)
        return CallbackAck(
            applied=True, job_id=job_id, status="running", checkpoint=dict(checkpoint)
        )

    async def complete(
        self, job_id: str, attempt_id: str, completion: JobCompletion
    ) -> CallbackAck:
        self.completions.append(completion)
        return CallbackAck(applied=True, job_id=job_id, status=completion.status)


class MemoryS3:
    """The derived store: the clip's clean video in, the dubbed files out."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {SOURCE_KEY: b"\x00\x00\x00\x18ftypmp42clean-video"}
        self.written: dict[str, bytes] = {}

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
        if Key not in self.objects:
            raise RuntimeError("NoSuchKey")
        Path(Filename).write_bytes(self.objects[Key])

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        return {"ContentLength": len(self.objects.get(Key, b""))}

    def upload_file(self, Filename: str, Bucket: str, Key: str) -> None:  # noqa: N803
        self.written[Key] = Path(Filename).read_bytes()


def harness(
    vendor: FakeSarvam,
    payload: dict[str, Any] | None = None,
    *,
    checkpoint: dict[str, Any] | None = None,
    poll_timeout_s: float = 3600.0,
) -> tuple[JobContext, DubCallbacks, MemoryS3]:
    s3 = MemoryS3()
    callbacks = DubCallbacks()
    client = SarvamDubbingClient(
        "sk-test",
        base_url=BASE,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(vendor)),
        sleep=_no_sleep,
        poll_timeout_s=poll_timeout_s,
        export_timeout_s=60.0,
    )
    services = dataclasses.replace(
        build_services(store=ObjectStore(bucket="derived", client=s3)),
        callbacks=callbacks,
        dubbing=client,
    )
    context = JobContext(
        envelope=parse_envelope(envelope(**(payload or FRESH))),
        queue="ai.dub",
        services=services,
        max_attempts=2,
    )
    if checkpoint is not None:
        context.start_ack = CallbackAck(
            applied=True, job_id="j", status="running", checkpoint=checkpoint
        )
    return context, callbacks, s3


# ---------------------------------------------------------------------------
# A first attempt
# ---------------------------------------------------------------------------


async def test_records_the_vendor_job_before_it_starts_it_then_files_every_language() -> None:
    vendor = FakeSarvam(
        statuses=[
            {"status": "queued", "progress": 0, "current_step_label": "Waiting"},
            {"status": "in_progress", "progress": 20},
            {"status": "in_progress", "progress": 60, "current_step_label": "Cloning the voice"},
            {"status": "completed", "progress": 100},
        ],
        exports=[
            # Right after completion the audio is listed without its URL yet.
            [export("hi-IN", "audio", url=False), export("hi-IN", "srt")],
            ready_exports("hi-IN", "ta-IN"),
        ],
    )
    context, callbacks, s3 = harness(vendor)

    outcome = await process_dub(context)
    context.cleanup()

    # One vendor job, created, recorded, uploaded, then started - in that order.
    assert len(vendor.created) == 1
    assert vendor.created[0]["target_langs"] == ["hi-IN", "ta-IN"]
    assert vendor.created[0]["src_lang"] == "en-IN"
    assert callbacks.checkpoints[0] == {"vendorJobId": "job-1", "vendorPhase": "created"}
    assert [c["vendorPhase"] for c in callbacks.checkpoints] == ["created", "uploaded", "started"]
    assert vendor.uploaded == [s3.objects[SOURCE_KEY]]
    assert vendor.started == ["job-1"]
    # Every poll is a heartbeat, with the vendor's own step; one without a
    # step says none, so the page shows the percent alone.
    assert (55.0, "Cloning the voice") in callbacks.progress_calls
    assert (25.0, None) in callbacks.progress_calls
    # The run page shows these as the dub's step: none names the vendor.
    shown = [m for _, m in callbacks.progress_calls] + callbacks.checkpoint_messages
    assert [m for m in shown if m is not None and "sarvam" in m.lower()] == []

    result = DubRunResult.model_validate(outcome.result)
    assert result.vendor_job_id == "job-1"
    assert [(t.language, t.status) for t in result.tracks] == [
        ("hi-IN", "ready"),
        ("ta-IN", "ready"),
    ]
    hi = result.tracks[0]
    assert hi.audio is not None and hi.captions is not None
    assert hi.audio.key == f"{PREFIX}/hi-IN/audio.mp3"
    assert hi.captions.key == f"{PREFIX}/hi-IN/captions.srt"
    assert s3.written[f"{PREFIX}/hi-IN/audio.mp3"] == MP3
    assert s3.written[f"{PREFIX}/ta-IN/captions.srt"] == SRT
    assert outcome.usage is not None
    assert outcome.usage.provider == "sarvam"
    assert outcome.usage.cost_minor == vendor_paise(34_000, 2)


async def test_a_partial_failure_keeps_the_languages_that_came_back() -> None:
    vendor = FakeSarvam(
        statuses=[{"status": "partial_failure", "progress": 100}],
        exports=[ready_exports("hi-IN")],
    )
    context, _, _ = harness(vendor)

    result = DubRunResult.model_validate((await process_dub(context)).result)

    assert result.vendor_status == "partial_failure"
    assert [(t.language, t.status) for t in result.tracks] == [
        ("hi-IN", "ready"),
        ("ta-IN", "failed"),
    ]
    assert result.tracks[1].reason == "The dubbing service did not dub this language."


async def test_a_language_whose_export_failed_is_failed_not_waited_for() -> None:
    vendor = FakeSarvam(
        exports=[[*ready_exports("hi-IN"), export("ta-IN", "audio", status="failed")]],
    )
    context, _, _ = harness(vendor)
    result = DubRunResult.model_validate((await process_dub(context)).result)
    assert result.tracks[1].status == "failed"


async def test_nothing_back_for_any_language_is_the_vendors_failure() -> None:
    vendor = FakeSarvam(
        statuses=[{"status": "partial_failure"}],
        exports=[[export("hi-IN", "audio", status="failed")]],
    )
    context, _, _ = harness(vendor)
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert raised.value.code == "dub/vendor_failed"
    assert raised.value.retryable is False


async def test_a_vendor_failure_carries_its_own_words_and_is_not_retried() -> None:
    vendor = FakeSarvam(
        statuses=[
            {"status": "in_progress", "progress": 10},
            {"status": "failed", "error_message": "No speech detected in the input"},
        ]
    )
    context, _, _ = harness(vendor)
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert (raised.value.code, raised.value.message) == (
        "dub/vendor_failed",
        "No speech detected in the input",
    )
    assert raised.value.retryable is False
    assert len(vendor.created) == 1


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (401, {"detail": "Invalid API key"}, "dub/vendor_auth"),
        (422, {"detail": [{"loc": ["body", "src_lang"], "msg": "bad"}]}, "dub/vendor_refused"),
    ],
)
async def test_a_refused_create_is_named_and_final(
    status: int, body: dict[str, Any], code: str
) -> None:
    vendor = FakeSarvam(create_status=status, create_body=body)
    context, callbacks, _ = harness(vendor)
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert raised.value.code == code
    assert raised.value.retryable is False
    assert callbacks.checkpoints == []


async def test_a_vendor_that_stays_down_at_create_is_tried_again_later() -> None:
    vendor = FakeSarvam(create_status=503)
    context, _, _ = harness(vendor)
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert raised.value.code == "dub/vendor_unavailable"
    assert raised.value.retryable is True


# ---------------------------------------------------------------------------
# Never a second vendor job
# ---------------------------------------------------------------------------


async def test_a_checkpoint_that_did_not_land_never_starts_the_job() -> None:
    vendor = FakeSarvam()
    context, callbacks, _ = harness(vendor)
    callbacks.checkpoint_error = CallbackError("the API could not be reached")

    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)

    assert raised.value.code == "dub/checkpoint_unsaved"
    assert raised.value.retryable is True
    assert vendor.uploaded == []
    assert vendor.started == []
    # Created but never started: cancelled, so nothing is left behind.
    assert vendor.cancelled == ["job-1"]


async def test_resumes_the_job_its_own_row_recorded_and_never_creates_another() -> None:
    vendor = FakeSarvam(
        statuses=[{"status": "in_progress", "progress": 80}, {"status": "completed"}],
    )
    context, callbacks, _ = harness(
        vendor, checkpoint={"vendorJobId": "job-7", "vendorPhase": "started"}
    )

    result = DubRunResult.model_validate((await process_dub(context)).result)

    assert vendor.created == []
    assert vendor.started == []
    assert vendor.uploaded == []
    assert result.vendor_job_id == "job-7"
    assert callbacks.checkpoints == []


async def test_resumes_the_job_a_person_retried_and_says_so_on_its_own_row() -> None:
    """`resumeVendorJobId`: a new API job for a dub whose vendor job still stands."""
    vendor = FakeSarvam(statuses=[{"status": "completed"}])
    context, callbacks, _ = harness(vendor, PAYLOAD)

    result = DubRunResult.model_validate((await process_dub(context)).result)

    assert vendor.created == []
    assert result.vendor_job_id == PAYLOAD["resumeVendorJobId"]
    # So a cancel of THIS job finds the vendor job on its row.
    assert callbacks.checkpoints == [
        {"vendorJobId": PAYLOAD["resumeVendorJobId"], "vendorPhase": "started"}
    ]


@pytest.mark.parametrize("answer", [404, {"status": "failed", "error_message": "Voice unusable"}])
async def test_a_started_job_that_is_gone_or_failed_ends_the_attempt(
    answer: dict[str, Any] | int,
) -> None:
    vendor = FakeSarvam(statuses=[answer])
    context, _, _ = harness(vendor, checkpoint={"vendorJobId": "job-7", "vendorPhase": "started"})

    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)

    # Definitively failed: the person's Retry makes a new one, never this attempt.
    assert raised.value.code == "dub/vendor_failed"
    assert raised.value.retryable is False
    assert vendor.created == []


async def test_a_job_that_was_only_created_is_replaced_by_a_clean_one() -> None:
    """Whether its upload finished is unknown; it never started, so nothing was spent."""
    vendor = FakeSarvam(statuses=[{"status": "not_started"}, {"status": "completed"}])
    context, callbacks, _ = harness(
        vendor, checkpoint={"vendorJobId": "job-old", "vendorPhase": "created"}
    )

    result = DubRunResult.model_validate((await process_dub(context)).result)

    assert vendor.cancelled == ["job-old"]
    assert len(vendor.created) == 1
    assert result.vendor_job_id == "job-1"
    assert callbacks.checkpoints[0] == {"vendorJobId": "job-1", "vendorPhase": "created"}


async def test_an_uploaded_job_that_never_started_is_started_not_replaced() -> None:
    vendor = FakeSarvam(statuses=[{"status": "not_started"}, {"status": "completed"}])
    context, callbacks, _ = harness(
        vendor, checkpoint={"vendorJobId": "job-7", "vendorPhase": "uploaded"}
    )

    await process_dub(context)

    assert vendor.created == []
    assert vendor.started == ["job-7"]
    assert callbacks.checkpoints == [{"vendorJobId": "job-7", "vendorPhase": "started"}]


async def test_a_long_dub_is_left_to_the_next_attempt_rather_than_repeated() -> None:
    vendor = FakeSarvam(statuses=[{"status": "in_progress", "progress": 30}])
    context, _, _ = harness(vendor, poll_timeout_s=60.0)
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert raised.value.code == "dub/vendor_timeout"
    assert raised.value.retryable is True
    assert len(vendor.created) == 1


async def test_files_that_never_appear_are_fetched_by_a_later_attempt() -> None:
    vendor = FakeSarvam(exports=[[export("hi-IN", "audio", status="in_progress")]])
    context, _, _ = harness(vendor)
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert raised.value.code == "dub/exports_pending"
    assert raised.value.retryable is True


# ---------------------------------------------------------------------------
# A person's cancel, and a row a newer attempt owns
# ---------------------------------------------------------------------------


async def test_a_cancel_seen_on_a_heartbeat_stops_the_vendor_job_too() -> None:
    vendor = FakeSarvam(statuses=[{"status": "in_progress", "progress": 20}])
    context, callbacks, _ = harness(vendor)
    callbacks.settle_after = 1

    with pytest.raises(JobSettledError):
        await process_dub(context)

    assert vendor.cancelled == ["job-1"]


async def test_a_row_a_newer_attempt_owns_keeps_the_vendor_job_for_it() -> None:
    vendor = FakeSarvam(statuses=[{"status": "in_progress", "progress": 20}])
    context, callbacks, _ = harness(vendor)
    callbacks.settle_after = 1
    callbacks.settle_reason = "stale_attempt"

    with pytest.raises(JobSettledError):
        await process_dub(context)

    assert vendor.cancelled == []


async def test_a_cancel_before_the_job_was_recorded_cancels_the_created_job() -> None:
    vendor = FakeSarvam()
    context, callbacks, _ = harness(vendor)
    callbacks.checkpoint_reason = "already_completed"

    with pytest.raises(JobSettledError):
        await process_dub(context)

    assert vendor.cancelled == ["job-1"]
    assert vendor.started == []


async def test_the_cancel_action_stops_the_vendor_job() -> None:
    vendor = FakeSarvam()
    payload = json.loads((FIXTURES / "ai-dub-cancel-payload.v1.json").read_text(encoding="utf-8"))
    context, _, _ = harness(vendor, payload)

    outcome = await process_dub(context)

    result = DubCancelResult.model_validate(outcome.result)
    assert result.cancelled is True
    assert vendor.cancelled == [payload["vendorJobId"]]


async def test_a_worker_without_a_key_says_so_and_spends_nothing() -> None:
    vendor = FakeSarvam()
    context, _, _ = harness(vendor)
    object.__setattr__(context, "services", dataclasses.replace(context.services, dubbing=None))
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert raised.value.code == "dub/not_configured"
    assert vendor.created == []


async def test_a_payload_that_is_not_ai_dub_is_refused_before_the_vendor() -> None:
    vendor = FakeSarvam()
    context, _, _ = harness(vendor, {**FRESH, "targetLanguages": ["en-IN"]})
    with pytest.raises(JobFailureError) as raised:
        await process_dub(context)
    assert raised.value.code == "worker/invalid_payload"
    assert vendor.created == []


# ---------------------------------------------------------------------------
# Pure pieces
# ---------------------------------------------------------------------------


def _export(**fields: Any) -> DubExport:
    base: dict[str, Any] = {
        "id": "e",
        "language": "hi-IN",
        "export_type": "audio",
        "status": "completed",
        "is_stale": False,
        "download_url": "https://files.test/a",
        "completed_at": "2026-10-04T10:00:00Z",
    }
    return DubExport(**{**base, **fields})


def test_prefers_a_fresh_export_and_the_newest_among_equals() -> None:
    stale = _export(id="stale", is_stale=True, completed_at="2026-10-04T12:00:00Z")
    older = _export(id="older", completed_at="2026-10-04T10:00:00Z")
    newer = _export(id="newer", completed_at="2026-10-04T11:00:00Z")
    srt = _export(id="srt", export_type="srt")
    plan = plan_exports([stale, older, newer, srt], ["hi-IN"], final_status="completed")
    assert isinstance(plan, ExportPlan)
    assert plan.ready["hi-IN"][0].id == "newer"


def test_a_language_with_nothing_listed_waits_after_completed_and_fails_after_partial() -> None:
    assert plan_exports([], ["hi-IN"], final_status="completed").pending == ["hi-IN"]
    assert "hi-IN" in plan_exports([], ["hi-IN"], final_status="partial_failure").failed


def test_an_export_without_its_url_is_still_coming() -> None:
    plan = plan_exports(
        [_export(download_url=None), _export(export_type="srt")],
        ["hi-IN"],
        final_status="completed",
    )
    assert plan.pending == ["hi-IN"]


@pytest.mark.parametrize(
    ("head", "content_type", "url", "expected"),
    [
        (b"RIFF\x00\x00\x00\x00WAVEfmt ", None, "", "wav"),
        (b"ID3\x04", "application/octet-stream", "", "mp3"),
        (b"\xff\xfb\x90\x00", None, "", "mp3"),
        (b"\xff\xf1\x50\x80", None, "", "aac"),
        (b"\x00\x00\x00\x20ftypM4A ", None, "", "m4a"),
        (b"OggS\x00", None, "", "ogg"),
        (b"fLaC", None, "", "flac"),
        (b"\x1a\x45\xdf\xa3", None, "", "webm"),
        (b"????", "audio/wav", "", "wav"),
        (b"????", None, "https://files.test/a/dub.opus?sig=1", "opus"),
        (b"<htm", "text/html", "https://files.test/a.mp3", None),
        (b'{"er', "application/json", "", None),
        (b"????", None, "https://files.test/a", None),
    ],
)
def test_reads_the_audio_type_from_the_file_itself(
    head: bytes, content_type: str | None, url: str, expected: str | None
) -> None:
    assert sniff_audio_extension(head, content_type, url) == expected


def test_prices_a_clip_the_way_the_vendor_does() -> None:
    # ₹40 a minute a language: a minute in two languages is ₹80.
    assert vendor_paise(60_000, 2) == 8_000
    assert vendor_paise(34_000, 1) == 2_267
