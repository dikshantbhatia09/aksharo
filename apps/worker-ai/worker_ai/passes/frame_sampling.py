"""Frame and RMS sampling from the proxy for the zoom/reframe passes (B19b).

B19 shipped the `zoom`/`reframe` passes against pre-extracted frame statistics
and detections the producer was expected to supply (`processors/
reframe_zoom_pass.py`'s module docstring, "Gap" note), but nothing decoded
frames or audio — the producer always sent `sceneFrames`/`detections`/
`rmsSamples` empty. This module closes that gap on the worker side: given the
540p proxy `apps/worker-media` already produces (CONTRACTS §6,
`proxy540.mp4`), it samples video frames and audio energy at 10 Hz.

Two outputs:

- :func:`sample_frames` decodes frames at 10 Hz, downscaled to <= 320 px
  wide, into grayscale numpy arrays `worker_ai.passes.tracking.
  BrightBlobDetector` already consumes (the YuNet seam stays unprovisioned
  per the brief; `PASS_FACE_DETECTOR=yunet` gates a real detector this module
  does not implement), plus the average hue/sat/val `worker_ai.passes.scenes.
  detect_scenes` wants for scene-cut detection.
- :func:`sample_rms` decodes the proxy's audio track to 16 kHz PCM (via
  `worker_ai.audio.read_pcm`, the same decoder every other processor uses)
  and reduces it to one RMS value per 100 ms window.

Both call ffmpeg directly (`worker_ai.audio.ffmpeg_path`/`ffprobe_path`)
rather than round-tripping through `apps/worker-media` (a separate Node
service this Python process cannot import): frames are piped out as raw
`rgb24` rather than encoded to JPEG, because decoding a JPEG back to a numpy
array would need Pillow/OpenCV, which are not currently a `worker-ai`
dependency (`pyproject.toml`) — the frame bytes never touch disk or the wire
either way, so the "keep it CPU-cheap" goal (a small, downscaled frame) is met
without the encode/decode round trip a JPEG would add. `apps/worker-media/src/
frames/sample.ts` still exists for a TS consumer that does want an encoded
JPEG (a filmstrip preview, a future thumbnail regenerate).
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import IO

import numpy as np
from numpy.typing import NDArray

from worker_ai.audio import TARGET_SAMPLE_RATE, AudioToolError, ffmpeg_path, ffprobe_path, read_pcm

__all__ = [
    "MAX_FRAME_WIDTH",
    "SAMPLE_HZ",
    "FrameSample",
    "probe_video_size",
    "sample_frames",
    "sample_rms",
]

#: Sampling rate for both frames and RMS windows (brief ruling 4: 10 Hz).
SAMPLE_HZ = 10
_SAMPLE_INTERVAL_MS = 1000 // SAMPLE_HZ

#: Frames are downscaled to at most this many pixels wide before decode
#: (brief ruling 4: "keep it CPU-cheap (<= 320 px wide JPEG)").
MAX_FRAME_WIDTH = 320

_FFMPEG_TIMEOUT_S = 900


@dataclass(frozen=True, slots=True)
class FrameSample:
    """One sampled, downscaled video frame."""

    t_ms: int
    #: Grayscale, `(height, width)`, values in `[0, 1]` — what
    #: `BrightBlobDetector` expects.
    gray: NDArray[np.float32]
    #: Mean hue/sat/val over the frame, 0..255 each — `scenes.FrameStat`'s shape
    #: ("matches OpenCV's HSV range").
    hue: float
    sat: float
    val: float


def probe_video_size(path: Path) -> tuple[int, int]:
    """`(width, height)` of `path`'s first video stream, via ffprobe."""
    try:
        completed = subprocess.run(  # noqa: S603
            [
                ffprobe_path(),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
                str(path),
            ],
            check=False,
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AudioToolError(f"ffprobe could not be run: {error}") from error
    if completed.returncode != 0:
        tail = completed.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise AudioToolError(f"ffprobe failed ({completed.returncode}): {' / '.join(tail)}")
    data = json.loads(completed.stdout or b"{}")
    streams = data.get("streams") or []
    if not streams:
        raise AudioToolError(f"{path.name} has no video stream")
    width = int(streams[0]["width"])
    height = int(streams[0]["height"])
    if width <= 0 or height <= 0:
        raise AudioToolError(f"{path.name} reported a non-positive frame size")
    return width, height


def _scaled_size(source_width: int, source_height: int, *, max_width: int) -> tuple[int, int]:
    """Downscale to `<= max_width` wide, preserving aspect ratio, even dims."""
    if source_width <= max_width:
        width, height = source_width, source_height
    else:
        width = max_width
        height = round(source_height * (max_width / source_width))
    width = max(2, width - (width % 2))
    height = max(2, height - (height % 2))
    return width, height


def sample_frames(
    path: Path,
    duration_ms: int,
    *,
    hz: int = SAMPLE_HZ,
    max_width: int = MAX_FRAME_WIDTH,
) -> list[FrameSample]:
    """Decode `path` (the 540p proxy) at `hz` frames per second, downscaled to
    `<= max_width` px wide, into :class:`FrameSample` rows.

    Frames are piped out of ffmpeg as raw `rgb24` (module docstring explains
    why not JPEG) and read one frame at a time as they arrive, rather than
    buffered whole into memory: a 30-minute clip at 10 Hz is tens of
    thousands of frames, and `subprocess.run(capture_output=True)`'s
    read-everything-then-process approach (this function's first cut) needed
    multiple gigabytes of resident memory for that and could `MemoryError`
    outright on a busy host — precisely the failure mode the brief's "keep it
    CPU-cheap" instruction warns against. Reading frame-sized chunks off the
    pipe as ffmpeg produces them keeps peak memory bounded by one frame
    (`frame_bytes`), regardless of clip length. `duration_ms <= 0` returns no
    frames rather than guessing a count from the pipe (ffmpeg's frame count
    is not known in advance for a variable-frame-rate source, only the byte
    stride per frame is, so the caller's own duration is what bounds the
    read).
    """
    if duration_ms <= 0:
        return []
    source_width, source_height = probe_video_size(path)
    width, height = _scaled_size(source_width, source_height, max_width=max_width)
    frame_bytes = width * height * 3
    # A source shorter than its own declared duration (or a variable frame
    # rate that dropped the tail) yields fewer frames than expected; sampling
    # what actually decoded is correct, not an error, so this is a cap on the
    # read, not a count ffmpeg is asked to guarantee.
    max_frames = (duration_ms * hz) // 1000 + 1

    argv = [
        ffmpeg_path(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        str(path),
        "-vf",
        f"fps={hz},scale={width}:{height}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    try:
        process = subprocess.Popen(  # noqa: S603
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
    except OSError as error:
        raise AudioToolError(f"ffmpeg could not be run: {error}") from error

    samples: list[FrameSample] = []
    assert process.stdout is not None  # noqa: S101 - PIPE was requested above
    try:
        for index in range(max_frames):
            chunk = _read_exact(process.stdout, frame_bytes)
            if chunk is None:
                break
            pixels = np.frombuffer(chunk, dtype=np.uint8).reshape(height, width, 3)
            rgb = pixels.astype(np.float32) / 255.0
            hue, sat, val = _mean_hsv(rgb)
            gray = rgb.mean(axis=2)
            samples.append(
                FrameSample(t_ms=round(index * 1000 / hz), gray=gray, hue=hue, sat=sat, val=val)
            )
    finally:
        process.stdout.close()
        try:
            process.wait(timeout=_FFMPEG_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    stderr = process.stderr.read() if process.stderr is not None else b""
    if process.stderr is not None:
        process.stderr.close()
    if process.returncode not in (0, None) and not samples:
        tail = stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise AudioToolError(f"ffmpeg failed ({process.returncode}): {' / '.join(tail)}")
    return samples


def _read_exact(stream: IO[bytes], size: int) -> bytes | None:
    """Read exactly `size` bytes from `stream`. `None` at EOF, whether clean
    (nothing left) or mid-frame (the pipe closed with a partial frame
    buffered) — either way there is no full frame left to decode.
    """
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _mean_hsv(rgb: NDArray[np.float32]) -> tuple[float, float, float]:
    """Mean hue/sat/val over an `(h, w, 3)` array of `[0, 1]` RGB floats,
    scaled to OpenCV's 0..255 HSV range (`scenes.FrameStat`'s convention, so
    `detect_scenes`'s `threshold=27.0` default applies unchanged).
    """
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    delta = max_c - min_c

    val = max_c
    sat = np.where(max_c > 0, delta / np.where(max_c > 0, max_c, 1.0), 0.0)

    hue = np.zeros_like(max_c)
    nonzero = delta > 1e-6
    r_is_max = nonzero & (max_c == r)
    g_is_max = nonzero & (max_c == g) & ~r_is_max
    b_is_max = nonzero & ~r_is_max & ~g_is_max
    safe_delta = np.where(delta > 1e-6, delta, 1.0)
    hue = np.where(r_is_max, ((g - b) / safe_delta) % 6, hue)
    hue = np.where(g_is_max, (b - r) / safe_delta + 2, hue)
    hue = np.where(b_is_max, (r - g) / safe_delta + 4, hue)
    hue = hue / 6.0

    return float(hue.mean()) * 255.0, float(sat.mean()) * 255.0, float(val.mean()) * 255.0


def sample_rms(path: Path, duration_ms: int, *, hz: int = SAMPLE_HZ) -> list[tuple[int, float]]:
    """Decode `path`'s audio track to 16 kHz PCM and reduce it to one RMS
    value per `1000 / hz` ms window (brief ruling 4: 10 Hz).

    Reuses `worker_ai.audio.read_pcm`, the same ffmpeg-backed decoder every
    other processor in this worker uses, so a proxy with no readable audio
    track raises the same `AudioToolError` a caller already knows how to turn
    into a job failure.
    """
    if duration_ms <= 0:
        return []
    pcm = read_pcm(path, sample_rate=TARGET_SAMPLE_RATE)
    window_samples = max(1, TARGET_SAMPLE_RATE // hz)
    samples: list[tuple[int, float]] = []
    total = len(pcm.samples)
    window_count = max(1, round(duration_ms * hz / 1000))
    for index in range(window_count):
        start = index * window_samples
        end = min(total, start + window_samples)
        if start >= total:
            break
        window = pcm.samples[start:end]
        rms = float(np.sqrt(np.mean(np.square(window)))) if window.size else 0.0
        samples.append((round(index * 1000 / hz), rms))
    return samples
