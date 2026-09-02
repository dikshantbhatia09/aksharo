"""B10: unit tests for the ``ai.clean`` signal chain on synthetic fixtures.

Fixtures are generated in-process (white/pink noise mixed with a tone standing
in for speech) rather than checked-in audio files, so the suite needs no model
download and runs the same in CI as on a developer machine.
"""

from __future__ import annotations

import gc
import os

import numpy as np
import pytest

from worker_ai.audio import Pcm
from worker_ai.clean.dsp import (
    CHUNK_CROSSFADE_MS,
    STRENGTH_MIX_RATIO,
    TARGET_LUFS,
    TRUE_PEAK_CEILING_DBTP,
    clip_count,
    crossfade_concat,
    integrated_loudness,
    mix,
    normalize_loudness,
    spectral_gate_denoise,
    true_peak_dbtp,
)
from worker_ai.clean.processor import run_clean_chain

SAMPLE_RATE = 48_000

slow = pytest.mark.skipif(
    os.environ.get("RUN_SLOW") != "1",
    reason="processes 60 minutes of synthetic audio; set RUN_SLOW=1",
)


def _tone(
    freq: float, seconds: float, *, amplitude: float = 0.3, sample_rate: int = SAMPLE_RATE
) -> np.ndarray:
    # float32 throughout (an int64 `arange` plus a float64 division and a
    # float64 `sin`, all at once, is three ~1.3 GB temporaries at the RSS
    # test's 60-minute scale) — harmless at every other call site's scale too.
    n = int(sample_rate * seconds)
    t = np.arange(n, dtype=np.float32) / np.float32(sample_rate)
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _white_noise(
    seconds: float, *, amplitude: float = 0.05, sample_rate: int = SAMPLE_RATE, seed: int = 0
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(sample_rate * seconds)
    # `Generator.standard_normal` draws directly in float32 given a `dtype`,
    # skipping the float64 intermediate `.astype(np.float32)` would otherwise
    # need (same reasoning as `_tone` above).
    return (amplitude * rng.standard_normal(n, dtype=np.float32)).astype(np.float32)


def _pink_noise(
    seconds: float, *, amplitude: float = 0.05, sample_rate: int = SAMPLE_RATE, seed: int = 1
) -> np.ndarray:
    """Cheap pink noise: white noise integrated in the frequency domain (1/f)."""
    rng = np.random.default_rng(seed)
    n = int(sample_rate * seconds)
    white = rng.standard_normal(n)
    spectrum = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    freqs[0] = freqs[1] if len(freqs) > 1 else 1.0
    pink_spectrum = spectrum / np.sqrt(freqs)
    pink = np.fft.irfft(pink_spectrum, n=n)
    pink = pink / (np.max(np.abs(pink)) + 1e-9) * amplitude
    return np.asarray(pink, dtype=np.float32)


def _speech_like_noisy(seconds: float = 6.0, *, noise_kind: str = "white") -> Pcm:
    """A steady tone (speech stand-in) plus noise across the whole clip."""
    speech = _tone(220.0, seconds) + 0.5 * _tone(440.0, seconds, amplitude=0.15)
    noise = _white_noise(seconds) if noise_kind == "white" else _pink_noise(seconds)
    mixed = speech + noise
    return Pcm(samples=mixed.astype(np.float32), sample_rate=SAMPLE_RATE)


class TestSpectralGateDenoise:
    def test_reduces_noise_floor(self) -> None:
        noisy = _speech_like_noisy(noise_kind="white")
        cleaned = spectral_gate_denoise(noisy)
        assert len(cleaned.samples) == len(noisy.samples)

        # Noise floor proxy: 10th percentile short-time RMS.
        def floor_db(samples: np.ndarray) -> float:
            frame = 2048
            n = len(samples) // frame
            trimmed = samples[: n * frame].reshape(n, frame)
            rms = np.sqrt(np.mean(np.square(trimmed, dtype=np.float64), axis=1)) + 1e-12
            return float(20.0 * np.log10(np.quantile(rms, 0.1)))

        assert floor_db(cleaned.samples) < floor_db(noisy.samples)

    def test_preserves_length_on_short_clip(self) -> None:
        short = Pcm(samples=_tone(300.0, 0.05), sample_rate=SAMPLE_RATE)
        cleaned = spectral_gate_denoise(short)
        assert len(cleaned.samples) == len(short.samples)

    def test_empty_input(self) -> None:
        empty = Pcm(samples=np.zeros(0, dtype=np.float32), sample_rate=SAMPLE_RATE)
        assert len(spectral_gate_denoise(empty).samples) == 0


class TestLoudness:
    def test_normalize_hits_target_within_tolerance(self) -> None:
        pcm = Pcm(samples=_tone(220.0, 3.0, amplitude=0.05), sample_rate=SAMPLE_RATE)
        _normalized, achieved = normalize_loudness(pcm, target_lufs=-16.0)
        assert abs(achieved - (-16.0)) <= 1.0

    def test_true_peak_ceiling_respected(self) -> None:
        loud = Pcm(samples=_tone(220.0, 2.0, amplitude=0.95), sample_rate=SAMPLE_RATE)
        normalized, _achieved = normalize_loudness(
            loud, target_lufs=-14.0, true_peak_ceiling_dbtp=-1.0
        )
        assert true_peak_dbtp(normalized.samples) <= -1.0 + 0.2

    def test_louder_signal_measures_louder(self) -> None:
        quiet = Pcm(samples=_tone(220.0, 2.0, amplitude=0.05), sample_rate=SAMPLE_RATE)
        loud = Pcm(samples=_tone(220.0, 2.0, amplitude=0.5), sample_rate=SAMPLE_RATE)
        assert integrated_loudness(loud) > integrated_loudness(quiet)


class TestMix:
    def test_ratio_zero_is_original(self) -> None:
        original = Pcm(samples=_tone(200.0, 1.0), sample_rate=SAMPLE_RATE)
        processed = Pcm(samples=_tone(200.0, 1.0, amplitude=0.01), sample_rate=SAMPLE_RATE)
        blended = mix(original, processed, 0.0)
        np.testing.assert_allclose(blended.samples, original.samples, atol=1e-5)

    def test_ratio_one_is_processed(self) -> None:
        original = Pcm(samples=_tone(200.0, 1.0), sample_rate=SAMPLE_RATE)
        processed = Pcm(samples=_tone(200.0, 1.0, amplitude=0.01), sample_rate=SAMPLE_RATE)
        blended = mix(original, processed, 1.0)
        np.testing.assert_allclose(blended.samples, processed.samples, atol=1e-5)

    @pytest.mark.parametrize("strength", ["light", "medium", "strong"])
    def test_strength_presets_are_defined(self, strength: str) -> None:
        assert 0.0 < STRENGTH_MIX_RATIO[strength] <= 1.0  # type: ignore[index]


class TestCrossfadeConcat:
    def test_no_discontinuity_click_at_boundary(self) -> None:
        """Two chunks of the same continuous tone must join with no > -40 dB click."""
        seconds_each = 3.0
        full = _tone(220.0, seconds_each * 2)
        crossfade_samples = int(SAMPLE_RATE * CHUNK_CROSSFADE_MS / 1000)
        split = int(SAMPLE_RATE * seconds_each) + crossfade_samples
        chunk_a = Pcm(samples=full[:split], sample_rate=SAMPLE_RATE)
        chunk_b = Pcm(samples=full[int(SAMPLE_RATE * seconds_each) :], sample_rate=SAMPLE_RATE)

        joined = crossfade_concat([chunk_a, chunk_b])
        boundary = int(SAMPLE_RATE * seconds_each)
        window = 256
        segment = joined.samples[boundary - window : boundary + window]
        # A discontinuity would show as a large sample-to-sample jump; the
        # continuous tone's own step never exceeds this.
        max_step = float(np.max(np.abs(np.diff(segment.astype(np.float64)))))
        reference_step = float(
            np.max(np.abs(np.diff(full[boundary - window : boundary + window].astype(np.float64))))
        )
        assert max_step <= reference_step * 3 + 1e-3

    def test_single_chunk_passthrough(self) -> None:
        chunk = Pcm(samples=_tone(200.0, 1.0), sample_rate=SAMPLE_RATE)
        joined = crossfade_concat([chunk])
        np.testing.assert_array_equal(joined.samples, chunk.samples)


class TestRunCleanChain:
    def test_snr_gain_medium_strength(self) -> None:
        noisy = _speech_like_noisy(seconds=8.0, noise_kind="white")
        _normalized, metrics = run_clean_chain(
            noisy, strength="medium", target="social", dereverb=False, deesser=False
        )
        assert metrics.snr_gain_db >= 6.0

    def test_loudness_within_tolerance_of_target(self) -> None:
        noisy = _speech_like_noisy(seconds=5.0, noise_kind="pink")
        _normalized, metrics = run_clean_chain(
            noisy, strength="medium", target="youtube", dereverb=False, deesser=False
        )
        assert abs(metrics.output_lufs - TARGET_LUFS["youtube"]) <= 1.0

    def test_true_peak_ceiling(self) -> None:
        noisy = _speech_like_noisy(seconds=5.0, noise_kind="white")
        _normalized, metrics = run_clean_chain(
            noisy, strength="strong", target="podcast", dereverb=True, deesser=True
        )
        assert metrics.true_peak_dbtp <= TRUE_PEAK_CEILING_DBTP + 0.2

    def test_chunked_matches_short_clip_shape(self) -> None:
        """A file longer than one window still returns audio of the same length."""
        from worker_ai.clean.dsp import CHUNK_WINDOW_MS

        seconds = (CHUNK_WINDOW_MS / 1000) * 1.5
        noisy = Pcm(samples=_tone(220.0, seconds) + _white_noise(seconds), sample_rate=SAMPLE_RATE)
        normalized, _metrics = run_clean_chain(
            noisy,
            strength="medium",
            target="social",
            dereverb=False,
            deesser=False,
            window_ms=2000,
            crossfade_ms=200,
        )
        # Crossfading trims a little at internal joins; length stays close.
        assert abs(len(normalized.samples) - len(noisy.samples)) < SAMPLE_RATE

    @slow
    def test_rss_bound_on_a_60_minute_file(self) -> None:
        """Acceptance criterion 5 / the orchestrator addendum: peak RSS while
        cleaning a 60-minute 48 kHz file stays under 2 GB.

        `run_clean_chain`'s own 10-minute denoise windows already bounded the
        `spectral_gate_denoise`/`suppress_reverb`/`deess` STFT passes; what
        this test actually exercises is the fix for the whole-signal passes
        that used to run *after* reassembly regardless of how the denoise
        stage was chunked — `true_peak_dbtp` (the named defect: one
        `len(samples) * 4` `np.interp` allocation, ~5.5 GB at this length
        before B10b) and `integrated_loudness`'s high-pass stage, both now
        windowed (`dsp.py`'s `_MEASURE_WINDOW_SAMPLES`). Marked `slow`
        (`RUN_SLOW=1`) because it processes a full hour of audio and measures
        real process RSS rather than asserting on a mock — not something to
        run on every `pytest -q`.
        """
        import threading
        import time

        import psutil

        seconds = 60 * 60
        # Built from `_tone`/`_white_noise` (no whole-signal FFT in fixture
        # generation itself, unlike `_pink_noise`) so the measurement below is
        # `run_clean_chain`'s own footprint, not the fixture's.
        noisy = Pcm(
            samples=(_tone(220.0, seconds) + _white_noise(seconds)).astype(np.float32),
            sample_rate=SAMPLE_RATE,
        )

        process = psutil.Process(os.getpid())
        gc.collect()
        baseline_rss = process.memory_info().rss

        # `run_clean_chain` is synchronous and CPU-bound, so a same-thread
        # sample after it returns would only see whatever the allocator has
        # not yet released — exactly the peak this test exists to catch. A
        # background poller samples RSS while the chain actually runs.
        peak_rss = baseline_rss
        stop = threading.Event()

        def poll() -> None:
            nonlocal peak_rss
            while not stop.is_set():
                peak_rss = max(peak_rss, process.memory_info().rss)
                time.sleep(0.05)

        poller = threading.Thread(target=poll, daemon=True)
        poller.start()
        try:
            normalized, metrics = run_clean_chain(
                noisy, strength="medium", target="social", dereverb=False, deesser=False
            )
        finally:
            stop.set()
            poller.join(timeout=5)
        peak_rss = max(peak_rss, process.memory_info().rss)
        del normalized
        gc.collect()

        peak_over_baseline = peak_rss - baseline_rss
        assert peak_over_baseline < 2 * 1024 * 1024 * 1024, (
            f"peak RSS over baseline was {peak_over_baseline / (1024 * 1024):.0f} MiB, "
            "expected < 2048 MiB for a 60-minute file"
        )
        assert metrics.true_peak_dbtp <= TRUE_PEAK_CEILING_DBTP + 0.2


def test_clip_count_detects_full_scale_samples() -> None:
    samples = np.array([0.1, 1.0, -1.0, 0.5], dtype=np.float32)
    assert clip_count(samples) == 2
