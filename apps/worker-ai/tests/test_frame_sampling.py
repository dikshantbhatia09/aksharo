"""`worker_ai.passes.frame_sampling` — 10 Hz frame/RMS sampling from a proxy (B19b).

Generates a tiny synthetic proxy with ffmpeg's `lavfi` test sources (a colour
bar pattern plus a sine tone) rather than committing a binary fixture, so the
test needs nothing but the ffmpeg already required to run this worker at all.
"""

from __future__ import annotations

import itertools
import shutil
import subprocess
from pathlib import Path

import pytest

from worker_ai.audio import AudioToolError, ffmpeg_path
from worker_ai.passes.frame_sampling import probe_video_size, sample_frames, sample_rms

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg on PATH")

_DURATION_S = 2.0
_DURATION_MS = int(_DURATION_S * 1000)


@pytest.fixture
def synthetic_proxy(tmp_path: Path) -> Path:
    out = tmp_path / "proxy540.mp4"
    subprocess.run(  # noqa: S603
        [
            ffmpeg_path(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=duration={_DURATION_S}:size=640x360:rate=25",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={_DURATION_S}:sample_rate=48000",
            "-shortest",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(out),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    return out


def test_probe_video_size_reads_the_encoded_dimensions(synthetic_proxy: Path) -> None:
    width, height = probe_video_size(synthetic_proxy)
    assert (width, height) == (640, 360)


def test_sample_frames_downscales_to_max_width_and_10hz(synthetic_proxy: Path) -> None:
    frames = sample_frames(synthetic_proxy, _DURATION_MS, hz=10, max_width=320)
    # ~2s at 10Hz => ~20 frames; ffmpeg's fps filter can be off by one at the tail.
    assert 18 <= len(frames) <= 21
    assert frames[0].t_ms == 0
    # Strictly ascending timestamps, one sample every 100ms.
    for previous, current in itertools.pairwise(frames):
        assert current.t_ms - previous.t_ms == pytest.approx(100, abs=1)
    first = frames[0]
    assert first.gray.shape[1] <= 320
    # HSV channel means are in OpenCV's 0..255 convention (module docstring).
    assert 0.0 <= first.hue <= 255.0
    assert 0.0 <= first.sat <= 255.0
    assert 0.0 <= first.val <= 255.0


def test_sample_frames_on_zero_duration_returns_nothing(synthetic_proxy: Path) -> None:
    assert sample_frames(synthetic_proxy, 0) == []


def test_sample_rms_produces_nonzero_energy_for_a_sine_tone(synthetic_proxy: Path) -> None:
    samples = sample_rms(synthetic_proxy, _DURATION_MS, hz=10)
    assert len(samples) >= 18
    # A steady 440 Hz tone should show non-trivial RMS energy throughout.
    assert all(value > 0.01 for _, value in samples[:-1])  # last window may be short/silent


def test_sample_frames_rejects_a_file_with_no_video_stream(tmp_path: Path) -> None:
    audio_only = tmp_path / "audio-only.mp4"
    subprocess.run(  # noqa: S603
        [
            ffmpeg_path(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:duration=1",
            "-c:a",
            "aac",
            str(audio_only),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    with pytest.raises(AudioToolError):
        probe_video_size(audio_only)
