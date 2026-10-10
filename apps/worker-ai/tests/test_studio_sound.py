"""Unit tests for the Deep Neural Voice Isolation & Studio Sound Engine (Pillar 5, Functionality 01).

Validates:
1. Signal-to-Noise Ratio (SNR) improvement on simulated white noise, asserting ΔSNR >= 12 dB.
2. Signal-to-Noise Ratio (SNR) improvement on simulated HVAC hum & rumble, asserting ΔSNR >= 12 dB.
3. Zero phase distortion: phase coherence preservation across 48 kHz frames.
4. Multi-chunk 48 kHz processing and file saving to `audio_clean.wav`.
"""

from __future__ import annotations

from pathlib import Path
import tempfile

import numpy as np
import pytest

from worker_ai.audio import Pcm, read_pcm, write_wav
from worker_ai.processors.studio_sound import (
    DEFAULT_SAMPLE_RATE,
    StudioSoundPipeline,
    compute_snr_gain_db,
    load_deepfilternet_model,
    process_studio_sound,
)

SAMPLE_RATE = DEFAULT_SAMPLE_RATE


def _speech_tone(
    freq: float = 220.0,
    seconds: float = 4.0,
    *,
    amplitude: float = 0.35,
    sample_rate: int = SAMPLE_RATE,
) -> np.ndarray:
    """Simulated clear speech vocal fundamental and formants (220 Hz + 440 Hz + 880 Hz)."""
    n = int(sample_rate * seconds)
    t = np.arange(n, dtype=np.float32) / np.float32(sample_rate)
    vocal = (
        amplitude * np.sin(2 * np.pi * freq * t)
        + (amplitude * 0.5) * np.sin(2 * np.pi * (freq * 2) * t)
        + (amplitude * 0.25) * np.sin(2 * np.pi * (freq * 4) * t)
    )
    return vocal.astype(np.float32)


def _white_noise(
    seconds: float = 4.0,
    *,
    amplitude: float = 0.05,
    sample_rate: int = SAMPLE_RATE,
    seed: int = 42,
) -> np.ndarray:
    """Simulated broadband Gaussian white noise."""
    rng = np.random.default_rng(seed)
    n = int(sample_rate * seconds)
    return (amplitude * rng.standard_normal(n, dtype=np.float32)).astype(np.float32)


def _hvac_noise(
    seconds: float = 4.0,
    *,
    amplitude: float = 0.08,
    sample_rate: int = SAMPLE_RATE,
    seed: int = 101,
) -> np.ndarray:
    """Simulated air conditioning & HVAC noise:

    60 Hz electrical hum + 120 Hz harmonic + low-frequency air rush rumble (40-180 Hz).
    """
    n = int(sample_rate * seconds)
    t = np.arange(n, dtype=np.float32) / np.float32(sample_rate)

    # 60 Hz power/motor hum + 120 Hz 2nd harmonic
    hum = 0.6 * np.sin(2 * np.pi * 60.0 * t) + 0.4 * np.sin(2 * np.pi * 120.0 * t)

    # Low frequency turbulent airflow rumble (filtered noise)
    rng = np.random.default_rng(seed)
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    # Bandpass/lowpass shaping around 40 - 200 Hz
    rumble_filter = np.exp(-((freqs - 80.0) ** 2) / (2 * (40.0**2)))
    rumble = np.fft.irfft(spec * rumble_filter, n=n)
    rumble = rumble / (np.max(np.abs(rumble)) + 1e-9)

    hvac = (0.5 * hum + 0.5 * rumble) * amplitude
    return hvac.astype(np.float32)


class TestStudioSoundEngine:
    def test_model_loading_fallback(self) -> None:
        """Model loader returns None gracefully without error when local weights directory unset."""
        model = load_deepfilternet_model(None)
        assert model is None or isinstance(model, dict)

    def test_white_noise_cleanup_snr_gain_exceeds_12db(self) -> None:
        """Simulated speech tone in white noise achieves ΔSNR >= 12 dB."""
        seconds = 5.0
        speech = _speech_tone(freq=260.0, seconds=seconds, amplitude=0.4)
        noise = _white_noise(seconds=seconds, amplitude=0.06, seed=7)
        noisy = Pcm(samples=(speech + noise).astype(np.float32), sample_rate=SAMPLE_RATE)

        pipeline = StudioSoundPipeline()
        cleaned = pipeline.process_chunk(noisy)

        snr_gain = compute_snr_gain_db(noisy, cleaned)
        assert snr_gain >= 12.0, f"Expected ΔSNR >= 12 dB, got {snr_gain:.2f} dB"

    def test_hvac_audio_cleanup_snr_gain_exceeds_12db(self) -> None:
        """Simulated speech tone in heavy HVAC & air conditioning drone achieves ΔSNR >= 12 dB."""
        seconds = 5.0
        speech = _speech_tone(freq=200.0, seconds=seconds, amplitude=0.45)
        hvac = _hvac_noise(seconds=seconds, amplitude=0.10, seed=99)
        noisy = Pcm(samples=(speech + hvac).astype(np.float32), sample_rate=SAMPLE_RATE)

        pipeline = StudioSoundPipeline()
        cleaned = pipeline.process_chunk(noisy)

        snr_gain = compute_snr_gain_db(noisy, cleaned)
        assert snr_gain >= 12.0, f"Expected ΔSNR >= 12 dB on HVAC audio, got {snr_gain:.2f} dB"

    def test_zero_phase_distortion(self) -> None:
        """Zero phase distortion: speech spectral phases remain preserved between input and output."""
        seconds = 2.0
        speech = _speech_tone(freq=300.0, seconds=seconds, amplitude=0.3)
        pcm = Pcm(samples=speech, sample_rate=SAMPLE_RATE)

        pipeline = StudioSoundPipeline()
        cleaned = pipeline.process_chunk(pcm)

        # STFT phase analysis at tone bin in steady-state (avoiding boundary frame)
        frame = 2048
        hop = 512
        start = hop * 4
        window = np.hanning(frame + 1)[:-1]

        orig_frame = pcm.samples[start : start + frame] * window
        clean_frame = cleaned.samples[start : start + frame] * window

        orig_fft = np.fft.rfft(orig_frame)
        clean_fft = np.fft.rfft(clean_frame)

        # At the dominant fundamental tone frequency (bin corresponding to 300 Hz)
        freqs = np.fft.rfftfreq(frame, d=1.0 / SAMPLE_RATE)
        bin_idx = int(np.argmin(np.abs(freqs - 300.0)))

        orig_phase = np.angle(orig_fft[bin_idx])
        clean_phase = np.angle(clean_fft[bin_idx])

        # Angular difference modulo 2*pi
        phase_diff = float(np.abs(np.angle(np.exp(1j * (orig_phase - clean_phase)))))
        assert phase_diff < 0.05, f"Expected zero phase distortion, phase diff was {phase_diff:.4f} rad"

    def test_process_studio_sound_file_io(self) -> None:
        """Processes 48 kHz audio through chunked engine and writes `audio_clean.wav` with metrics."""
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            input_file = temp_path / "raw_input.wav"
            output_file = temp_path / "audio_clean.wav"

            seconds = 3.0
            speech = _speech_tone(freq=220.0, seconds=seconds, amplitude=0.35)
            noise = _white_noise(seconds=seconds, amplitude=0.06, seed=7)
            noisy_pcm = Pcm(samples=(speech + noise).astype(np.float32), sample_rate=SAMPLE_RATE)
            write_wav(input_file, noisy_pcm)

            metrics = process_studio_sound(
                input_file,
                output_file,
                target="social",
                window_ms=1000,
                crossfade_ms=100,
            )

            assert output_file.is_file()
            assert metrics.snr_gain_db >= 12.0
            assert abs(metrics.output_lufs - (-16.0)) <= 1.0

            result_pcm = read_pcm(output_file, sample_rate=SAMPLE_RATE)
            assert result_pcm.sample_rate == SAMPLE_RATE
            assert abs(result_pcm.duration_ms - noisy_pcm.duration_ms) <= 50
