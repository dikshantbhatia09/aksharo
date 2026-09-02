"""ffmpeg-backed audio helpers: probe, decode to PCM, cut a chunk.

``apps/worker-media`` produces ``audio16k.wav`` (16 kHz mono PCM), so the fast
path here is the standard library's ``wave`` module — no subprocess at all. ffmpeg
is the fallback for anything else and the tool that cuts chunks, and it is
resolved once through ``shutil.which`` (or ``FFMPEG_BIN``) so the subprocess call
never goes through a shell.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from worker_ai.logging_setup import get_logger

__all__ = [
    "TARGET_SAMPLE_RATE",
    "AudioToolError",
    "Pcm",
    "cut_wav",
    "ffmpeg_path",
    "ffprobe_path",
    "read_pcm",
    "write_wav",
]

_log = get_logger(__name__)

#: What `apps/worker-media` writes and every model in this worker expects.
TARGET_SAMPLE_RATE = 16_000

_FFMPEG_TIMEOUT_S = 900


class AudioToolError(RuntimeError):
    """ffmpeg is missing, or refused a file."""


@dataclass(frozen=True, slots=True)
class Pcm:
    """Mono float32 samples in ``[-1, 1]`` plus their sample rate."""

    samples: NDArray[np.float32]
    sample_rate: int

    @property
    def duration_ms(self) -> int:
        return round(1000 * len(self.samples) / self.sample_rate)


def _tool(env_var: str, name: str) -> str:
    override = os.environ.get(env_var, "").strip()
    if override:
        return override
    found = shutil.which(name)
    if found is None:
        raise AudioToolError(
            f"{name} is not on PATH; install it or set {env_var} (the Docker image installs ffmpeg)"
        )
    return found


def ffmpeg_path() -> str:
    """Absolute path to ffmpeg, honouring ``FFMPEG_BIN``."""
    return _tool("FFMPEG_BIN", "ffmpeg")


def ffprobe_path() -> str:
    """Absolute path to ffprobe, honouring ``FFPROBE_BIN``."""
    return _tool("FFPROBE_BIN", "ffprobe")


def _run(argv: list[str]) -> bytes:
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, shell=False, fixed binary
            argv,
            check=False,
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AudioToolError(f"{argv[0]} could not be run: {error}") from error
    if completed.returncode != 0:
        tail = completed.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise AudioToolError(f"{argv[0]} failed ({completed.returncode}): {' / '.join(tail)}")
    return completed.stdout


def read_pcm(path: Path, *, sample_rate: int = TARGET_SAMPLE_RATE) -> Pcm:
    """Decode ``path`` to mono float32 at ``sample_rate``.

    Tries ``wave`` first because the pipeline's own ``audio16k.wav`` is plain
    16-bit PCM and spawning ffmpeg for it would dominate the VAD budget.
    """
    native = _read_wave(path, sample_rate)
    if native is not None:
        return native

    raw = _run(
        [
            ffmpeg_path(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            str(path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "s16le",
            "-",
        ]
    )
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return Pcm(samples=samples, sample_rate=sample_rate)


def _read_wave(path: Path, sample_rate: int) -> Pcm | None:
    """Fast path for 16-bit mono PCM at exactly ``sample_rate``; else ``None``."""
    try:
        with wave.open(str(path), "rb") as handle:
            if (
                handle.getsampwidth() != 2
                or handle.getnchannels() != 1
                or handle.getframerate() != sample_rate
            ):
                return None
            frames = handle.readframes(handle.getnframes())
    except (OSError, wave.Error):
        return None
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return Pcm(samples=samples, sample_rate=sample_rate)


def write_wav(path: Path, pcm: Pcm) -> Path:
    """Write mono 16-bit PCM. Used by fixtures and by the chunk cutter's tests."""
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(pcm.samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(pcm.sample_rate)
        handle.writeframes((clipped * 32767.0).astype("<i2").tobytes())
    return path


def cut_wav(
    source: Path,
    destination: Path,
    *,
    start_ms: int,
    end_ms: int,
    sample_rate: int = TARGET_SAMPLE_RATE,
) -> Path:
    """Cut ``[start_ms, end_ms)`` out of ``source`` into a mono PCM wav.

    ``-ss`` before ``-i`` is the fast seek; re-encoding to PCM (rather than
    stream-copying) is deliberate, because a copy would snap to the nearest
    packet boundary and the chunk plan's millisecond boundaries are load-bearing
    for word ids.
    """
    if end_ms <= start_ms:
        raise AudioToolError(f"empty chunk: [{start_ms}, {end_ms})")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            ffmpeg_path(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            f"{start_ms / 1000:.3f}",
            "-t",
            f"{(end_ms - start_ms) / 1000:.3f}",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            str(destination),
        ]
    )
    _log.debug("cut chunk", extra={"startMs": start_ms, "endMs": end_ms, "path": destination.name})
    return destination
