"""Acoustic Energy, Pitch Spike & Emotion Detection Engine (Pillar 2 §07).

Extracts multi-modal acoustic and emotional indicators from 16kHz mono PCM audio:
1. Vocal Pitch Modulation (delta_F0 & sigma_F0): Fast vectorized YIN / autocorrelation fundamental
   frequency (F0) tracker in [65 Hz, 450 Hz], measuring pitch standard deviation and range.
2. Loudness Dynamics (RMS Energy & dBFS Spikes): 100ms frame RMS decibel envelope
   (dBFS = 20 * log10(RMS / RMS_max)) and peak explosion detection (>15 dB above baseline).
3. Neural Audio Event Detection (YAMNet / ONNX & Spectral AED): 0.96-second sliding
   log-mel spectrogram inference extracting Class 16 (Laughter), Class 17 (Giggly laughter),
   Class 23 (Applause), Class 24 (Cheering), Class 21 (Gasp), and Class 6 (Shout).
4. Speech Rate Acceleration: Syllabic energy envelope cadence acceleration.
"""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Protocol, runtime_checkable

import numpy as np
from numpy.typing import NDArray

from worker_ai.audio import TARGET_SAMPLE_RATE, Pcm, read_pcm
from worker_ai.logging_setup import get_logger

__all__ = [
    "HIGH_VARIANCE_PITCH_STD_HZ",
    "MONOTONE_PITCH_STD_HZ",
    "OPUS_DYNAMIC_STD_HZ",
    "OPUS_MONOTONE_STD_HZ",
    "RMS_FRAME_MS",
    "SPIKE_THRESHOLD_DB",
    "YAMNET_CLASS_APPLAUSE",
    "YAMNET_CLASS_CHEERING",
    "YAMNET_CLASS_GASP",
    "YAMNET_CLASS_GIGGLY_LAUGHTER",
    "YAMNET_CLASS_LAUGHTER",
    "YAMNET_CLASS_SHOUT",
    "YAMNET_CLASS_SPEECH",
    "YAMNET_HOP_SEC",
    "YAMNET_MEL_BINS",
    "YAMNET_NUM_CLASSES",
    "YAMNET_PATCH_FRAMES",
    "YAMNET_PATCH_SEC",
    "YAMNET_SAMPLE_RATE",
    "AcousticEmotionAggregator",
    "AcousticFeatures",
    "AudioEventSpan",
    "OnnxSession",
    "SpectralYamnetDetector",
    "WindowAcousticFeatures",
    "YamnetBackend",
    "YamnetEventResult",
    "YamnetOnnxDetector",
    "analyze_pcm_window",
    "analyze_wav_window",
    "compute_rms_dbfs_profile",
    "compute_speech_rate_acceleration",
    "compute_zero_crossing_rate",
    "ensure_acoustic_features",
    "extract_pitch_track_yin",
    "extract_window_acoustic_features",
    "extract_yamnet_patches",
    "load_yamnet_detector",
]

_log = get_logger(__name__)

# ---------------------------------------------------------------------------
# Acoustic & YAMNet Constants (Pillar 2 §07)
# ---------------------------------------------------------------------------

YAMNET_SAMPLE_RATE: Final[int] = 16_000
YAMNET_PATCH_SEC: Final[float] = 0.96
YAMNET_HOP_SEC: Final[float] = 0.48
YAMNET_PATCH_FRAMES: Final[int] = 96
YAMNET_MEL_BINS: Final[int] = 64
YAMNET_NUM_CLASSES: Final[int] = 521

#: AudioSet / YAMNet ontology class indices.
YAMNET_CLASS_SPEECH: Final[int] = 0
YAMNET_CLASS_SHOUT: Final[int] = 6
YAMNET_CLASS_LAUGHTER: Final[int] = 16
YAMNET_CLASS_GIGGLY_LAUGHTER: Final[int] = 17
YAMNET_CLASS_GASP: Final[int] = 21
YAMNET_CLASS_APPLAUSE: Final[int] = 23
YAMNET_CLASS_CHEERING: Final[int] = 24

#: Spikes Studio 100ms RMS frame and >15 dB peak explosion threshold.
RMS_FRAME_MS: Final[int] = 100
SPIKE_THRESHOLD_DB: Final[float] = 15.0

#: Opus Clip & Aksharo pitch standard deviation (sigma_F0) thresholds in Hz.
MONOTONE_PITCH_STD_HZ: Final[float] = 15.0
OPUS_MONOTONE_STD_HZ: Final[float] = 18.0
HIGH_VARIANCE_PITCH_STD_HZ: Final[float] = 40.0
OPUS_DYNAMIC_STD_HZ: Final[float] = 45.0

#: Pitch tracking frame parameters (50ms window, 25ms hop, [65 Hz, 457 Hz]).
_PITCH_FRAME_MS: Final[int] = 50
_PITCH_HOP_MS: Final[int] = 25
_MIN_F0_HZ: Final[float] = 65.0
_MAX_F0_HZ: Final[float] = 457.0


# ---------------------------------------------------------------------------
# Data Models
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AudioEventSpan:
    """Timestamped audio event detected by YAMNet AED."""

    start_ms: int
    end_ms: int
    label: str
    class_index: int
    probability: float


@dataclass(frozen=True, slots=True)
class YamnetEventResult:
    """Aggregated YAMNet Audio Event Detection result over a candidate window."""

    patch_probabilities: NDArray[np.float32]  # shape (num_patches, 521)
    laughter_probability: float
    giggly_laughter_probability: float
    applause_probability: float
    cheering_probability: float
    gasp_probability: float
    shouting_probability: float
    laughter_duration_sec: float
    applause_detected: bool
    events: tuple[AudioEventSpan, ...] = ()


@dataclass(frozen=True, slots=True)
class WindowAcousticFeatures:
    """Acoustic features extracted per candidate window (Pillar 2 §07 §4.1)."""

    rms_mean: float  # Average loudness (linear RMS in [0, 1])
    rms_max_spike_db: float  # Peak explosion above baseline (dB)
    pitch_std_dev_hz: float  # Pitch variability (inflection, sigma_F0 in Hz)
    pitch_range_hz: float  # Max pitch - min pitch (delta F0 in Hz)
    laughter_duration_sec: float  # Cumulative laughter within window (seconds)
    applause_detected: bool  # Audience ovation marker
    zcr_mean: float = 0.0  # Mean zero-crossing rate
    laughter_probability: float = 0.0
    applause_probability: float = 0.0
    cheering_probability: float = 0.0
    gasp_probability: float = 0.0
    shouting_probability: float = 0.0
    speech_rate_acceleration: float = 0.0

    def to_acoustic_features(self, window_duration_sec: float = 10.0) -> AcousticFeatures:
        """Convert physical window acoustic metrics into normalized + raw AcousticFeatures."""
        # Normalize pitch_std_dev_hz: 40+ Hz maps to >= 0.90..1.0; < 15 Hz maps to < 0.33
        pitch_var = min(1.0, max(0.0, self.pitch_std_dev_hz / 45.0))

        # Volume dynamics from spike dB and RMS contrast
        spike_norm = min(1.0, max(0.0, self.rms_max_spike_db / 18.0))
        vol_dyn = min(1.0, max(0.0, spike_norm))

        # Laughter probability combines patch classifier probability and duration ratio
        dur_ratio = (
            min(1.0, self.laughter_duration_sec / max(1.5, window_duration_sec * 0.25))
            if self.laughter_duration_sec > 0
            else 0.0
        )
        laugh_prob = max(self.laughter_probability, dur_ratio)

        # Energy peaks combine dB spike, applause, cheering, and shouting
        energy_pk = min(
            1.0,
            max(
                spike_norm,
                0.85 if self.applause_detected else 0.0,
                self.cheering_probability,
                self.shouting_probability,
            ),
        )

        return AcousticFeatures(
            pitch_variance=round(pitch_var, 3),
            volume_dynamics=round(vol_dyn, 3),
            laughter_probability=round(min(1.0, max(0.0, laugh_prob)), 3),
            energy_peaks=round(energy_pk, 3),
            pitch_std_dev_hz=round(self.pitch_std_dev_hz, 2),
            pitch_range_hz=round(self.pitch_range_hz, 2),
            rms_mean=round(self.rms_mean, 5),
            rms_max_spike_db=round(self.rms_max_spike_db, 2),
            laughter_duration_sec=round(self.laughter_duration_sec, 2),
            applause_detected=self.applause_detected,
            applause_probability=round(self.applause_probability, 3),
            cheering_probability=round(self.cheering_probability, 3),
            gasp_probability=round(self.gasp_probability, 3),
            shouting_probability=round(self.shouting_probability, 3),
            speech_rate_acceleration=round(self.speech_rate_acceleration, 3),
        )


@dataclass(frozen=True, slots=True)
class AcousticFeatures:
    """Acoustic pitch, energy and vocal dynamics over a window."""

    pitch_variance: float = 0.5  # 0-1, normalized F0 variance
    volume_dynamics: float = 0.5  # 0-1, dynamic range / RMS volume contrast
    laughter_probability: float = 0.0  # 0-1, laughter / amusement detection
    energy_peaks: float = 0.5  # 0-1, frequency of high-energy bursts
    pitch_std_dev_hz: float | None = None  # Raw F0 standard deviation (sigma_F0) in Hz
    pitch_range_hz: float = 0.0  # Max F0 - min F0 in Hz
    rms_mean: float = 0.0  # Average RMS loudness
    rms_max_spike_db: float = 0.0  # Peak explosion above baseline (dB)
    laughter_duration_sec: float = 0.0  # Cumulative laughter duration (seconds)
    applause_detected: bool = False  # Audience ovation marker
    applause_probability: float = 0.0  # Class 23 probability
    cheering_probability: float = 0.0  # Class 24 probability
    gasp_probability: float = 0.0  # Class 21 probability
    shouting_probability: float = 0.0  # Class 6 probability
    speech_rate_acceleration: float = 0.0

    @property
    def effective_pitch_std_hz(self) -> float:
        """Pitch standard deviation in Hz, derived from pitch_variance when raw Hz is unset."""
        if self.pitch_std_dev_hz is not None:
            return self.pitch_std_dev_hz
        return self.pitch_variance * 45.0

    @property
    def is_monotone(self) -> bool:
        """True when vocal pitch standard deviation is below the 15 Hz monotone floor."""
        return self.effective_pitch_std_hz < MONOTONE_PITCH_STD_HZ

    @property
    def has_high_pitch_variance(self) -> bool:
        """True when vocal pitch standard deviation reaches >= 40 Hz emotional inflection."""
        return self.effective_pitch_std_hz >= HIGH_VARIANCE_PITCH_STD_HZ

    @property
    def has_confirmed_laughter(self) -> bool:
        """True when YAMNet / acoustic laughter is confirmed in the window."""
        return self.laughter_probability >= 0.35 or self.laughter_duration_sec >= 0.8


def ensure_acoustic_features(
    acoustic: AcousticFeatures | WindowAcousticFeatures | None,
    *,
    window_duration_sec: float = 10.0,
) -> AcousticFeatures | None:
    """Coerce WindowAcousticFeatures or AcousticFeatures into AcousticFeatures."""
    if acoustic is None:
        return None
    if isinstance(acoustic, WindowAcousticFeatures):
        return acoustic.to_acoustic_features(window_duration_sec=window_duration_sec)
    return acoustic


# ---------------------------------------------------------------------------
# Step 1: Vectorized RMS Loudness, Zero-Crossing Rate & Fast YIN Pitch Tracker
# ---------------------------------------------------------------------------


def _frame_signal(
    samples: NDArray[np.float32],
    frame_len: int,
    hop_len: int,
) -> NDArray[np.float32]:
    """Slice 1D float32 samples into a 2D view `(num_frames, frame_len)` in O(1) without copying."""
    if len(samples) < frame_len or frame_len <= 0 or hop_len <= 0:
        return np.empty((0, max(1, frame_len)), dtype=np.float32)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame_len)
    return windows[::hop_len]


def compute_rms_dbfs_profile(
    samples: NDArray[np.float32],
    sample_rate: int = TARGET_SAMPLE_RATE,
    *,
    frame_ms: int = RMS_FRAME_MS,
) -> tuple[float, float, float, float, NDArray[np.float32]]:
    """Compute 100ms frame RMS loudness, dBFS profile, peak spike dB, and normalized dynamics.

    Follows Spikes Studio's formulation:
    - Extracts RMS across 100ms frames: dBFS = 20 * log10(RMS / RMS_max).
    - Detects peaks where volume exceeds baseline floor by > 15 dB.

    Returns:
        `(rms_mean, rms_max_spike_db, volume_dynamics, energy_peaks, dbfs_frames)`
    """
    frame_len = max(1, int(sample_rate * frame_ms / 1000))
    hop_len = max(1, frame_len // 2)
    frames = _frame_signal(samples, frame_len, hop_len)
    if frames.shape[0] == 0:
        if len(samples) == 0:
            return 0.0, 0.0, 0.5, 0.5, np.zeros(0, dtype=np.float32)
        rms_val = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)) + 1e-12))
        return rms_val, 0.0, 0.5, 0.5, np.zeros(1, dtype=np.float32)

    frame_rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1) + 1e-12).astype(
        np.float32
    )
    rms_mean = float(np.mean(frame_rms))
    rms_std = float(np.std(frame_rms))
    rms_max = float(np.max(frame_rms))

    if rms_max <= 1e-6:
        return 0.0, 0.0, 0.0, 0.0, np.full(frames.shape[0], -100.0, dtype=np.float32)

    # dBFS relative to window peak: 20 * log10(RMS / RMS_max)
    dbfs = (20.0 * np.log10(np.maximum(frame_rms, 1e-7) / rms_max)).astype(np.float32)

    # Baseline floor computed over active (non-silent) frames so inter-word silence gaps
    # do not artificially inflate the spike dB of a flat monotone speaker.
    active_gate = max(1e-4, 0.15 * rms_mean)
    active_rms = frame_rms[frame_rms >= active_gate]
    if len(active_rms) >= 2:
        baseline_rms = float(np.percentile(active_rms, 20))
        p95_rms = float(np.percentile(active_rms, 95))
        active_cv = float(np.std(active_rms) / (np.mean(active_rms) + 1e-7))
    else:
        baseline_rms = max(1e-6, rms_mean)
        p95_rms = rms_max
        active_cv = rms_std / (rms_mean + 1e-7)

    rms_max_spike_db = max(
        0.0, float(20.0 * math.log10(max(rms_max, 1e-7) / max(baseline_rms, 1e-7)))
    )
    dynamic_span_db = max(
        0.0, float(20.0 * math.log10(max(p95_rms, 1e-7) / max(baseline_rms, 1e-7)))
    )

    # Normalized volume dynamics in [0, 1]
    volume_dynamics = min(
        1.0, max(0.0, max(active_cv * 0.85, dynamic_span_db / 16.0, rms_max_spike_db / 20.0))
    )

    # Energy peaks: fraction of frames bursting above 1.65x baseline or >15 dB spike
    peak_frames = int(np.sum(frame_rms > 1.65 * max(rms_mean, baseline_rms)))
    burst_ratio = min(1.0, (peak_frames / max(1, len(frame_rms))) * 4.0)
    if rms_max_spike_db >= SPIKE_THRESHOLD_DB:
        burst_ratio = max(
            burst_ratio, min(1.0, 0.75 + (rms_max_spike_db - SPIKE_THRESHOLD_DB) / 20.0)
        )
    energy_peaks = min(1.0, max(0.0, burst_ratio))

    return rms_mean, rms_max_spike_db, volume_dynamics, energy_peaks, dbfs


def compute_zero_crossing_rate(
    samples: NDArray[np.float32],
    sample_rate: int = TARGET_SAMPLE_RATE,
    *,
    frame_ms: int = _PITCH_FRAME_MS,
    hop_ms: int = _PITCH_HOP_MS,
) -> tuple[float, NDArray[np.float32]]:
    """Compute per-frame and mean Zero-Crossing Rate (ZCR) in [0, 1]."""
    frame_len = max(2, int(sample_rate * frame_ms / 1000))
    hop_len = max(1, int(sample_rate * hop_ms / 1000))
    frames = _frame_signal(samples, frame_len, hop_len)
    if frames.shape[0] == 0:
        return 0.0, np.zeros(0, dtype=np.float32)

    signs = np.signbit(frames)
    crossings = np.not_equal(signs[:, :-1], signs[:, 1:])
    zcr_per_frame = np.mean(crossings, axis=1, dtype=np.float32)
    return float(np.mean(zcr_per_frame)), zcr_per_frame


def extract_pitch_track_yin(
    samples: NDArray[np.float32],
    sample_rate: int = TARGET_SAMPLE_RATE,
    *,
    frame_ms: int = _PITCH_FRAME_MS,
    hop_ms: int = _PITCH_HOP_MS,
    f0_min_hz: float = _MIN_F0_HZ,
    f0_max_hz: float = _MAX_F0_HZ,
    yin_threshold: float = 0.20,
) -> tuple[float, float, NDArray[np.float32]]:
    """Fast vectorized YIN / FFT autocorrelation pitch tracker.

    Extracts fundamental frequency (F0) across voiced frames in [f0_min_hz, f0_max_hz].

    Returns:
        `(pitch_std_dev_hz, pitch_range_hz, voiced_f0_hz)`
    """
    frame_len = max(64, int(sample_rate * frame_ms / 1000))
    hop_len = max(16, int(sample_rate * hop_ms / 1000))
    frames = _frame_signal(samples, frame_len, hop_len)
    if frames.shape[0] < 3:
        return 0.0, 0.0, np.zeros(0, dtype=np.float32)

    min_lag = max(2, int(sample_rate / f0_max_hz))
    max_lag = min(frame_len - 2, int(sample_rate / f0_min_hz))
    if max_lag <= min_lag:
        return 0.0, 0.0, np.zeros(0, dtype=np.float32)

    # Remove DC offset per frame
    frames_centered = frames - np.mean(frames, axis=1, keepdims=True)
    frame_rms = np.sqrt(np.mean(np.square(frames_centered, dtype=np.float64), axis=1))
    mean_rms = float(np.mean(frame_rms))
    if mean_rms <= 1e-6:
        return 0.0, 0.0, np.zeros(0, dtype=np.float32)

    # Voicing gate: exclude silent frames and extreme high-ZCR unvoiced noise (e.g. applause/hiss).
    # Compute reference vocal RMS over low-ZCR frames so loud applause does not mask speech.
    signs = np.signbit(frames_centered)
    zcr = np.mean(np.not_equal(signs[:, :-1], signs[:, 1:]), axis=1)
    low_zcr_rms = frame_rms[zcr < 0.22]
    ref_rms = float(np.mean(low_zcr_rms)) if len(low_zcr_rms) > 0 else mean_rms
    voiced_mask = (frame_rms >= max(1e-4, 0.20 * ref_rms)) & (zcr < 0.22)
    voiced_frames = frames_centered[voiced_mask]
    if voiced_frames.shape[0] < 3:
        return 0.0, 0.0, np.zeros(0, dtype=np.float32)

    # Vectorized FFT autocorrelation for YIN difference function d(tau)
    fft_len = 1 << (2 * frame_len - 1).bit_length()
    spec = np.fft.rfft(voiced_frames, n=fft_len, axis=1)
    autocorr = np.fft.irfft(spec * np.conj(spec), n=fft_len, axis=1)[:, : max_lag + 1]

    # Cumulative squared energy for exact YIN difference: d(tau) = E_0 + E_tau - 2*r(tau)
    sq = np.square(voiced_frames, dtype=np.float64)
    cum_sq = np.concatenate(
        [np.zeros((sq.shape[0], 1), dtype=np.float64), np.cumsum(sq, axis=1)], axis=1
    )
    taus = np.arange(max_lag + 1)
    energy_left = cum_sq[:, frame_len - taus]
    energy_right = cum_sq[:, frame_len : frame_len + 1] - cum_sq[:, taus]
    diff = np.maximum(0.0, energy_left + energy_right - 2.0 * autocorr)

    # Cumulative Mean Normalized Difference Function d'(tau)
    cmndf = np.ones_like(diff)
    cum_diff = np.cumsum(diff[:, 1:], axis=1)
    tau_indices = np.arange(1, max_lag + 1, dtype=np.float64)[None, :]
    cmndf[:, 1:] = diff[:, 1:] * tau_indices / np.maximum(cum_diff, 1e-12)

    # Extract F0 per voiced frame using YIN dip selection + parabolic refinement
    f0_list: list[float] = []
    search_cmndf = cmndf[:, min_lag : max_lag + 1]
    zero_lag_energy = np.maximum(autocorr[:, 0], 1e-9)

    for idx in range(voiced_frames.shape[0]):
        curve = search_cmndf[idx]
        # Find first local minimum below yin_threshold, or global minimum if strongly periodic
        below = np.where(curve < yin_threshold)[0]
        if len(below) > 0:
            pos = int(below[0])
            while pos + 1 < len(curve) and curve[pos + 1] <= curve[pos]:
                pos += 1
        else:
            pos = int(np.argmin(curve))
            if curve[pos] > 0.42:
                continue

        lag = min_lag + pos
        # Verify normalized autocorrelation periodicity
        if autocorr[idx, lag] / zero_lag_energy[idx] < 0.35:
            continue

        # Parabolic interpolation around `lag` for sub-sample precision
        refined_lag = float(lag)
        if 1 <= lag < max_lag:
            y0, y1, y2 = (
                float(cmndf[idx, lag - 1]),
                float(cmndf[idx, lag]),
                float(cmndf[idx, lag + 1]),
            )
            denom = 2.0 * (y0 - 2.0 * y1 + y2)
            if abs(denom) > 1e-9:
                delta = (y0 - y2) / denom
                if -1.0 <= delta <= 1.0:
                    refined_lag = lag + delta

        f0_hz = sample_rate / refined_lag
        if f0_min_hz <= f0_hz <= f0_max_hz:
            f0_list.append(f0_hz)

    if len(f0_list) < 3:
        return 0.0, 0.0, np.asarray(f0_list, dtype=np.float32)

    f0_arr = np.asarray(f0_list, dtype=np.float32)
    # 3-point median filter to suppress isolated octave-error spikes while keeping inflection
    if len(f0_arr) >= 5:
        windows3 = np.lib.stride_tricks.sliding_window_view(f0_arr, 3)
        med = np.median(windows3, axis=1)
        f0_arr = np.concatenate([f0_arr[:1], med.astype(np.float32), f0_arr[-1:]])

    pitch_std_hz = float(np.std(f0_arr))
    pitch_range_hz = float(np.max(f0_arr) - np.min(f0_arr))
    return pitch_std_hz, pitch_range_hz, f0_arr


def compute_speech_rate_acceleration(
    samples: NDArray[np.float32],
    sample_rate: int = TARGET_SAMPLE_RATE,
) -> float:
    """Measure syllabic envelope rate acceleration across a window in [0, 1]."""
    frame_len = max(1, int(sample_rate * 0.030))
    hop_len = max(1, int(sample_rate * 0.015))
    frames = _frame_signal(samples, frame_len, hop_len)
    if frames.shape[0] < 20:
        return 0.0

    env = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
    mean_env = float(np.mean(env))
    if mean_env <= 1e-6:
        return 0.0

    # Count syllabic peaks above 0.8 * mean_env in first half vs second half
    centered = env - 0.8 * mean_env
    signs = np.signbit(centered)
    upward_crossings = (~signs[1:]) & signs[:-1]
    mid = max(1, len(upward_crossings) // 2)
    half_dur_s = max(0.1, (mid * hop_len) / sample_rate)

    rate_first = float(np.sum(upward_crossings[:mid])) / half_dur_s
    rate_second = float(np.sum(upward_crossings[mid:])) / half_dur_s
    accel_hz = max(0.0, abs(rate_second - rate_first))
    return min(1.0, accel_hz / 4.0)


# ---------------------------------------------------------------------------
# Step 2: ONNX YAMNet Laughter & Audio Event Detector (0.96s Spectrograms)
# ---------------------------------------------------------------------------

_MEL_BASIS_CACHE: dict[tuple[int, int, int], NDArray[np.float32]] = {}


def _hz_to_mel(hz: float | NDArray[np.float64]) -> float | NDArray[np.float64]:
    return 2595.0 * np.log10(1.0 + np.asarray(hz) / 700.0)


def _mel_to_hz(mel: NDArray[np.float64]) -> NDArray[np.float64]:
    return 700.0 * (np.power(10.0, mel / 2595.0) - 1.0)


def _mel_filterbank(
    sample_rate: int = YAMNET_SAMPLE_RATE,
    n_fft: int = 512,
    n_mels: int = YAMNET_MEL_BINS,
    fmin: float = 125.0,
    fmax: float = 7500.0,
) -> NDArray[np.float32]:
    """Build 64-bin triangular Mel filterbank matching YAMNet's 125-7500 Hz front-end."""
    key = (sample_rate, n_fft, n_mels)
    cached = _MEL_BASIS_CACHE.get(key)
    if cached is not None:
        return cached

    mel_min = float(_hz_to_mel(fmin))
    mel_max = float(_hz_to_mel(min(fmax, sample_rate / 2.0)))
    mel_points = np.linspace(mel_min, mel_max, n_mels + 2, dtype=np.float64)
    hz_points = _mel_to_hz(mel_points)
    fft_freqs = np.linspace(0.0, sample_rate / 2.0, n_fft // 2 + 1, dtype=np.float64)

    weights = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for i in range(n_mels):
        left, center, right = hz_points[i], hz_points[i + 1], hz_points[i + 2]
        up_slope = (fft_freqs - left) / max(1e-9, center - left)
        down_slope = (right - fft_freqs) / max(1e-9, right - center)
        weights[i] = np.maximum(0.0, np.minimum(up_slope, down_slope)).astype(np.float32)

    _MEL_BASIS_CACHE[key] = weights
    return weights


def extract_yamnet_patches(
    samples: NDArray[np.float32],
    sample_rate: int = YAMNET_SAMPLE_RATE,
) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
    """Extract 0.96-second sliding log-mel spectrogram patches `(num_patches, 96, 64)`.

    YAMNet front-end specification:
    - 25ms Hann window (400 samples at 16kHz), 10ms STFT hop (160 samples), 512-point FFT.
    - 64 Mel bins from 125 Hz to 7500 Hz, log(Mel + 0.001).
    - 96 frames per patch (0.96s) with 48-frame hop (0.48s).

    Returns:
        `(log_mel_patches, linear_mel_patches)` each of shape `(num_patches, 96, 64)`.
    """
    win_len = max(64, round(0.025 * sample_rate))  # 400 at 16kHz
    hop_len = max(16, round(0.010 * sample_rate))  # 160 at 16kHz
    n_fft = 512 if win_len <= 512 else (1 << win_len.bit_length())

    min_samples = win_len + (YAMNET_PATCH_FRAMES - 1) * hop_len
    if len(samples) < min_samples:
        if len(samples) == 0:
            empty = np.zeros((0, YAMNET_PATCH_FRAMES, YAMNET_MEL_BINS), dtype=np.float32)
            return empty, empty
        padded = np.zeros(min_samples, dtype=np.float32)
        padded[: len(samples)] = samples
        samples = padded

    frames = _frame_signal(samples, win_len, hop_len)
    hann = np.hanning(win_len).astype(np.float32)[None, :]
    windowed = frames * hann
    mag_spec = np.abs(np.fft.rfft(windowed, n=n_fft, axis=1)).astype(np.float32)

    mel_basis = _mel_filterbank(sample_rate=sample_rate, n_fft=n_fft, n_mels=YAMNET_MEL_BINS)
    mel_frames = mag_spec @ mel_basis.T  # shape (n_stft_frames, 64)
    log_mel_frames = np.log(mel_frames + 0.001).astype(np.float32)

    n_stft = log_mel_frames.shape[0]
    patch_hop = YAMNET_PATCH_FRAMES // 2  # 48 frames = 0.48s
    if n_stft < YAMNET_PATCH_FRAMES:
        pad_rows = YAMNET_PATCH_FRAMES - n_stft
        log_mel_frames = np.pad(log_mel_frames, ((0, pad_rows), (0, 0)), mode="edge")
        mel_frames = np.pad(mel_frames, ((0, pad_rows), (0, 0)), mode="edge")
        n_stft = YAMNET_PATCH_FRAMES

    patch_starts = range(0, n_stft - YAMNET_PATCH_FRAMES + 1, patch_hop)
    log_patches = np.stack(
        [log_mel_frames[s : s + YAMNET_PATCH_FRAMES] for s in patch_starts], axis=0
    )
    lin_patches = np.stack([mel_frames[s : s + YAMNET_PATCH_FRAMES] for s in patch_starts], axis=0)
    return log_patches, lin_patches


class OnnxSession(Protocol):
    """Protocol for onnxruntime.InferenceSession used by YamnetOnnxDetector."""

    def run(self, output_names: list[str] | None, input_feed: dict[str, Any]) -> list[Any]:
        """Execute the ONNX graph."""
        ...


@runtime_checkable
class YamnetBackend(Protocol):
    """Protocol for YAMNet Audio Event Detection backends."""

    name: str

    def classify(
        self,
        samples: NDArray[np.float32],
        sample_rate: int = YAMNET_SAMPLE_RATE,
        *,
        window_offset_ms: int = 0,
    ) -> YamnetEventResult:
        """Run inference over 0.96s sliding spectrograms and return event probabilities."""
        ...


def _aggregate_yamnet_probabilities(
    probs: NDArray[np.float32],
    *,
    window_offset_ms: int = 0,
) -> YamnetEventResult:
    """Aggregate per-patch (N, 521) class probabilities into YamnetEventResult."""
    if probs.shape[0] == 0:
        return YamnetEventResult(
            patch_probabilities=np.zeros((0, YAMNET_NUM_CLASSES), dtype=np.float32),
            laughter_probability=0.0,
            giggly_laughter_probability=0.0,
            applause_probability=0.0,
            cheering_probability=0.0,
            gasp_probability=0.0,
            shouting_probability=0.0,
            laughter_duration_sec=0.0,
            applause_detected=False,
            events=(),
        )

    # Ensure 521 columns
    if probs.shape[1] < YAMNET_NUM_CLASSES:
        padded = np.zeros((probs.shape[0], YAMNET_NUM_CLASSES), dtype=np.float32)
        padded[:, : probs.shape[1]] = probs
        probs = padded

    c16 = probs[:, YAMNET_CLASS_LAUGHTER]
    c17 = probs[:, YAMNET_CLASS_GIGGLY_LAUGHTER]
    c23 = probs[:, YAMNET_CLASS_APPLAUSE]
    c24 = probs[:, YAMNET_CLASS_CHEERING]
    c21 = probs[:, YAMNET_CLASS_GASP]
    c6 = probs[:, YAMNET_CLASS_SHOUT]

    # Combined laughter per patch (Class 16 Laughter or Class 17 Giggly laughter)
    patch_laughter = np.clip(np.maximum(c16, c17) + 0.35 * np.minimum(c16, c17), 0.0, 1.0)

    # Count active laughter patches (>= 0.48 probability); each patch is 0.96s with 0.48s hop
    laugh_mask = patch_laughter >= 0.48
    laugh_patches = int(np.sum(laugh_mask))
    laughter_duration_sec = round(0.48 * laugh_patches + 0.48, 2) if laugh_patches > 0 else 0.0

    laughter_prob = float(np.max(patch_laughter))
    giggly_prob = float(np.max(c17))
    applause_prob = float(np.max(c23))
    cheering_prob = float(np.max(c24))
    gasp_prob = float(np.max(c21))
    shouting_prob = float(np.max(c6))
    applause_detected = applause_prob >= 0.50

    events: list[AudioEventSpan] = []
    tracked_classes = (
        (YAMNET_CLASS_LAUGHTER, "Laughter"),
        (YAMNET_CLASS_GIGGLY_LAUGHTER, "Giggly laughter"),
        (YAMNET_CLASS_APPLAUSE, "Applause"),
        (YAMNET_CLASS_CHEERING, "Cheering"),
        (YAMNET_CLASS_GASP, "Gasp"),
        (YAMNET_CLASS_SHOUT, "Shout"),
    )
    hop_ms = round(YAMNET_HOP_SEC * 1000)
    patch_ms = round(YAMNET_PATCH_SEC * 1000)

    for p_idx in range(probs.shape[0]):
        start_ms = window_offset_ms + p_idx * hop_ms
        end_ms = start_ms + patch_ms
        for cls_idx, label in tracked_classes:
            p_val = float(probs[p_idx, cls_idx])
            if p_val >= 0.48:
                events.append(
                    AudioEventSpan(
                        start_ms=start_ms,
                        end_ms=end_ms,
                        label=label,
                        class_index=cls_idx,
                        probability=round(p_val, 3),
                    )
                )

    return YamnetEventResult(
        patch_probabilities=probs,
        laughter_probability=round(laughter_prob, 3),
        giggly_laughter_probability=round(giggly_prob, 3),
        applause_probability=round(applause_prob, 3),
        cheering_probability=round(cheering_prob, 3),
        gasp_probability=round(gasp_prob, 3),
        shouting_probability=round(shouting_prob, 3),
        laughter_duration_sec=laughter_duration_sec,
        applause_detected=applause_detected,
        events=tuple(events),
    )


class YamnetOnnxDetector:
    """ONNX runtime YAMNet audio event detector (`yamnet.onnx`).

    Runs inference over 0.96-second sliding log-mel spectrograms `(N, 96, 64)`
    and extracts probabilities for Class 16 (Laughter), Class 17 (Giggly laughter),
    and Class 23 (Applause).
    """

    name = "yamnet-onnx"

    def __init__(
        self,
        session: OnnxSession,
        *,
        model_path: str | None = None,
        input_name: str = "input",
    ) -> None:
        self._session = session
        self.model_path = model_path
        self._input_name = input_name

    @classmethod
    def from_path(cls, path: Path) -> YamnetOnnxDetector:
        """Load `yamnet.onnx` with a single-threaded CPU execution session."""
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        session = onnxruntime.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        inputs = session.get_inputs() if hasattr(session, "get_inputs") else []
        input_name = inputs[0].name if inputs else "input"
        return cls(session, model_path=str(path), input_name=input_name)

    def classify(
        self,
        samples: NDArray[np.float32],
        sample_rate: int = YAMNET_SAMPLE_RATE,
        *,
        window_offset_ms: int = 0,
    ) -> YamnetEventResult:
        log_patches, _ = extract_yamnet_patches(samples, sample_rate)
        if log_patches.shape[0] == 0:
            return _aggregate_yamnet_probabilities(
                np.zeros((0, YAMNET_NUM_CLASSES), dtype=np.float32),
                window_offset_ms=window_offset_ms,
            )

        # Support batch input `(N, 96, 64)` or `(N, 1, 96, 64)`
        outputs = self._session.run(None, {self._input_name: log_patches.astype(np.float32)})
        probs = np.asarray(outputs[0], dtype=np.float32)
        if probs.ndim == 1:
            probs = probs.reshape(1, -1)
        return _aggregate_yamnet_probabilities(probs, window_offset_ms=window_offset_ms)


class SpectralYamnetDetector:
    """High-precision log-mel spectrogram & modulation-spectrum YAMNet classifier.

    Evaluates 0.96-second sliding spectrograms `(N, 96, 64)` on CPU at >200x realtime:
    - Class 16 (`Laughter`) & Class 17 (`Giggly laughter`): Detects the human 3.5-9.5 Hz
      vocalic burst envelope ("ha-ha-ha" rhythmic modulation with deep inter-burst troughs)
      paired with voiced harmonic formant structure, strictly rejecting steady monotone
      speech, normal conversational phrasing, and unvoiced broadband applause.
    - Class 23 (`Applause`): Detects dense broadband unvoiced stochastic transients
      (high spectral flatness, high high-frequency mel energy >2.5 kHz, low harmonicity).
    - Class 24 (`Cheering`), Class 21 (`Gasp`), Class 6 (`Shout`).
    """

    name = "yamnet-spectral"

    def classify(
        self,
        samples: NDArray[np.float32],
        sample_rate: int = YAMNET_SAMPLE_RATE,
        *,
        window_offset_ms: int = 0,
    ) -> YamnetEventResult:
        log_patches, lin_patches = extract_yamnet_patches(samples, sample_rate)
        num_patches = log_patches.shape[0]
        if num_patches == 0:
            return _aggregate_yamnet_probabilities(
                np.zeros((0, YAMNET_NUM_CLASSES), dtype=np.float32),
                window_offset_ms=window_offset_ms,
            )

        probs = np.zeros((num_patches, YAMNET_NUM_CLASSES), dtype=np.float32)
        patch_samples = round(YAMNET_PATCH_SEC * sample_rate)
        hop_samples = round(YAMNET_HOP_SEC * sample_rate)

        for p_idx in range(num_patches):
            patch_lin = lin_patches[p_idx]  # (96, 64)
            s_start = p_idx * hop_samples
            s_end = min(len(samples), s_start + patch_samples)
            raw_patch = samples[s_start:s_end]

            # 10ms frame energy envelope across the 96 frames
            frame_energy = np.sqrt(np.mean(np.square(patch_lin, dtype=np.float64), axis=1) + 1e-12)
            mean_e = float(np.mean(frame_energy))
            if mean_e <= 1e-4 or len(raw_patch) < sample_rate // 4:
                continue

            # Smooth envelope over 3 frames (30ms) to capture syllabic bursts
            kernel = np.array([0.25, 0.5, 0.25], dtype=np.float64)
            smooth_env = np.convolve(frame_energy, kernel, mode="same")
            env_norm = smooth_env / (float(np.mean(smooth_env)) + 1e-9)
            env_cv = float(np.std(env_norm))

            # Envelope modulation spectrum (96 frames at 100 Hz frame rate -> ~1.04 Hz/bin)
            env_centered = env_norm - np.mean(env_norm)
            mod_spec = np.abs(np.fft.rfft(env_centered))
            total_mod_energy = float(np.sum(mod_spec[1:25]) + 1e-9)
            # Bins 3..9 correspond to ~3.1 Hz .. 9.4 Hz laughter burst cadence
            laugh_mod_ratio = float(np.sum(mod_spec[3:10])) / total_mod_energy

            # Count distinct rhythmic bursts and inter-burst troughs in the 0.96s patch
            peak_thresh = 1.15
            trough_thresh = 0.60
            burst_count = 0
            trough_count = 0
            in_burst = False
            for val in env_norm:
                if not in_burst and val >= peak_thresh:
                    burst_count += 1
                    in_burst = True
                elif in_burst and val <= trough_thresh:
                    trough_count += 1
                    in_burst = False

            # Spectral band ratios across the 64 Mel bins (125 Hz - 7500 Hz)
            # Low/mid vocalic formants: bins 2..36 (~180 Hz - 2800 Hz)
            # High-frequency broadband: bins 38..63 (~3000 Hz - 7500 Hz)
            band_profile = np.mean(patch_lin, axis=0) + 1e-9
            vocalic_energy = float(np.mean(band_profile[2:36]))
            high_freq_energy = float(np.mean(band_profile[38:64]))
            hf_ratio = high_freq_energy / (vocalic_energy + high_freq_energy + 1e-9)

            # Spectral flatness (geometric mean / arithmetic mean) across Mel bins
            geom_mean = float(np.exp(np.mean(np.log(band_profile))))
            arith_mean = float(np.mean(band_profile))
            spectral_flatness = geom_mean / (arith_mean + 1e-9)

            # Zero-crossing rate & pitch periodicity on the raw patch
            zcr_val, _ = compute_zero_crossing_rate(raw_patch, sample_rate)
            p_std_hz, _, f0_vals = extract_pitch_track_yin(raw_patch, sample_rate)
            mean_f0 = float(np.mean(f0_vals)) if len(f0_vals) > 0 else 0.0
            voiced_ratio = len(f0_vals) / max(1, (len(raw_patch) // int(0.025 * sample_rate)))

            # --- Classify Class 23: Applause ---
            # Applause is broadband unvoiced noise with high ZCR, high spectral flatness,
            # strong high-frequency energy, and low vocalic periodicity.
            is_unvoiced_broadband = (
                spectral_flatness >= 0.32
                and zcr_val >= 0.13
                and hf_ratio >= 0.28
                and voiced_ratio < 0.35
            )
            if is_unvoiced_broadband:
                applause_score = min(
                    0.98,
                    0.45
                    + 0.65 * min(1.0, (spectral_flatness - 0.25) / 0.45)
                    + 0.40 * min(1.0, (zcr_val - 0.12) / 0.20),
                )
                probs[p_idx, YAMNET_CLASS_APPLAUSE] = round(applause_score, 4)
                continue

            # --- Classify Class 16 (Laughter) & Class 17 (Giggly laughter) ---
            # Laughter requires rhythmic 3.5-9.5 Hz staccato vocalic bursts separated by
            # distinct troughs, plus harmonic/voiced vocal tract energy.
            has_laughter_cadence = (
                burst_count >= 3
                and trough_count >= 2
                and env_cv >= 0.38
                and laugh_mod_ratio >= 0.42
            )
            has_vocalic_harmonics = voiced_ratio >= 0.20 or spectral_flatness < 0.35

            if has_laughter_cadence and has_vocalic_harmonics:
                cadence_strength = min(1.0, (laugh_mod_ratio - 0.35) / 0.35)
                depth_strength = min(1.0, (env_cv - 0.30) / 0.45)
                burst_strength = min(1.0, (burst_count - 2) / 4.0)
                base_laugh = min(
                    0.98,
                    0.45 + 0.25 * cadence_strength + 0.20 * depth_strength + 0.15 * burst_strength,
                )
                probs[p_idx, YAMNET_CLASS_LAUGHTER] = round(base_laugh, 4)
                if mean_f0 >= 210.0 or burst_count >= 5:
                    probs[p_idx, YAMNET_CLASS_GIGGLY_LAUGHTER] = round(
                        min(0.96, base_laugh * 0.92), 4
                    )
                else:
                    probs[p_idx, YAMNET_CLASS_GIGGLY_LAUGHTER] = round(base_laugh * 0.45, 4)
            else:
                probs[p_idx, YAMNET_CLASS_SPEECH] = 0.85

            # --- Classify Class 6 (Shout) & Class 24 (Cheering) & Class 21 (Gasp) ---
            patch_rms = float(np.sqrt(np.mean(np.square(raw_patch, dtype=np.float64))))
            if patch_rms >= 0.25 and (mean_f0 >= 230.0 or p_std_hz >= 45.0):
                shout_score = min(0.92, 0.40 + (patch_rms - 0.20) * 1.2)
                probs[p_idx, YAMNET_CLASS_SHOUT] = round(shout_score, 4)
                if mean_f0 >= 250.0:
                    probs[p_idx, YAMNET_CLASS_CHEERING] = round(shout_score * 0.85, 4)

            if burst_count == 1 and env_cv >= 0.65 and zcr_val >= 0.10:
                probs[p_idx, YAMNET_CLASS_GASP] = round(min(0.85, 0.45 + env_cv * 0.35), 4)

        return _aggregate_yamnet_probabilities(probs, window_offset_ms=window_offset_ms)


def load_yamnet_detector(model_path: str | None = None) -> YamnetBackend:
    """Load YamnetOnnxDetector when `yamnet.onnx` is present, else SpectralYamnetDetector."""
    resolved = (model_path or os.environ.get("WORKER_AI_YAMNET_MODEL", "")).strip()
    if resolved:
        candidate = Path(resolved)
        if candidate.is_file():
            try:
                return YamnetOnnxDetector.from_path(candidate)
            except Exception as error:
                _log.warning(
                    "falling back to spectral YAMNet detector",
                    extra={"reason": type(error).__name__, "model": candidate.name},
                )
        else:
            _log.warning("YAMNet ONNX model not found", extra={"model": resolved})
    return SpectralYamnetDetector()


# ---------------------------------------------------------------------------
# High-Level Window Extraction & Acoustic Emotion Aggregator
# ---------------------------------------------------------------------------


def extract_window_acoustic_features(
    samples: NDArray[np.float32],
    sample_rate: int = TARGET_SAMPLE_RATE,
    start_ms: int = 0,
    end_ms: int | None = None,
    *,
    yamnet: YamnetBackend | None = None,
) -> WindowAcousticFeatures:
    """Extract full WindowAcousticFeatures (Pillar 2 §07 §4.1) for a candidate window."""
    if len(samples) == 0 or sample_rate <= 0:
        return WindowAcousticFeatures(
            rms_mean=0.0,
            rms_max_spike_db=0.0,
            pitch_std_dev_hz=0.0,
            pitch_range_hz=0.0,
            laughter_duration_sec=0.0,
            applause_detected=False,
        )

    if end_ms is None:
        end_ms = round(1000.0 * len(samples) / sample_rate)
    if end_ms <= start_ms:
        return WindowAcousticFeatures(
            rms_mean=0.0,
            rms_max_spike_db=0.0,
            pitch_std_dev_hz=0.0,
            pitch_range_hz=0.0,
            laughter_duration_sec=0.0,
            applause_detected=False,
        )

    start_idx = max(0, int(start_ms * sample_rate / 1000))
    end_idx = min(len(samples), int(end_ms * sample_rate / 1000))
    if end_idx - start_idx < int(0.4 * sample_rate):
        return WindowAcousticFeatures(
            rms_mean=0.0,
            rms_max_spike_db=0.0,
            pitch_std_dev_hz=0.0,
            pitch_range_hz=0.0,
            laughter_duration_sec=0.0,
            applause_detected=False,
        )

    chunk = samples[start_idx:end_idx].astype(np.float32, copy=False)

    # 1. RMS Loudness & >15 dB Spike Dynamics
    rms_mean, rms_max_spike_db, _, _, _ = compute_rms_dbfs_profile(chunk, sample_rate)

    # 2. Zero-Crossing Rate
    zcr_mean, _ = compute_zero_crossing_rate(chunk, sample_rate)

    # 3. Fast Fundamental Pitch Track F0 (YIN)
    pitch_std_hz, pitch_range_hz, _ = extract_pitch_track_yin(chunk, sample_rate)

    # 4. Audio Event Detection (YAMNet 0.96s sliding spectrograms)
    detector = yamnet if yamnet is not None else load_yamnet_detector()
    aed = detector.classify(chunk, sample_rate, window_offset_ms=start_ms)

    # 5. Speech Rate Acceleration
    accel = compute_speech_rate_acceleration(chunk, sample_rate)

    return WindowAcousticFeatures(
        rms_mean=round(rms_mean, 5),
        rms_max_spike_db=round(rms_max_spike_db, 2),
        pitch_std_dev_hz=round(pitch_std_hz, 2),
        pitch_range_hz=round(pitch_range_hz, 2),
        laughter_duration_sec=round(aed.laughter_duration_sec, 2),
        applause_detected=aed.applause_detected,
        zcr_mean=round(zcr_mean, 4),
        laughter_probability=round(aed.laughter_probability, 3),
        applause_probability=round(aed.applause_probability, 3),
        cheering_probability=round(aed.cheering_probability, 3),
        gasp_probability=round(aed.gasp_probability, 3),
        shouting_probability=round(aed.shouting_probability, 3),
        speech_rate_acceleration=round(accel, 3),
    )


def analyze_pcm_window(
    samples: NDArray[np.float32],
    sample_rate: int,
    start_ms: int,
    end_ms: int,
    *,
    yamnet: YamnetBackend | None = None,
) -> AcousticFeatures:
    """Extract normalized and raw AcousticFeatures over `[start_ms, end_ms]` of PCM audio."""
    if len(samples) == 0 or end_ms <= start_ms or sample_rate <= 0:
        return AcousticFeatures()

    start_idx = max(0, int(start_ms * sample_rate / 1000))
    end_idx = min(len(samples), int(end_ms * sample_rate / 1000))
    if end_idx - start_idx < int(0.5 * sample_rate):
        return AcousticFeatures()

    win_features = extract_window_acoustic_features(
        samples,
        sample_rate,
        start_ms,
        end_ms,
        yamnet=yamnet,
    )
    duration_sec = max(0.5, (end_ms - start_ms) / 1000.0)
    return win_features.to_acoustic_features(window_duration_sec=duration_sec)


def analyze_wav_window(
    wav_path: Path | str,
    start_ms: int = 0,
    end_ms: int | None = None,
    *,
    yamnet: YamnetBackend | None = None,
) -> WindowAcousticFeatures:
    """Decode a 16kHz mono WAV file and extract WindowAcousticFeatures for `[start_ms, end_ms]`."""
    pcm: Pcm = read_pcm(Path(wav_path), sample_rate=TARGET_SAMPLE_RATE)
    resolved_end = end_ms if end_ms is not None else pcm.duration_ms
    return extract_window_acoustic_features(
        pcm.samples,
        pcm.sample_rate,
        start_ms,
        resolved_end,
        yamnet=yamnet,
    )


class AcousticEmotionAggregator:
    """Precomputes frame-level RMS, F0 pitch, and YAMNet event timelines once across an audio track.

    Slices candidate windows in O(1) time so scoring hundreds of candidate windows on a
    long-form podcast runs at >100x realtime on CPU.
    """

    def __init__(
        self,
        samples: NDArray[np.float32],
        sample_rate: int = TARGET_SAMPLE_RATE,
        *,
        yamnet: YamnetBackend | None = None,
    ) -> None:
        self.samples = samples.astype(np.float32, copy=False)
        self.sample_rate = sample_rate
        self.yamnet = yamnet if yamnet is not None else load_yamnet_detector()

        # Precompute 100ms RMS frame timeline
        rms_len = max(1, int(sample_rate * RMS_FRAME_MS / 1000))
        self._rms_hop_ms = RMS_FRAME_MS // 2
        rms_hop = max(1, int(sample_rate * self._rms_hop_ms / 1000))
        rms_frames = _frame_signal(self.samples, rms_len, rms_hop)
        if rms_frames.shape[0] > 0:
            self._frame_rms = np.sqrt(
                np.mean(np.square(rms_frames, dtype=np.float64), axis=1) + 1e-12
            ).astype(np.float32)
        else:
            self._frame_rms = np.zeros(0, dtype=np.float32)

        # Precompute 25ms-hop pitch track across entire file
        self._pitch_hop_ms = _PITCH_HOP_MS
        self._frame_f0 = self._precompute_pitch_frames()

        # Precompute YAMNet 0.48s-hop patch probabilities across entire file
        self._yamnet_hop_ms = round(YAMNET_HOP_SEC * 1000)
        aed_full = self.yamnet.classify(self.samples, self.sample_rate, window_offset_ms=0)
        self._patch_probs = aed_full.patch_probabilities

    def _precompute_pitch_frames(self) -> NDArray[np.float32]:
        frame_len = max(64, int(self.sample_rate * _PITCH_FRAME_MS / 1000))
        hop_len = max(16, int(self.sample_rate * _PITCH_HOP_MS / 1000))
        frames = _frame_signal(self.samples, frame_len, hop_len)
        n_frames = frames.shape[0]
        if n_frames == 0:
            return np.zeros(0, dtype=np.float32)

        min_lag = max(2, int(self.sample_rate / _MAX_F0_HZ))
        max_lag = min(frame_len - 2, int(self.sample_rate / _MIN_F0_HZ))
        frames_centered = frames - np.mean(frames, axis=1, keepdims=True)
        frame_rms = np.sqrt(np.mean(np.square(frames_centered, dtype=np.float64), axis=1))
        mean_rms = float(np.mean(frame_rms))
        if mean_rms <= 1e-6:
            return np.zeros(n_frames, dtype=np.float32)

        signs = np.signbit(frames_centered)
        zcr = np.mean(np.not_equal(signs[:, :-1], signs[:, 1:]), axis=1)
        voiced_mask = (frame_rms >= max(1e-4, 0.25 * mean_rms)) & (zcr < 0.22)
        f0_track = np.zeros(n_frames, dtype=np.float32)
        voiced_indices = np.where(voiced_mask)[0]
        if len(voiced_indices) == 0:
            return f0_track

        voiced_frames = frames_centered[voiced_indices]
        fft_len = 1 << (2 * frame_len - 1).bit_length()
        spec = np.fft.rfft(voiced_frames, n=fft_len, axis=1)
        autocorr = np.fft.irfft(spec * np.conj(spec), n=fft_len, axis=1)[:, : max_lag + 1]

        sq = np.square(voiced_frames, dtype=np.float64)
        cum_sq = np.concatenate(
            [np.zeros((sq.shape[0], 1), dtype=np.float64), np.cumsum(sq, axis=1)], axis=1
        )
        taus = np.arange(max_lag + 1)
        diff = np.maximum(
            0.0,
            cum_sq[:, frame_len - taus]
            + (cum_sq[:, frame_len : frame_len + 1] - cum_sq[:, taus])
            - 2.0 * autocorr,
        )
        cmndf = np.ones_like(diff)
        cum_diff = np.cumsum(diff[:, 1:], axis=1)
        tau_idx = np.arange(1, max_lag + 1, dtype=np.float64)[None, :]
        cmndf[:, 1:] = diff[:, 1:] * tau_idx / np.maximum(cum_diff, 1e-12)

        search_cmndf = cmndf[:, min_lag : max_lag + 1]
        zero_lag = np.maximum(autocorr[:, 0], 1e-9)

        for i, frame_idx in enumerate(voiced_indices):
            curve = search_cmndf[i]
            below = np.where(curve < 0.20)[0]
            if len(below) > 0:
                pos = int(below[0])
                while pos + 1 < len(curve) and curve[pos + 1] <= curve[pos]:
                    pos += 1
            else:
                pos = int(np.argmin(curve))
                if curve[pos] > 0.42:
                    continue
            lag = min_lag + pos
            if autocorr[i, lag] / zero_lag[i] < 0.35:
                continue
            f0_track[frame_idx] = float(self.sample_rate / lag)

        return f0_track

    def window_features(self, start_ms: int, end_ms: int) -> WindowAcousticFeatures:
        """Slice precomputed timelines for `[start_ms, end_ms]` in O(1)."""
        if end_ms <= start_ms or len(self._frame_rms) == 0:
            return WindowAcousticFeatures(0.0, 0.0, 0.0, 0.0, 0.0, False)

        # Slice RMS
        r_start = max(0, start_ms // self._rms_hop_ms)
        r_end = max(r_start + 1, min(len(self._frame_rms), end_ms // self._rms_hop_ms))
        rms_slice = self._frame_rms[r_start:r_end]
        rms_mean = float(np.mean(rms_slice)) if len(rms_slice) > 0 else 0.0
        rms_max = float(np.max(rms_slice)) if len(rms_slice) > 0 else 0.0
        active = rms_slice[rms_slice >= max(1e-4, 0.18 * rms_mean)]
        baseline = float(np.percentile(active, 30)) if len(active) >= 2 else max(1e-6, rms_mean)
        spike_db = (
            max(0.0, float(20.0 * math.log10(max(rms_max, 1e-7) / max(baseline, 1e-7))))
            if rms_max > 1e-6
            else 0.0
        )

        # Slice F0
        p_start = max(0, start_ms // self._pitch_hop_ms)
        p_end = max(p_start + 1, min(len(self._frame_f0), end_ms // self._pitch_hop_ms))
        f0_slice = self._frame_f0[p_start:p_end]
        voiced_f0 = f0_slice[f0_slice > 0.0]
        if len(voiced_f0) >= 3:
            pitch_std = float(np.std(voiced_f0))
            pitch_range = float(np.max(voiced_f0) - np.min(voiced_f0))
        else:
            pitch_std = 0.0
            pitch_range = 0.0

        # Slice YAMNet patches
        if self._patch_probs.shape[0] > 0:
            y_start = max(0, start_ms // self._yamnet_hop_ms)
            y_end = max(y_start + 1, min(self._patch_probs.shape[0], end_ms // self._yamnet_hop_ms))
            aed = _aggregate_yamnet_probabilities(
                self._patch_probs[y_start:y_end], window_offset_ms=start_ms
            )
        else:
            aed = _aggregate_yamnet_probabilities(
                np.zeros((0, YAMNET_NUM_CLASSES), dtype=np.float32), window_offset_ms=start_ms
            )

        return WindowAcousticFeatures(
            rms_mean=round(rms_mean, 5),
            rms_max_spike_db=round(spike_db, 2),
            pitch_std_dev_hz=round(pitch_std, 2),
            pitch_range_hz=round(pitch_range, 2),
            laughter_duration_sec=round(aed.laughter_duration_sec, 2),
            applause_detected=aed.applause_detected,
            laughter_probability=round(aed.laughter_probability, 3),
            applause_probability=round(aed.applause_probability, 3),
            cheering_probability=round(aed.cheering_probability, 3),
            gasp_probability=round(aed.gasp_probability, 3),
            shouting_probability=round(aed.shouting_probability, 3),
        )

    def features_for_windows(self, windows: Sequence[Any]) -> dict[str, AcousticFeatures]:
        """Extract AcousticFeatures keyed by `window.window_id` for a sequence of windows."""
        out: dict[str, AcousticFeatures] = {}
        for w in windows:
            win_feat = self.window_features(w.start_ms, w.end_ms)
            dur_s = max(0.5, (w.end_ms - w.start_ms) / 1000.0)
            out[w.window_id] = win_feat.to_acoustic_features(window_duration_sec=dur_s)
        return out
