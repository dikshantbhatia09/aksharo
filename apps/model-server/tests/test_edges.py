"""The edges: log redaction, the body limit, ffmpeg fallback and the entry points.

Everything here is a path that only runs when something has gone wrong, or when a
deployment is shaped unusually — which is exactly the code that is never
exercised by hand and therefore has to be exercised here.
"""

from __future__ import annotations

import io
import json
import logging
import struct
import wave
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from model_server.audio import decode_wav, load_audio
from model_server.batching import DynamicBatcher
from model_server.errors import AudioError, ModelServerError, error_body
from model_server.logging_setup import JsonFormatter, configure_logging, safe_extra, safe_uri
from model_server.models.aligner import CtcAligner
from model_server.models.registry import ModelRegistry
from model_server.settings import Settings
from tests.conftest import build_app, build_settings, inline, make_wav

# ---------------------------------------------------------------------------
# Logging: no audio, no transcript, no credential
# ---------------------------------------------------------------------------


def test_safe_extra_drops_media_transcript_and_credential_fields() -> None:
    fields = safe_extra(
        {
            "route": "/transcribe",
            "audio": "data:audio/wav;base64,AAAA",
            "words": ["toh", "aaj"],
            "text": "the whole transcript",
            "token": "secret",
            "authorization": "Bearer secret",
            "turns": [{"speaker": "SPEAKER_00"}],
            "wordCount": 10,
        }
    )
    assert fields == {"route": "/transcribe", "wordCount": 10}


def test_safe_uri_strips_a_presigned_signature() -> None:
    signed = "https://r2.test/ws/1/audio16k.wav?X-Amz-Signature=deadbeef&X-Amz-Expires=900"
    reduced = safe_uri(signed)
    assert reduced == "https://r2.test/ws/1/audio16k.wav"
    assert "Signature" not in reduced


def test_safe_uri_never_repeats_an_inline_payload() -> None:
    payload = inline(make_wav(0.1))
    reduced = safe_uri(payload)
    assert reduced.startswith("inline:")
    assert "base64" not in reduced
    assert payload[:64] not in reduced


def test_safe_uri_reduces_a_local_path_to_its_length() -> None:
    assert safe_uri("/mnt/media/ws/1/audio16k.wav").startswith("path:")
    assert safe_uri("") == "(none)"


def test_the_json_formatter_emits_one_object_per_line_with_the_extras() -> None:
    formatter = JsonFormatter("model-server")
    record = logging.LogRecord("model_server", logging.INFO, __file__, 1, "transcribed", None, None)
    record.batchSize = 4
    line = formatter.format(record)
    payload = json.loads(line)
    assert payload["service"] == "model-server"
    assert payload["msg"] == "transcribed"
    assert payload["batchSize"] == 4
    assert "\n" not in line


def test_the_json_formatter_renders_an_exception() -> None:
    formatter = JsonFormatter("model-server")
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        record = logging.LogRecord(
            "model_server", logging.ERROR, __file__, 1, "failed", None, sys.exc_info()
        )
    payload = json.loads(formatter.format(record))
    assert "ValueError: boom" in payload["error"]


def test_configure_logging_quiets_the_http_clients() -> None:
    configure_logging("model-server", "debug")
    try:
        assert logging.getLogger().level == logging.DEBUG
        # httpx logs full URLs at INFO; a presigned URL there is a leaked credential.
        assert logging.getLogger("httpx2").level == logging.WARNING
    finally:
        configure_logging("model-server", "info")


def test_an_unknown_log_level_falls_back_to_info() -> None:
    configure_logging("model-server", "shouty")
    assert logging.getLogger().level == logging.INFO


# ---------------------------------------------------------------------------
# The error envelope
# ---------------------------------------------------------------------------


def test_the_error_envelope_matches_contracts_section_8() -> None:
    error = ModelServerError("something went wrong", details={"why": "testing"})
    body = error_body(error, "req-1")["error"]
    assert body["code"] == "model-server/internal"
    assert body["requestId"] == "req-1"
    assert body["details"] == {"why": "testing"}
    assert error.headers == {}


# ---------------------------------------------------------------------------
# The body limit
# ---------------------------------------------------------------------------


def test_a_body_over_the_limit_is_413_before_it_is_buffered(auth: dict[str, str]) -> None:
    app = build_app(settings=build_settings(max_body_bytes=512))
    with TestClient(app) as client:
        response = client.post("/transcribe", json={"audio": inline(make_wav(1.0))}, headers=auth)
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "model-server/payload-too-large"
        assert "https URL" in response.json()["error"]["message"]
        assert 'model_server_rejected_total{reason="payload_too_large"} 1.0' in (
            client.get("/metrics").text
        )


def test_the_root_route_names_the_brand_not_the_codename() -> None:
    app = build_app()
    with TestClient(app) as client:
        body = client.get("/").text
    assert "Aksharo" in body
    assert "montaj" not in body.casefold()


# ---------------------------------------------------------------------------
# Audio decoding edges
# ---------------------------------------------------------------------------


def _wav(width: int, frames: bytes, rate: int = 16_000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        handle.writeframes(frames)
    return buffer.getvalue()


def test_eight_bit_and_thirty_two_bit_wavs_decode() -> None:
    eight = decode_wav(_wav(1, bytes([128, 200, 56, 128])))
    assert len(eight.samples) == 4
    assert abs(float(eight.samples[0])) < 1e-6

    frames = b"".join(struct.pack("<i", value) for value in (0, 1 << 30))
    thirty_two = decode_wav(_wav(4, frames))
    assert len(thirty_two.samples) == 2
    # 2**30 of a full scale of 2**31.
    assert float(thirty_two.samples[1]) == pytest.approx(0.5)


def test_an_unsupported_sample_width_says_which_one() -> None:
    payload = bytearray(_wav(2, b"\x00\x00"))
    # Rewrite the fmt chunk's bits-per-sample to 24.
    payload[34] = 24
    payload[32] = 3
    with pytest.raises(AudioError, match="unsupported WAV sample width"):
        decode_wav(bytes(payload))


def test_non_wav_audio_without_ffmpeg_names_the_fix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FFMPEG_BIN", "")
    monkeypatch.setattr("shutil.which", lambda _name: None)
    with pytest.raises(AudioError, match="ffmpeg is not on PATH"):
        load_audio(inline(b"OggS-not-a-wav"), max_bytes=1024, max_seconds=60)


def test_non_wav_audio_goes_through_ffmpeg_when_it_is_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    pcm = struct.pack("<4f", 0.0, 0.5, -0.5, 0.0)
    captured: dict[str, Any] = {}

    class Completed:
        returncode = 0
        stdout = pcm

    def fake_run(command: list[str], **kwargs: Any) -> Completed:
        captured["command"] = command
        return Completed()

    monkeypatch.setenv("FFMPEG_BIN", "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", fake_run)
    audio = load_audio(inline(b"OggS-not-a-wav"), max_bytes=1024, max_seconds=60)
    assert len(audio.samples) == 4
    # argv list, absolute binary, no shell.
    assert captured["command"][0] == "/usr/bin/ffmpeg"
    assert "-nostdin" in captured["command"]
    assert "16000" in captured["command"]


def test_ffmpeg_failing_is_an_audio_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    class Completed:
        returncode = 1
        stdout = b""

    monkeypatch.setenv("FFMPEG_BIN", "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: Completed())
    with pytest.raises(AudioError, match="exit 1"):
        load_audio(inline(b"OggS-not-a-wav"), max_bytes=1024, max_seconds=60)


def test_ffmpeg_being_unlaunchable_is_an_audio_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    def explode(command: list[str], **kwargs: Any) -> None:
        raise OSError("no such binary")

    monkeypatch.setenv("FFMPEG_BIN", "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", explode)
    with pytest.raises(AudioError, match="OSError"):
        load_audio(inline(b"OggS-not-a-wav"), max_bytes=1024, max_seconds=60)


def test_a_transport_failure_on_the_audio_url_is_an_audio_error() -> None:
    import httpx2

    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused")

    client = httpx2.Client(transport=httpx2.MockTransport(handler))
    with pytest.raises(AudioError, match="could not be fetched"):
        load_audio("https://r2.test/x.wav", max_bytes=1024, max_seconds=60, http_client=client)


def test_audio_that_decodes_to_nothing_is_rejected() -> None:
    with pytest.raises(AudioError, match="zero samples"):
        load_audio(inline(_wav(2, b"")), max_bytes=1024, max_seconds=60)


# ---------------------------------------------------------------------------
# Batcher edges
# ---------------------------------------------------------------------------


def test_a_batcher_with_a_zero_max_size_is_rejected_at_construction() -> None:
    async def run(items: Any) -> Any:  # pragma: no cover - never called
        return items

    with pytest.raises(ValueError, match="max_size"):
        DynamicBatcher(run, max_size=0)


async def test_closing_a_batcher_that_never_started_is_a_no_op() -> None:
    async def run(items: Any) -> Any:  # pragma: no cover - never called
        return items

    batcher: DynamicBatcher[int, int] = DynamicBatcher(run)
    await batcher.aclose()
    assert batcher.depth == 0


async def test_a_submission_after_close_is_refused() -> None:
    async def run(items: Any) -> Any:
        return list(items)

    batcher: DynamicBatcher[int, int] = DynamicBatcher(run, max_size=1, window_s=0.0)
    batcher.start()
    await batcher.submit(1)
    await batcher.aclose()
    with pytest.raises(RuntimeError, match="draining"):
        await batcher.submit(2)


# ---------------------------------------------------------------------------
# Registry and entry points
# ---------------------------------------------------------------------------


def test_the_registry_builds_the_real_backends_from_settings() -> None:
    """Constructing them must not import a CUDA stack; only ``load`` does."""
    settings = Settings.from_env(
        {
            "GPU_PROVIDER_TOKEN": "t",
            "MODEL_SERVER_DEVICE": "cpu",
            "MODEL_SERVER_WHISPER_MODEL": "tiny",
            "MODEL_SERVER_ALIGN_MODEL_DIR": "/models/align",
        }
    )
    registry = ModelRegistry.from_settings(settings)
    assert registry.asr is not None
    assert registry.asr.model_id == "tiny"
    assert isinstance(registry.aligner, CtcAligner)
    assert registry.aligner.model_dir == "/models/align"
    assert registry.diariser is not None
    assert registry.diariser.licence == "CC-BY-4.0"
    assert registry.ready() is False


def test_a_registry_with_no_backends_reports_why_it_is_not_ready() -> None:
    registry = ModelRegistry(required=("asr", "diarise"))
    registry.load()
    assert registry.ready() is False
    assert "asr: not loaded" in registry.not_ready_reason()
    registry.unload()


def test_the_main_entry_point_refuses_an_unservable_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from model_server.__main__ import run

    monkeypatch.delenv("GPU_PROVIDER_TOKEN", raising=False)
    monkeypatch.delenv("MODEL_SERVER_ALLOW_ANONYMOUS", raising=False)
    assert run() == 2


def test_the_runpod_entry_point_refuses_an_unservable_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from model_server.runpod_handler import main

    monkeypatch.delenv("GPU_PROVIDER_TOKEN", raising=False)
    monkeypatch.delenv("MODEL_SERVER_ALLOW_ANONYMOUS", raising=False)
    assert main() == 2


def test_the_package_exports_its_version() -> None:
    import model_server

    assert model_server.__version__


def test_the_readme_and_the_dockerfile_exist_beside_the_package() -> None:
    """Packaging files the brief names; a missing one is a broken image build."""
    root = Path(__file__).resolve().parents[1]
    for name in ("Dockerfile", "README.md", "cost.md", "requirements.lock"):
        assert (root / name).is_file(), name + " is missing from apps/model-server"
