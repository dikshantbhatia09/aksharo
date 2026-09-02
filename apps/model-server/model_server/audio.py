"""Turning the ``audio`` field of a request into 16 kHz mono float32.

The clients send one of four things, and all four are documented in
``apps/worker-ai/worker_ai/providers/serverless_whisper.py``'s contract block or
implied by it:

``https://…``
    A presigned URL to ``audio16k.wav`` in R2 (CONTRACTS section 6). Fetched with
    a byte cap, because "the caller promised it was ten minutes" is not a limit.
``data:audio/wav;base64,…`` or ``base64:…``
    An inline WAV, for a chunk small enough that a round trip to object storage
    costs more than the bytes.
``file:///…`` or a bare path
    A shared volume, which is what the local CPU lane and the integration test
    use.

``apps/worker-media`` writes ``audio16k.wav`` — 16 kHz mono PCM — so the fast
path is the standard library's ``wave`` module with no subprocess at all. ffmpeg
is the fallback for any other container and is resolved once through
``shutil.which`` (never through a shell), which is also why the CUDA image
installs it.

Nothing here is written to disk and nothing here is logged: audio is held for the
length of one request and then dropped, which is the ``retentionClass:
ephemeral`` the worker records against every submission.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
import shutil
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import numpy as np
from numpy.typing import NDArray

from model_server.errors import AudioError, PayloadTooLargeError

__all__ = [
    "TARGET_SAMPLE_RATE",
    "Pcm",
    "decode_wav",
    "load_audio",
    "resample",
]

#: What ``apps/worker-media`` writes and what every model here expects.
TARGET_SAMPLE_RATE = 16_000

_FFMPEG_TIMEOUT_S = 900
_HTTP_TIMEOUT_S = 120.0
_HTTP_CHUNK = 1 << 20


@dataclass(frozen=True, slots=True)
class Pcm:
    """Mono float32 samples in ``[-1, 1]`` plus their sample rate."""

    samples: NDArray[np.float32]
    sample_rate: int

    @property
    def duration_s(self) -> float:
        if self.sample_rate <= 0:
            return 0.0
        return len(self.samples) / self.sample_rate

    def slice_s(self, start_s: float, end_s: float | None) -> Pcm:
        """The span ``[start_s, end_s)``, clamped to what exists."""
        begin = max(0, round(start_s * self.sample_rate))
        stop = len(self.samples) if end_s is None else round(end_s * self.sample_rate)
        stop = min(len(self.samples), max(begin, stop))
        return Pcm(samples=self.samples[begin:stop], sample_rate=self.sample_rate)


def resample(
    samples: NDArray[np.float32], source_rate: int, target_rate: int
) -> NDArray[np.float32]:
    """Linear resampling, which is enough for a 16 kHz speech front end.

    The pipeline hands this server 16 kHz audio, so this path exists for the
    occasional 44.1 kHz upload that reached the GPU without passing through
    ``worker-media``. Anything better than linear would be a quality claim this
    function is in no position to make.
    """
    if source_rate == target_rate or len(samples) == 0:
        return samples
    duration = len(samples) / source_rate
    count = max(1, round(duration * target_rate))
    source_positions = np.linspace(0.0, len(samples) - 1, num=len(samples), dtype=np.float64)
    target_positions = np.linspace(0.0, len(samples) - 1, num=count, dtype=np.float64)
    return np.interp(target_positions, source_positions, samples).astype(np.float32)


def decode_wav(payload: bytes) -> Pcm:
    """Decode a PCM WAV to mono float32, without ffmpeg."""
    try:
        with wave.open(io.BytesIO(payload), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as error:
        raise AudioError("the audio is not a readable PCM WAV: " + str(error)) from error

    if width == 1:
        raw = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        raw = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        raw = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise AudioError("unsupported WAV sample width: " + str(width) + " bytes")

    if channels > 1:
        usable = len(raw) - (len(raw) % channels)
        raw = raw[:usable].reshape(-1, channels).mean(axis=1)

    return Pcm(
        samples=resample(raw.astype(np.float32), rate, TARGET_SAMPLE_RATE),
        sample_rate=TARGET_SAMPLE_RATE,
    )


def _decode_with_ffmpeg(payload: bytes) -> Pcm:
    """Anything that is not a PCM WAV, through ffmpeg on stdin."""
    binary = os.environ.get("FFMPEG_BIN", "").strip() or shutil.which("ffmpeg")
    if not binary:
        raise AudioError(
            "the audio is not a PCM WAV and ffmpeg is not on PATH; "
            "send audio16k.wav or install ffmpeg in the image"
        )
    command = [
        binary,
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        str(TARGET_SAMPLE_RATE),
        "pipe:1",
    ]
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, absolute binary, no shell
            command,
            input=payload,
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AudioError("ffmpeg could not decode the audio: " + type(error).__name__) from error
    if completed.returncode != 0:
        raise AudioError("ffmpeg rejected the audio (exit " + str(completed.returncode) + ")")
    samples = np.frombuffer(completed.stdout, dtype="<f4").astype(np.float32)
    return Pcm(samples=samples, sample_rate=TARGET_SAMPLE_RATE)


def _decode(payload: bytes) -> Pcm:
    if payload[:4] == b"RIFF":
        return decode_wav(payload)
    return _decode_with_ffmpeg(payload)


def _inline_bytes(spec: str) -> bytes:
    """The bytes behind a ``data:`` or ``base64:`` payload."""
    encoded = spec
    if spec.startswith("data:"):
        _, _, tail = spec.partition(",")
        encoded = tail
    elif spec.startswith("base64:"):
        encoded = spec[len("base64:") :]
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise AudioError("the inline audio is not valid base64") from error


def _local_path(spec: str) -> Path:
    if spec.startswith("file://"):
        parts = urlsplit(spec)
        raw = unquote(parts.path)
        # file:///C:/x on Windows arrives as /C:/x.
        if len(raw) > 2 and raw[0] == "/" and raw[2] == ":":
            raw = raw[1:]
        return Path(raw)
    return Path(spec)


def _read_local(spec: str, *, max_bytes: int) -> bytes:
    path = _local_path(spec)
    if not path.is_file():
        raise AudioError("no audio at the path the request named")
    size = path.stat().st_size
    if size > max_bytes:
        raise PayloadTooLargeError(
            "the audio file is " + str(size) + " bytes, over the " + str(max_bytes) + " byte limit"
        )
    return path.read_bytes()


def _fetch(url: str, *, max_bytes: int, client: Any | None) -> bytes:
    """Download the audio, refusing to buffer more than the cap."""
    import httpx2

    owns = client is None
    http: Any = client or httpx2.Client(timeout=_HTTP_TIMEOUT_S, follow_redirects=True)
    try:
        with http.stream("GET", url) as response:
            if response.status_code >= 400:
                raise AudioError("the audio URL answered " + str(response.status_code))
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > max_bytes:
                raise PayloadTooLargeError(
                    "the audio URL declares " + declared + " bytes, over the limit"
                )
            buffer = bytearray()
            for chunk in response.iter_bytes(_HTTP_CHUNK):
                buffer.extend(chunk)
                if len(buffer) > max_bytes:
                    raise PayloadTooLargeError(
                        "the audio exceeded " + str(max_bytes) + " bytes while downloading"
                    )
            return bytes(buffer)
    except httpx2.HTTPError as error:
        raise AudioError("the audio could not be fetched: " + type(error).__name__) from error
    finally:
        if owns:
            http.close()


def load_audio(
    spec: str,
    *,
    max_bytes: int,
    max_seconds: float,
    http_client: Any | None = None,
) -> Pcm:
    """Resolve one request's ``audio`` field to 16 kHz mono float32.

    :param spec: an https URL, an inline base64 WAV, or a local path.
    :param max_bytes: the encoded-byte ceiling, for the URL and the file paths.
    :param max_seconds: the decoded-duration ceiling — `09 §1` cuts chunks at ten
        minutes, so anything longer is a caller that skipped the chunk planner.
    :raises AudioError: unreadable, unfetchable or too long.
    :raises PayloadTooLargeError: over the byte ceiling.
    """
    if not spec or not spec.strip():
        raise AudioError("the request carried no audio")
    trimmed = spec.strip()

    if trimmed.startswith(("data:", "base64:")):
        payload = _inline_bytes(trimmed)
        if len(payload) > max_bytes:
            raise PayloadTooLargeError(
                "the inline audio is " + str(len(payload)) + " bytes, over the limit"
            )
    elif trimmed.startswith(("http://", "https://")):
        payload = _fetch(trimmed, max_bytes=max_bytes, client=http_client)
    else:
        payload = _read_local(trimmed, max_bytes=max_bytes)

    pcm = _decode(payload)
    if pcm.duration_s > max_seconds:
        raise AudioError(
            "the audio is "
            + format(pcm.duration_s, ".1f")
            + " s, over the "
            + format(max_seconds, ".0f")
            + " s chunk limit; chunk it at VAD boundaries first"
        )
    if len(pcm.samples) == 0:
        raise AudioError("the audio decoded to zero samples")
    return pcm
