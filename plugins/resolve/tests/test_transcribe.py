from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from aksharo_core_app.transcribe import (
    MixdownResult,
    TranscribeError,
    TranscribeOptions,
    TranscribeProjectRequest,
    UploadTicket,
    mixdown_and_transcribe,
)


@dataclass
class FakeUploader:
    tickets: dict[str, UploadTicket] = field(default_factory=dict)

    async def request_upload_ticket(self, handle: str) -> UploadTicket:
        ticket = UploadTicket(upload_url=f"https://up.example/{handle}", handle=handle)
        self.tickets[handle] = ticket
        return ticket


@dataclass
class FakeHttp:
    put_calls: list[tuple[str, bytes, str]] = field(default_factory=list)
    post_calls: list[tuple[str, dict[str, Any], dict[str, str]]] = field(default_factory=list)
    post_response: dict[str, Any] = field(
        default_factory=lambda: {
            "projectId": "proj_1",
            "webEditorUrl": "https://aksharo.ai/e/proj_1",
        }
    )
    fail_put: bool = False

    async def put_binary(self, url: str, body: bytes, content_type: str) -> None:
        if self.fail_put:
            raise RuntimeError("upload failed")
        self.put_calls.append((url, body, content_type))

    async def post_json(
        self, url: str, body: dict[str, Any], headers: dict[str, str]
    ) -> dict[str, Any]:
        self.post_calls.append((url, body, headers))
        return self.post_response


async def _fake_mixdown() -> MixdownResult:
    return MixdownResult(local_path="mixdown-work/mix.wav", duration_ms=12_000, sample_rate=48_000)


async def _fake_read_file(path: str) -> bytes:
    assert path == "mixdown-work/mix.wav"
    return b"wav-bytes"


def _options(**overrides: Any) -> TranscribeOptions:
    base: dict[str, Any] = {
        "request_mixdown": _fake_mixdown,
        "read_file": _fake_read_file,
        "uploader": FakeUploader(),
        "http": FakeHttp(),
        "api_origin": "https://api.aksharo.ai",
        "session_token": "tok",
        "project": TranscribeProjectRequest(
            timeline_name="Timeline 1", language_hints=["en"], fps=25.0
        ),
    }
    base.update(overrides)
    return TranscribeOptions(**base)


async def test_mixdown_and_transcribe_happy_path() -> None:
    http = FakeHttp()
    stages: list[str] = []
    options = _options(http=http, on_stage_change=lambda stage, _extra: stages.append(stage))

    result = await mixdown_and_transcribe(options)

    assert result.project_id == "proj_1"
    assert result.web_editor_url == "https://aksharo.ai/e/proj_1"
    assert stages == ["mixing", "uploading", "creating_project", "done"]
    assert http.put_calls[0][2] == "audio/wav"
    assert http.post_calls[0][1]["sequenceName"] == "Timeline 1"
    assert http.post_calls[0][1]["durationMs"] == 12_000
    assert http.post_calls[0][2] == {"authorization": "Bearer tok"}


async def test_mixdown_and_transcribe_reports_and_reraises_on_failure() -> None:
    http = FakeHttp(fail_put=True)
    stages: list[str] = []
    options = _options(http=http, on_stage_change=lambda stage, _extra: stages.append(stage))

    with pytest.raises(TranscribeError):
        await mixdown_and_transcribe(options)

    assert stages == ["mixing", "uploading", "error"]
