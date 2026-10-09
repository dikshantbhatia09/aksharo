"""Acoustic pitch, energy and vocal dynamics analyzer (Pillar 2 §01).

Extracts multi-modal acoustic indicators from 16kHz audio:
- Pitch variance (ΔF0): measures vocal inflection and animated conviction vs monotone drone.
- Volume dynamics: RMS dynamic range and contrast without digital clipping.
- Laughter probability: laughter and heightened emotional arousal detection.
- Energy peaks: burstiness and emphatic vocal delivery.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

import numpy as np

__all__ = [
    "AcousticFeatures",
    "analyze_pcm_window",
]

_FRAME_MS: Final[int] = 50
_HOP_MS: Final[int] = 25
_MIN_VOICED_LAG: Final[int] = 35   # ~457 Hz at 16kHz
_MAX_VOICED_LAG: Final[int] = 246  # ~65 Hz at 16kHz


@dataclass(frozen=True, slots=True)
class AcousticFeatures:
    """Acoustic pitch, energy and vocal dynamics over a window."""

    pitch_variance: float = 0.5  # 0-1, normalized F0 variance
    volume_dynamics: float = 0.5  # 0-1, dynamic range / RMS volume contrast
    laughter_probability: float = 0.0  # 0-1, laughter / amusement detection
    energy_peaks: float = 0.5  # 0-1, frequency of high-energy bursts


def analyze_pcm_window(
    samples: np.ndarray,
    sample_rate: int,
    start_ms: int,
    end_ms: int,
) -> AcousticFeatures:
    """Extract acoustic pitch, volume dynamics, laughter and energy peaks."""
    if len(samples) == 0 or end_ms <= start_ms or sample_rate <= 0:
        return AcousticFeatures()

    start_idx = max(0, int(start_ms * sample_rate / 1000))
    end_idx = min(len(samples), int(end_ms * sample_rate / 1000))

    if end_idx - start_idx < int(0.5 * sample_rate):  # Less than 500ms
        return AcousticFeatures()

    chunk = samples[start_idx:end_idx].astype(np.float32)
    frame_len = int(sample_rate * _FRAME_MS / 1000)
    hop_len = int(sample_rate * _HOP_MS / 1000)

    num_frames = max(1, (len(chunk) - frame_len) // hop_len + 1)
    if num_frames < 4:
        return AcousticFeatures()

    frame_rms: list[float] = []
    f0_estimates: list[float] = []

    for i in range(num_frames):
        pos = i * hop_len
        frame = chunk[pos : pos + frame_len]
        rms = float(np.sqrt(np.mean(frame**2) + 1e-9))
        frame_rms.append(rms)

    mean_rms = float(np.mean(frame_rms)) if frame_rms else 1e-6
    std_rms = float(np.std(frame_rms)) if frame_rms else 0.0

    # Volume dynamics: normalized standard deviation of frame energies
    volume_dynamics = min(1.0, max(0.0, (std_rms / (mean_rms + 1e-6)) * 0.6))

    # Energy peaks: bursty high-energy moments above 1.7x average
    peak_count = sum(1 for r in frame_rms if r > 1.7 * mean_rms)
    energy_peaks = min(1.0, max(0.0, (peak_count / max(1, len(frame_rms))) * 4.0))

    # Pitch tracking on voiced frames using autocorrelation
    voiced_threshold = 0.3 * mean_rms
    for i in range(num_frames):
        if frame_rms[i] < voiced_threshold:
            continue
        pos = i * hop_len
        frame = chunk[pos : pos + frame_len]
        # Remove DC bias
        frame_norm = frame - np.mean(frame)
        autocorr = np.correlate(frame_norm, frame_norm, mode="full")
        autocorr = autocorr[len(frame_norm) - 1 :]
        if len(autocorr) > _MAX_VOICED_LAG:
            search_region = autocorr[_MIN_VOICED_LAG:_MAX_VOICED_LAG]
            peak_lag = _MIN_VOICED_LAG + int(np.argmax(search_region))
            max_val = autocorr[peak_lag]
            zero_val = autocorr[0] + 1e-9
            if max_val / zero_val > 0.35:
                pitch_hz = sample_rate / peak_lag
                f0_estimates.append(pitch_hz)

    if len(f0_estimates) >= 3:
        f0_std = float(np.std(f0_estimates))
        # 10 Hz std is dull/monotone, 40+ Hz is highly dynamic
        pitch_variance = min(1.0, max(0.0, f0_std / 40.0))
    else:
        pitch_variance = 0.5

    # Laughter probability estimation: bursty rhythmic energy bursts in 4-8 Hz envelope
    laughter_prob = 0.0
    if len(frame_rms) >= 20:
        # Check for rhythmic micro-bursts (approx 4-8 bursts per second)
        diffs = np.diff(frame_rms)
        zero_crossings = np.sum(diffs[:-1] * diffs[1:] < 0)
        rate = zero_crossings / (len(frame_rms) * (_HOP_MS / 1000.0))
        if 4.0 <= rate <= 10.0 and energy_peaks > 0.4 and pitch_variance > 0.5:
            laughter_prob = min(1.0, max(0.0, (rate - 3.0) / 7.0 * 0.8))

    return AcousticFeatures(
        pitch_variance=round(pitch_variance, 3),
        volume_dynamics=round(volume_dynamics, 3),
        laughter_probability=round(laughter_prob, 3),
        energy_peaks=round(energy_peaks, 3),
    )

