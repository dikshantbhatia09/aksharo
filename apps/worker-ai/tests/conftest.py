"""Shared fixtures: valid environments, fake jobs, synthetic audio, a fake API."""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from worker_ai.audio import Pcm, write_wav
from worker_ai.settings import Settings, load_settings

CALLBACK_SECRET = "a" * 64

VALID_ENV: dict[str, str] = {
    "REDIS_URL": "redis://localhost:6379",
    "API_ORIGIN": "http://localhost:3001",
    "INTERNAL_CALLBACK_SECRET": CALLBACK_SECRET,
}

#: Valid ULIDs (Crockford base32, no I/L/O/U).
JOB_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6V9"
ATTEMPT_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VA"
WORKSPACE_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VB"
PROJECT_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VC"
MEDIA_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VD"


def envelope(**payload: Any) -> dict[str, Any]:
    """A CONTRACTS section 3 envelope carrying ``payload``."""
    return {
        "jobId": JOB_ID,
        "attemptId": ATTEMPT_ID,
        "workspaceId": WORKSPACE_ID,
        "projectId": PROJECT_ID,
        "priority": 3,
        "jobKey": f"ai.transcribe:{MEDIA_ID}",
        "createdAt": "2026-09-02T10:00:00.000Z",
        "payload": dict(payload),
    }


class FakeJob:
    """Stands in for a BullMQ ``Job``, which ships no type information."""

    def __init__(
        self, data: object, *, attempts_made: int = 0, attempts: int = 2, job_id: str = "1"
    ) -> None:
        self.id = job_id
        self.data = data
        self.attemptsMade = attempts_made
        # BullMQ mirrors the option onto the job itself; the runtime falls back
        # to it when `opts` is missing, so the fake carries both.
        self.attempts = attempts
        self.opts: dict[str, Any] = {"attempts": attempts}
        self.progress: float | None = None

    async def updateProgress(self, value: float) -> None:  # noqa: N802 - BullMQ's name
        self.progress = value


@pytest.fixture
def settings() -> Settings:
    """A minimal valid environment."""
    return load_settings(VALID_ENV)


# ---------------------------------------------------------------------------
# Synthetic audio
# ---------------------------------------------------------------------------


def tone(duration_ms: int, *, sample_rate: int = 16_000, amplitude: float = 0.4) -> np.ndarray:
    """A 220 Hz tone: loud, so the energy VAD reads it as speech."""
    samples = int(sample_rate * duration_ms / 1000)
    time_axis = np.arange(samples, dtype=np.float32) / sample_rate
    return (amplitude * np.sin(2 * np.pi * 220 * time_axis)).astype(np.float32)


def silence(duration_ms: int, *, sample_rate: int = 16_000) -> np.ndarray:
    """Digital silence with a whisper of dither, as a real recording has."""
    samples = int(sample_rate * duration_ms / 1000)
    return (np.zeros(samples, dtype=np.float32) + 1e-5).astype(np.float32)


def clip(*spans: tuple[str, int], sample_rate: int = 16_000) -> Pcm:
    """Build a clip from ``("speech" | "silence", durationMs)`` spans."""
    pieces = [
        tone(duration, sample_rate=sample_rate)
        if kind == "speech"
        else silence(duration, sample_rate=sample_rate)
        for kind, duration in spans
    ]
    return Pcm(samples=np.concatenate(pieces), sample_rate=sample_rate)


@pytest.fixture
def two_silence_clip() -> Pcm:
    """Speech · silence · speech · silence · speech — the acceptance fixture."""
    return clip(
        ("speech", 1_000),
        ("silence", 600),
        ("speech", 1_200),
        ("silence", 800),
        ("speech", 900),
    )


@pytest.fixture
def wav_file(tmp_path: Path, two_silence_clip: Pcm) -> Path:
    """The same clip written to disk as 16 kHz mono PCM."""
    return write_wav(tmp_path / "audio16k.wav", two_silence_clip)


# ---------------------------------------------------------------------------
# A test server implementing the CONTRACTS section 3 callback surface
# ---------------------------------------------------------------------------


@dataclass
class RecordedCall:
    """One request the fake API received."""

    path: str
    headers: dict[str, str]
    body: bytes

    @property
    def json(self) -> dict[str, Any]:
        parsed = json.loads(self.body.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}

    @property
    def attempt_id(self) -> str:
        return self.headers.get("x-montaj-attempt", "")

    def signature_matches(self, secret: str) -> bool:
        """Verify exactly as ``internal-signature.ts`` does."""
        timestamp = self.headers.get("x-montaj-timestamp", "")
        mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
        mac.update(f"{timestamp}.".encode())
        mac.update(self.body)
        return hmac.compare_digest(mac.hexdigest(), self.headers.get("x-montaj-signature", ""))


@dataclass
class FakeApi:
    """A real HTTP server that verifies signatures the way the API does."""

    origin: str
    secret: str
    calls: list[RecordedCall] = field(default_factory=list)
    #: Status codes to answer with, consumed in order; the default is 200.
    responses: list[int] = field(default_factory=list)
    #: Whether the next reply says the call was applied.
    applied: bool = True

    def call_paths(self) -> list[str]:
        return [call.path for call in self.calls]

    def completions(self) -> list[RecordedCall]:
        return [call for call in self.calls if call.path.endswith("/complete")]

    def progresses(self) -> list[RecordedCall]:
        return [call for call in self.calls if call.path.endswith("/progress")]


@pytest.fixture
def fake_api() -> Any:
    """Start a threaded HTTP server implementing the internal callback contract."""
    state = FakeApi(origin="", secret=CALLBACK_SECRET)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length)
            call = RecordedCall(
                path=self.path,
                headers={key.lower(): value for key, value in self.headers.items()},
                body=body,
            )
            state.calls.append(call)

            status = state.responses.pop(0) if state.responses else 200
            if not call.signature_matches(state.secret):
                status = 401

            payload = json.dumps(
                {
                    "applied": state.applied and status == 200,
                    "jobId": self.path.split("/")[3] if len(self.path.split("/")) > 3 else "",
                    "status": "running" if self.path.endswith("/progress") else "succeeded",
                }
            ).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            """Silence the default stderr access log."""

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.origin = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def wav_file_size(wav_file: Path) -> int:
    """The fixture's size on disk, read outside the event loop."""
    return wav_file.stat().st_size
