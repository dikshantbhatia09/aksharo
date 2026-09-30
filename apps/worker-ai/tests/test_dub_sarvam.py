"""Sarvam's Dubbing API client (2026-10-04), against ``httpx2.MockTransport`` only.

No test here reaches the network: every request is answered by a handler in
this file, and every one it did not expect fails the test.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest

from worker_ai.dubbing.sarvam import (
    DubbingVendorError,
    SarvamDubbingClient,
)

KEY = "sk-test-not-a-real-key"
BASE = "https://api.sarvam.test"
UPLOAD = "https://sarvamdub.blob.core.windows.net/in/job-1/source.mp4?sv=2024&sig=SECRET"
JOB = "5f0c2d6e-8a1b-4c3d-9e7f-0a1b2c3d4e5f"

Handler = Callable[[httpx2.Request], httpx2.Response]


async def _no_sleep(_seconds: float) -> None:
    return None


def client_with(handler: Handler, *, max_attempts: int = 3) -> SarvamDubbingClient:
    return SarvamDubbingClient(
        KEY,
        base_url=BASE,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        max_attempts=max_attempts,
        sleep=_no_sleep,
    )


def ok(data: dict[str, Any]) -> httpx2.Response:
    return httpx2.Response(200, json={"status": "success", "data": data})


async def test_creates_one_job_for_every_language_with_the_safe_options() -> None:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return ok({"job_id": JOB, "upload_url": UPLOAD, "expires_in_hours": 24})

    created = await client_with(handler).create_job(
        source_language="en-IN",
        target_languages=["hi-IN", "ta-IN"],
        speakers=-1,
        job_name="aksharo-dub-x",
    )

    assert created.job_id == JOB
    assert created.upload_url == UPLOAD
    assert created.expires_in_hours == 24
    request = seen[0]
    assert (request.method, str(request.url)) == ("POST", f"{BASE}/dubbing/jobs")
    assert request.headers["api-subscription-key"] == KEY
    assert json.loads(request.content) == {
        "src_lang": "en-IN",
        "target_langs": ["hi-IN", "ta-IN"],
        "export_options": ["audio", "srt"],
        "voice_cloning": True,
        "num_speakers": -1,
        "disable_watermark": True,
        # True doubles the price: never.
        "editor_flow": False,
        "job_name": "aksharo-dub-x",
    }


async def test_uploads_to_the_signed_url_without_the_key(tmp_path: Path) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 3_000_000)
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(201)

    await client_with(handler).upload(UPLOAD, video, content_type="video/mp4")

    request = seen[0]
    assert request.method == "PUT"
    assert str(request.url) == UPLOAD
    assert "api-subscription-key" not in request.headers
    assert request.headers["x-ms-blob-type"] == "BlockBlob"
    assert request.headers["content-type"] == "video/mp4"
    assert request.headers["content-length"] == str(video.stat().st_size)
    assert "transfer-encoding" not in request.headers
    assert request.content == video.read_bytes()


@pytest.mark.parametrize(
    "url",
    [
        "http://sarvamdub.blob.core.windows.net/x?sig=1",
        "https://127.0.0.1/x",
        "https://localhost/x",
        "https://[::1]/x",
        "ftp://example.test/x",
    ],
)
async def test_never_sends_anything_to_an_address_a_response_should_not_name(
    url: str, tmp_path: Path
) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"x")

    def handler(request: httpx2.Request) -> httpx2.Response:
        raise AssertionError(f"no request should reach {request.url}")

    with pytest.raises(DubbingVendorError) as raised:
        await client_with(handler).upload(url, video, content_type="video/mp4")
    assert raised.value.retryable is False


async def test_a_bad_key_is_named_and_never_retried() -> None:
    calls: list[int] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        calls.append(1)
        return httpx2.Response(401, json={"detail": "Invalid API key"})

    with pytest.raises(DubbingVendorError) as raised:
        await client_with(handler).start(JOB)
    assert raised.value.code == "dub/vendor_auth"
    assert raised.value.retryable is False
    assert KEY not in raised.value.message
    assert calls == [1]


async def test_a_refusal_carries_the_vendors_own_words() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            422,
            json={
                "detail": [
                    {"loc": ["body", "target_langs", 0], "msg": "Input should be 'hi-IN'"},
                ]
            },
        )

    with pytest.raises(DubbingVendorError) as raised:
        await client_with(handler).create_job(
            source_language="en-IN", target_languages=["xx"], speakers=-1, job_name="j"
        )
    assert raised.value.code == "dub/vendor_refused"
    assert raised.value.retryable is False
    assert raised.value.message == "target_langs.0: Input should be 'hi-IN'"


async def test_a_plain_message_refusal_is_kept_and_cleaned() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            400,
            json={
                "status": "error",
                "message": "Audio has no speech\nsee https://blob.test/a?sig=SECRET",
            },
        )

    with pytest.raises(DubbingVendorError) as raised:
        await client_with(handler).start(JOB)
    assert raised.value.message == "Audio has no speech see https://blob.test/a"


async def test_a_busy_or_broken_vendor_is_retried_then_answers() -> None:
    answers = iter(
        [
            httpx2.Response(503),
            httpx2.Response(429, headers={"retry-after": "2"}),
            ok({"status": "in_progress", "progress": 40, "current_step_label": "Cloning voice"}),
        ]
    )

    def handler(request: httpx2.Request) -> httpx2.Response:
        return next(answers)

    status = await client_with(handler).live_status(JOB)
    assert status is not None
    assert (status.status, status.progress, status.step) == ("in_progress", 40.0, "Cloning voice")


async def test_a_vendor_that_stays_down_is_a_retryable_failure() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(502)

    with pytest.raises(DubbingVendorError) as raised:
        await client_with(handler).live_status(JOB)
    assert raised.value.code == "dub/vendor_unavailable"
    assert raised.value.retryable is True


async def test_a_connection_that_breaks_is_retried() -> None:
    attempts: list[int] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        attempts.append(1)
        if len(attempts) == 1:
            raise httpx2.ConnectError("reset", request=request)
        return ok({"status": "queued"})

    status = await client_with(handler).live_status(JOB)
    assert status is not None and status.status == "queued"
    assert len(attempts) == 2


async def test_an_unknown_job_is_none_not_an_error() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            404, json={"status": "error", "message": "Job not found", "code": "NotFoundError"}
        )

    assert await client_with(handler).live_status(JOB) is None


async def test_reads_every_export_even_those_without_a_download_url_yet() -> None:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return ok(
            {
                "exports": [
                    {
                        "id": "e1",
                        "target_language": "hi-IN",
                        "export_type": "audio",
                        "status": "completed",
                        "is_stale": False,
                        "created_at": "2026-10-04T10:00:00Z",
                        "completed_at": "2026-10-04T10:01:00Z",
                        "download_url": "https://blob.test/hi.mp3?sig=1",
                    },
                    {
                        "id": "e2",
                        "target_language": "hi-IN",
                        "export_type": "srt",
                        "status": "in_progress",
                        "is_stale": False,
                        "created_at": "2026-10-04T10:00:00Z",
                    },
                    "not an export",
                ]
            }
        )

    exports = await client_with(handler).export_status(JOB, limit=500)
    assert seen[0].url.params["limit"] == "100"
    assert [(e.id, e.export_type, e.status, e.download_url) for e in exports] == [
        ("e1", "audio", "completed", "https://blob.test/hi.mp3?sig=1"),
        ("e2", "srt", "in_progress", None),
    ]


async def test_downloads_a_file_without_the_key_and_refuses_a_runaway(tmp_path: Path) -> None:
    body = b"ID3" + b"\x00" * 5000

    def handler(request: httpx2.Request) -> httpx2.Response:
        assert "api-subscription-key" not in request.headers
        return httpx2.Response(200, content=body, headers={"content-type": "audio/mpeg"})

    client = client_with(handler)
    got = await client.download("https://blob.test/hi.mp3?sig=1", tmp_path / "a", max_bytes=10_000)
    assert (got.size_bytes, got.content_type) == (len(body), "audio/mpeg")
    assert (tmp_path / "a").read_bytes() == body

    with pytest.raises(DubbingVendorError) as raised:
        await client.download("https://blob.test/hi.mp3?sig=1", tmp_path / "b", max_bytes=100)
    assert raised.value.code == "dub/download_too_large"
    assert raised.value.retryable is False


async def test_an_expired_download_is_worth_another_attempt(tmp_path: Path) -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(403)

    with pytest.raises(DubbingVendorError) as raised:
        await client_with(handler).download(
            "https://blob.test/x?sig=old", tmp_path / "a", max_bytes=10
        )
    # A fresh export-status gives a fresh URL: the job, not the file, is retried.
    assert raised.value.retryable is True


async def test_a_cancel_of_a_finished_or_forgotten_job_is_not_an_error() -> None:
    answers = iter(
        [
            httpx2.Response(200, json={"status": "success"}),
            httpx2.Response(404, json={"message": "Job not found"}),
            httpx2.Response(409, json={"message": "Job already completed"}),
        ]
    )
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return next(answers)

    client = client_with(handler)
    assert await client.cancel(JOB) is True
    assert await client.cancel(JOB) is False
    assert await client.cancel(JOB) is False
    assert str(seen[0].url) == f"{BASE}/dubbing/jobs/{JOB}/cancel"


async def test_a_job_id_is_never_pasted_into_a_path_unless_it_is_an_id() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise AssertionError("no request")

    with pytest.raises(DubbingVendorError):
        await client_with(handler).start("../../admin")


def test_the_export_wait_outlasts_what_the_vendor_was_measured_to_take() -> None:
    # 2026-09-30, live: the audio and SRT of a completed dub were listed 54
    # minutes after live-status said completed, and a 20-minute wait failed
    # twice. The wait must cover that with room, without asking every 10 s.
    client = SarvamDubbingClient("key")
    assert client.export_timeout_s >= 90 * 60
    assert client.export_interval_s >= 30
