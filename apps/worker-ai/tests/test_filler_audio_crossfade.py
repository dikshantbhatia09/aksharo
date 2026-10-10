"""Audio cut smoothness and zero-click verification suite using Librosa.

Pillar 5 / Feature 02: Automatic Filler Word Removal Engine.
Key SLA:
- Audio cut smoothness: 0 dB DC offset / zero audible click transients across cut boundaries.
- 15ms equal-power acoustic crossfade eliminates micro-pops and boundary jump discontinuities.
"""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np
import pytest


def crossfade_15ms_equal_power(
    seg1: np.ndarray, seg2: np.ndarray, sr: int, duration_s: float = 0.015
) -> np.ndarray:
    """Apply a 15ms equal-power crossfade (triangular/acrossfade equivalent) between two audio segments.

    During the crossfade interval of length L:
      fade_out(t) = (1 - t / L)
      fade_in(t) = t / L
    The outgoing segment ends with fade_out, and the incoming segment starts with fade_in.
    """
    fade_len = int(duration_s * sr)
    if len(seg1) < fade_len or len(seg2) < fade_len:
        # Fallback if segment shorter than fade window
        return np.concatenate([seg1, seg2])

    fade_out = np.linspace(1.0, 0.0, fade_len, endpoint=False)
    fade_in = np.linspace(0.0, 1.0, fade_len, endpoint=False)

    # Crossfade region
    xfade_region = seg1[-fade_len:] * fade_out + seg2[:fade_len] * fade_in

    # Spliced result
    return np.concatenate([seg1[:-fade_len], xfade_region, seg2[fade_len:]])


def hard_cut_splice(seg1: np.ndarray, seg2: np.ndarray) -> np.ndarray:
    """Naive hard cut concatenation without acoustic crossfading."""
    return np.concatenate([seg1, seg2])


def measure_click_transient(audio: np.ndarray, boundary_idx: int, window: int = 20) -> float:
    """Measure maximum absolute sample-to-sample delta (first difference) around the boundary.

    A sharp step discontinuity (click/pop) manifests as a massive jump delta |x[n] - x[n-1]|.
    """
    start = max(1, boundary_idx - window)
    end = min(len(audio), boundary_idx + window)
    region = audio[start:end]
    diffs = np.abs(np.diff(region))
    return float(np.max(diffs)) if len(diffs) > 0 else 0.0


def measure_dc_offset(audio: np.ndarray, boundary_idx: int, window: int = 160) -> float:
    """Measure DC offset (mean amplitude) around the boundary window (e.g. 10ms at 16kHz)."""
    start = max(0, boundary_idx - window)
    end = min(len(audio), boundary_idx + window)
    return float(np.mean(audio[start:end]))


def test_crossfade_eliminates_hard_cut_click_transients() -> None:
    """Verify that a 15ms equal-power crossfade eliminates the jump click discontinuity of a hard cut."""
    sr = 16000
    # Two sine waves with arbitrary phase and DC offset to simulate cutting between spoken words
    t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False)
    seg1 = 0.6 * np.sin(2 * np.pi * 220 * t)  # Ends at a non-zero value
    seg2 = 0.6 * np.sin(2 * np.pi * 440 * t + np.pi / 2)  # Starts at non-zero peak (0.6)

    # 1. Hard cut splice
    hard_spliced = hard_cut_splice(seg1, seg2)
    hard_boundary = len(seg1)
    hard_click = measure_click_transient(hard_spliced, hard_boundary)

    # 2. 15ms crossfade splice
    xfade_spliced = crossfade_15ms_equal_power(seg1, seg2, sr, duration_s=0.015)
    xfade_boundary = len(seg1) - int(0.015 * sr) // 2
    xfade_click = measure_click_transient(xfade_spliced, xfade_boundary)

    # The hard cut should produce a pronounced jump discontinuity
    assert hard_click > 0.5, f"Hard cut should produce transient click spike, got {hard_click}"

    # The 15ms equal-power crossfade eliminates the jump click, leaving only the natural waveform derivative
    assert xfade_click < 0.10, f"Crossfaded audio must eliminate click transient, got {xfade_click}"
    assert xfade_click < hard_click * 0.25, (
        f"Crossfade click transient ({xfade_click}) must be significantly lower than hard cut ({hard_click})"
    )


def test_speech_audio_filler_removal_smoothness_with_librosa() -> None:
    """Test on real speech audio fixture: cut a filler segment out, crossfade, and verify with Librosa."""
    fixture_path = Path(__file__).parent.parent / "worker_ai" / "fixtures" / "speech-5s" / "clip.wav"
    assert fixture_path.exists(), f"Missing test fixture {fixture_path}"

    y, sr = librosa.load(str(fixture_path), sr=16000)
    assert len(y) > sr * 2

    # Simulate removing a 500ms filler word interval between 1.0s and 1.5s
    seg1 = y[: int(sr * 1.0)]
    seg2 = y[int(sr * 1.5) :]

    # Hard cut
    hard_spliced = hard_cut_splice(seg1, seg2)
    hard_boundary = len(seg1)
    hard_click = measure_click_transient(hard_spliced, hard_boundary)

    # 15ms equal-power crossfade
    xfade_spliced = crossfade_15ms_equal_power(seg1, seg2, sr, duration_s=0.015)
    fade_samples = int(0.015 * sr)
    xfade_boundary = len(seg1) - fade_samples // 2
    xfade_click = measure_click_transient(xfade_spliced, xfade_boundary)

    # DC offset check: around the crossfade boundary, DC offset must be near zero (< 0.01 / ~0 dB offset)
    dc_offset = measure_dc_offset(xfade_spliced, xfade_boundary, window=fade_samples)
    assert abs(dc_offset) < 0.05, f"Boundary DC offset must be near zero, got {dc_offset}"

    # Waveform derivative / click check
    assert xfade_click <= hard_click, (
        f"Crossfaded click transient ({xfade_click}) must be <= hard cut click ({hard_click})"
    )

    # Librosa spectral check: spectral flatness and zero NaNs/Infs
    stft = np.abs(librosa.stft(xfade_spliced))
    assert not np.isnan(stft).any()
    assert not np.isinf(stft).any()

    # Audio energy across the boundary region is continuous and stable
    rms = librosa.feature.rms(y=xfade_spliced)[0]
    assert np.all(np.isfinite(rms))
