"""Mixdown -> upload -> transcribe orchestration for the C09 Studio panel's
"Caption this timeline" button (`transcribe.start` loopback method,
`server.py`'s `PanelDeps`).

Mirrors `plugins/premiere-uxp/src/upload/mixdown.ts`'s pipeline shape so the
two Workflow Integration surfaces behave the same way: an injectable mixdown
producer (rendering the current timeline's audio-only mixdown — the concrete
`ResolveHost` call for it is unconfirmed pending the A00-04 spike, so callers
inject `request_mixdown` rather than this module reaching into
`host/resolve.py` itself), an injectable uploader (bridge
`media.uploadTicket`, `bridge/protocol.py`) and a plain HTTP client for the
presigned PUT and `POST /transcripts/transcribe`
(`apps/api/src/transcripts/transcripts.controller.ts`). Fully testable
without Resolve, a bridge or a network.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

TranscribeStage = str  # "mixing" | "uploading" | "creating_project" | "done" | "error"


@dataclass(frozen=True, slots=True)
class MixdownResult:
    local_path: str
    duration_ms: int
    sample_rate: int


@dataclass(frozen=True, slots=True)
class UploadTicket:
    upload_url: str
    handle: str


class Uploader(Protocol):
    async def request_upload_ticket(self, handle: str) -> UploadTicket:
        """Bridge `media.uploadTicket` (mirrors the UXP flow's OPEN QUESTION
        in `mixdown.ts`: a same-machine, script-produced temp path needs the
        bridge to accept it as a `handle`)."""
        ...


class HttpClient(Protocol):
    async def put_binary(self, url: str, body: bytes, content_type: str) -> None: ...

    async def post_json(
        self, url: str, body: dict[str, Any], headers: dict[str, str]
    ) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class TranscribeProjectRequest:
    timeline_name: str
    language_hints: list[str]
    fps: float


@dataclass(frozen=True, slots=True)
class TranscribeProjectResult:
    project_id: str
    web_editor_url: str


@dataclass(frozen=True, slots=True)
class TranscribeOptions:
    request_mixdown: Callable[[], Awaitable[MixdownResult]]
    read_file: Callable[[str], Awaitable[bytes]]
    uploader: Uploader
    http: HttpClient
    api_origin: str
    session_token: str
    project: TranscribeProjectRequest
    on_stage_change: Callable[[TranscribeStage, dict[str, Any]], None] | None = None


class TranscribeError(Exception):
    pass


async def mixdown_and_transcribe(options: TranscribeOptions) -> TranscribeProjectResult:
    """Runs the whole pipeline; reports each stage via `on_stage_change`
    (mirrors `MixdownStageEvent`) and re-raises any failure as
    `TranscribeError` after reporting an `"error"` stage, matching
    `mixdown.ts`'s contract."""

    def emit(stage: TranscribeStage, **extra: Any) -> None:
        if options.on_stage_change is not None:
            options.on_stage_change(stage, extra)

    try:
        emit("mixing", fraction=0)
        mixdown = await options.request_mixdown()
        emit("uploading", fraction=0.3)
        ticket = await options.uploader.request_upload_ticket(mixdown.local_path)
        audio_bytes = await options.read_file(mixdown.local_path)
        await options.http.put_binary(ticket.upload_url, audio_bytes, "audio/wav")
        emit("creating_project", fraction=0.7)
        response = await options.http.post_json(
            f"{options.api_origin}/transcripts/transcribe",
            {
                "mediaHandle": ticket.handle,
                "sequenceName": options.project.timeline_name,
                "languageHints": options.project.language_hints,
                "fps": options.project.fps,
                "durationMs": mixdown.duration_ms,
            },
            {"authorization": f"Bearer {options.session_token}"},
        )
        result = TranscribeProjectResult(
            project_id=response["projectId"], web_editor_url=response["webEditorUrl"]
        )
        emit("done", fraction=1)
        return result
    except Exception as exc:
        emit("error", message=str(exc))
        raise TranscribeError(str(exc)) from exc


__all__ = [
    "HttpClient",
    "MixdownResult",
    "TranscribeError",
    "TranscribeOptions",
    "TranscribeProjectRequest",
    "TranscribeProjectResult",
    "UploadTicket",
    "Uploader",
    "mixdown_and_transcribe",
]
