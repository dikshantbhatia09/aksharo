"""The B10 audio-clean signal chain: denoise -> loudness normalise -> mix.

Pure ``numpy``, CPU-only, deterministic — no model download and no GPU, so it
runs the same on a developer machine, in CI and in the worker image. This is a
**substitute for DeepFilterNet3**, not an integration of it: `09-ai-pipeline.md`
"Audio clean" calls for DeepFilterNet3 denoise with model weights fetched and
checksum-pinned at image build time, and this environment can neither reach the
network to fetch those weights nor commit them to the repo (WP rule: "no
downloads into the repo"). :func:`spectral_gate_denoise` implements the same
seam — STFT in, cleaner STFT out — so swapping in a real DeepFilterNet3 pass
later is a one-function change behind :data:`Denoiser`, and every caller
(chunking, mixing, loudness, metrics) is already correct either way.

Chain, matching the brief:

1. :func:`spectral_gate_denoise` — noise-floor spectral subtraction.
2. :func:`suppress_reverb` — optional, a stronger high-frequency-biased gate used
   as the de-reverb stand-in (early reflections concentrate there).
3. :func:`deess` — optional, dynamic gain reduction in the 5-8 kHz sibilance band.
4. :func:`normalize_loudness` — two-pass gain to a target LUFS with a true-peak
   ceiling.
5. :func:`mix` — blend cleaned and original by the strength preset's ratio.

Loudness is measured with :func:`integrated_loudness`, a simplified ITU-R
BS.1770-shaped measurement (K-weighting's high-pass stage plus the -0.691 dB
shelf constant, RMS over the whole signal) rather than the full standard's
four-stage K-weighting filter and gated block loudness — labelled
approximate LUFS everywhere it appears (metrics JSON included) so nothing
downstream mistakes it for a certified meter.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

import numpy as np
from numpy.typing import NDArray

from worker_ai.audio import Pcm

__all__ = [
    "CHUNK_CROSSFADE_MS",
    "CHUNK_WINDOW_MS",
    "STRENGTH_MIX_RATIO",
    "TARGET_LUFS",
    "TRUE_PEAK_CEILING_DBTP",
    "CleanMetrics",
    "Denoiser",
    "LoudnessTarget",
    "Strength",
    "clip_count",
    "crossfade_concat",
    "deess",
    "integrated_loudness",
    "mix",
    "normalize_loudness",
    "spectral_gate_denoise",
    "suppress_reverb",
    "true_peak_dbtp",
]

LoudnessTarget = Literal["social", "youtube", "podcast"]
Strength = Literal["light", "medium", "strong"]

#: `03-feature-spec.md` F-401 / `09-ai-pipeline.md` Audio clean targets.
TARGET_LUFS: dict[LoudnessTarget, float] = {
    "social": -16.0,
    "youtube": -14.0,
    "podcast": -16.0,
}

#: Ceiling every target shares.
TRUE_PEAK_CEILING_DBTP = -1.0

#: Mix ratio between original and processed audio, brief §1.
STRENGTH_MIX_RATIO: dict[Strength, float] = {
    "light": 0.5,
    "medium": 0.8,
    "strong": 1.0,
}

#: Chunk plan for long files, brief §1: bounds memory for the STFT passes
#: (`spectral_gate_denoise`/`suppress_reverb`/`deess`), each of which needs
#: every frame of its own window in memory at once (the noise floor is a
#: per-bin quantile *across* frames, so a window cannot be sub-chunked
#: further without changing what that estimate means). B10's brief picked
#: 10-minute windows; B10b (orchestrator addendum) measured that a single
#: 10-minute window's frame matrix — `hop=512` at 48 kHz is ~56,000 frames —
#: already allocates several ~900 MB float64/complex128 arrays at once inside
#: `_stft`/`_istft`, which is most of the 2 GB RSS budget before the
#: whole-signal passes (the true-peak/loudness fix below) even run. 1-minute
#: windows keep the same crossfade design at roughly a tenth the per-window
#: array size, so a host under real memory pressure (the condition that
#: surfaced this in the first place) has far more headroom per allocation.
CHUNK_WINDOW_MS = 60 * 1000
CHUNK_CROSSFADE_MS = 1000

#: B10b (orchestrator addendum, after B19's merge run): the *denoise* chunking
#: above bounds `_clean_one_window`'s memory, but `run_clean_chain` still ran
#: `normalize_loudness`/`integrated_loudness` — and, inside it, `true_peak_dbtp`
#: — over the whole reassembled signal. `true_peak_dbtp` oversamples 4x in one
#: `np.interp` allocation, which for a 60-minute 48 kHz file is a
#: 172,800,000-sample array times 4 (`test_chunked_matches_short_clip_shape`
#: reproduces exactly this at a shorter clip length): the single biggest
#: allocation in the whole chain, and the one that actually blew the RSS
#: budget under host memory pressure. Both whole-signal passes below now work
#: in bounded windows of this size, with carry-over at the boundary — a
#: fraction of `CHUNK_WINDOW_MS` so the true-peak oversample factor cannot
#: reproduce the same blow-up at any clip length.
_MEASURE_WINDOW_SAMPLES = 48_000 * 30

_EPS = 1e-12


class Denoiser(Protocol):
    """The seam a real DeepFilterNet3 pass would fill in later."""

    def __call__(self, samples: NDArray[np.float32], sample_rate: int) -> NDArray[np.float32]: ...


@dataclass(frozen=True, slots=True)
class CleanMetrics:
    """What ``metrics JSON`` in the brief means, one clean run's worth."""

    input_lufs: float
    output_lufs: float
    snr_gain_db: float
    clipping_count: int
    true_peak_dbtp: float

    def to_wire(self) -> dict[str, float | int]:
        return {
            "inputLufs": round(self.input_lufs, 2),
            "outputLufs": round(self.output_lufs, 2),
            "snrGainDb": round(self.snr_gain_db, 2),
            "clippingCount": self.clipping_count,
            "truePeakDbtp": round(self.true_peak_dbtp, 2),
        }


def _stft(
    samples: NDArray[np.float64], *, frame: int, hop: int
) -> tuple[NDArray[np.complex128], NDArray[np.float64]]:
    """Framed FFT with a periodic Hann window (COLA at 4x overlap)."""
    window = np.hanning(frame + 1)[:-1].astype(np.float64)
    if len(samples) < frame:
        padded = np.zeros(frame, dtype=np.float64)
        padded[: len(samples)] = samples
        samples = padded
    n_frames = 1 + (len(samples) - frame) // hop
    n_frames = max(n_frames, 1)
    shape = (n_frames, frame)
    strides = (samples.strides[0] * hop, samples.strides[0])
    frames = np.lib.stride_tricks.as_strided(
        samples.astype(np.float64), shape=shape, strides=strides
    )
    spectrum = np.fft.rfft(frames * window, axis=1)
    return spectrum, window


def _istft(
    spectrum: NDArray[np.complex128],
    *,
    frame: int,
    hop: int,
    window: NDArray[np.float64],
    length: int,
) -> NDArray[np.float32]:
    """Overlap-add inverse of :func:`_stft`."""
    frames = np.fft.irfft(spectrum, n=frame, axis=1) * window
    n_frames = frames.shape[0]
    out_len = frame + hop * (n_frames - 1)
    out = np.zeros(out_len, dtype=np.float64)
    norm = np.zeros(out_len, dtype=np.float64)
    for i in range(n_frames):
        start = i * hop
        out[start : start + frame] += frames[i]
        norm[start : start + frame] += window**2
    norm = np.where(norm < _EPS, 1.0, norm)
    out = out / norm
    if len(out) < length:
        out = np.pad(out, (0, length - len(out)))
    return out[:length].astype(np.float32)


def spectral_gate_denoise(
    pcm: Pcm,
    *,
    frame: int = 2048,
    hop: int = 512,
    over_subtraction: float = 2.0,
    floor: float = 0.05,
) -> Pcm:
    """Spectral-subtraction noise gate: the DeepFilterNet3 stand-in.

    The noise magnitude profile per frequency bin is the 10th percentile across
    frames (`worker_ai.vad.EnergyVad` uses the same percentile-floor idea for the
    same reason: it needs no separate "noise-only" region, so it works on any
    clip). Each bin is attenuated toward ``floor`` times its own magnitude once
    it drops within ``over_subtraction`` times the noise floor, which is what
    keeps steady-state hiss down without gating transient speech.
    """
    samples = pcm.samples.astype(np.float64)
    if len(samples) == 0:
        return pcm
    spectrum, window = _stft(samples, frame=frame, hop=hop)
    magnitude = np.abs(spectrum)
    phase = np.angle(spectrum)

    noise_floor = np.quantile(magnitude, 0.1, axis=0, keepdims=True)
    gated = magnitude - over_subtraction * noise_floor
    gated = np.maximum(gated, floor * magnitude)

    cleaned_spectrum: NDArray[np.complex128] = (gated * np.exp(1j * phase)).astype(np.complex128)
    cleaned = _istft(cleaned_spectrum, frame=frame, hop=hop, window=window, length=len(samples))
    return Pcm(samples=cleaned, sample_rate=pcm.sample_rate)


def suppress_reverb(pcm: Pcm, *, frame: int = 2048, hop: int = 512) -> Pcm:
    """De-reverb stand-in: a harder gate weighted toward the band early
    reflections occupy (1-6 kHz), applied on top of an already-denoised signal.
    """
    samples = pcm.samples.astype(np.float64)
    if len(samples) == 0:
        return pcm
    spectrum, window = _stft(samples, frame=frame, hop=hop)
    magnitude = np.abs(spectrum)
    phase = np.angle(spectrum)

    freqs = np.fft.rfftfreq(frame, d=1.0 / pcm.sample_rate)
    band = (freqs >= 1000) & (freqs <= 6000)
    weight = np.where(band, 3.0, 1.2)[None, :]
    noise_floor = np.quantile(magnitude, 0.2, axis=0, keepdims=True)
    gated = magnitude - weight * noise_floor
    gated = np.maximum(gated, 0.08 * magnitude)

    reverb_spectrum: NDArray[np.complex128] = (gated * np.exp(1j * phase)).astype(np.complex128)
    cleaned = _istft(reverb_spectrum, frame=frame, hop=hop, window=window, length=len(samples))
    return Pcm(samples=cleaned, sample_rate=pcm.sample_rate)


def deess(
    pcm: Pcm, *, frame: int = 1024, hop: int = 256, threshold_db: float = -22.0, ratio: float = 3.0
) -> Pcm:
    """Dynamic gain reduction in the 5-8 kHz sibilance band."""
    samples = pcm.samples.astype(np.float64)
    if len(samples) == 0:
        return pcm
    spectrum, window = _stft(samples, frame=frame, hop=hop)
    freqs = np.fft.rfftfreq(frame, d=1.0 / pcm.sample_rate)
    band = (freqs >= 5000) & (freqs <= 8000)

    band_energy = np.sqrt(np.mean(np.abs(spectrum[:, band]) ** 2, axis=1) + _EPS)
    band_db = 20.0 * np.log10(band_energy + _EPS)
    over = np.maximum(band_db - threshold_db, 0.0)
    reduction_db = over * (1.0 - 1.0 / ratio)
    gain = (10.0 ** (-reduction_db / 20.0))[:, None]

    attenuated = spectrum.copy()
    attenuated[:, band] = attenuated[:, band] * gain
    cleaned = _istft(attenuated, frame=frame, hop=hop, window=window, length=len(samples))
    return Pcm(samples=cleaned, sample_rate=pcm.sample_rate)


def _high_pass_biquad_window(
    samples: NDArray[np.float64], sample_rate: int, cutoff_hz: float = 100.0
) -> NDArray[np.float64]:
    """A first-order high-pass, standing in for BS.1770's shelf stage.

    Applied as a frequency-domain magnitude response (one FFT/IFFT over
    ``samples``) rather than the equivalent per-sample IIR recursion — same
    filter, but vectorised: a per-sample Python loop over tens of minutes of
    48 kHz audio would dominate the whole clean chain's runtime. Phase is not
    preserved, which does not matter here because the only thing built on this
    filter is an RMS-based level measurement.

    Bounded to one measurement window (`_MEASURE_WINDOW_SAMPLES`) by
    :func:`integrated_loudness` below, never the whole signal — see that
    function's doc comment for why.
    """
    n = len(samples)
    if n == 0:
        return samples
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    gain = freqs / np.sqrt(freqs**2 + cutoff_hz**2 + _EPS)
    spectrum = np.fft.rfft(samples)
    return np.fft.irfft(spectrum * gain, n=n)


def integrated_loudness(pcm: Pcm, *, window_samples: int = _MEASURE_WINDOW_SAMPLES) -> float:
    """Approximate LUFS: a high-pass stage plus BS.1770's -0.691 dB shelf
    constant over the whole-signal RMS. Not the full four-stage K-weighting
    filter or gated block loudness of the standard — see the module docstring.

    Measured in bounded windows rather than one whole-signal FFT/IFFT pair
    (B10b): `_high_pass_biquad_window`'s `rfft`/`irfft` allocate arrays
    proportional to the whole signal's length, which for a 60-minute 48 kHz
    file is the same order of allocation `true_peak_dbtp` used to make in one
    shot. Windowing the high-pass filter is itself an approximation on top of
    an already-approximate measurement (the module docstring's own framing);
    the sum-of-squares this accumulates window by window is exactly the same
    quantity `np.mean(np.square(filtered))` would have computed over the whole
    signal, so a window boundary changes only the (already-approximate) filter
    response right at that edge, not the aggregate level.
    """
    samples = pcm.samples.astype(np.float64)
    n = len(samples)
    if n == 0:
        return -70.0
    if n <= window_samples:
        filtered = _high_pass_biquad_window(samples, pcm.sample_rate)
        mean_square = float(np.mean(np.square(filtered))) + _EPS
        return -0.691 + float(10.0 * np.log10(mean_square))

    sum_of_squares = 0.0
    count = 0
    start = 0
    while start < n:
        end = min(start + window_samples, n)
        filtered = _high_pass_biquad_window(samples[start:end], pcm.sample_rate)
        sum_of_squares += float(np.sum(np.square(filtered)))
        count += end - start
        start = end
    mean_square = sum_of_squares / count + _EPS
    return -0.691 + float(10.0 * np.log10(mean_square))


def _true_peak_linear_window(window: NDArray[np.float64], *, oversample: int) -> float:
    """Linear peak (not dB) of one window's oversampled interpolation."""
    n = len(window)
    if n == 0:
        return 0.0
    if n == 1:
        return abs(float(window[0]))
    x = np.arange(n, dtype=np.float64)
    xi = np.linspace(0.0, float(n - 1), n * oversample)
    upsampled = np.interp(xi, x, window)
    return float(np.max(np.abs(upsampled)))


def true_peak_dbtp(
    samples: NDArray[np.float32],
    *,
    oversample: int = 4,
    window_samples: int = _MEASURE_WINDOW_SAMPLES,
) -> float:
    """Peak in dBTP, approximated by linear-interpolation oversampling — a cheap
    stand-in for a real polyphase true-peak filter, adequate for a ceiling check.

    FFT-domain zero-stuffing was tried first and rejected: it treats the buffer
    as one period of a periodic signal, so a non-zero jump between the first and
    last sample rings (Gibbs) across the whole reconstruction and can report a
    peak several dB *above* every sample the buffer actually contains. Linear
    interpolation has no such global side effect — inter-sample peaks it misses
    are a real but small underestimate, the opposite failure mode of a hard
    ceiling check.

    Measured in bounded windows (B10b, orchestrator addendum): the oversampled
    `np.interp` call allocates `len(samples) * oversample` float64s in one go —
    for a 60-minute 48 kHz file that is the single largest allocation in the
    whole clean chain, and defeated `run_clean_chain`'s 10-minute denoise
    chunking entirely, since `normalize_loudness` ran this over the whole
    reassembled signal regardless of how it was denoised. Each window carries
    one extra sample of look-ahead across its right edge, so the inter-sample
    peak spanning a window boundary is still caught by the interpolation
    rather than treated as a hard cut; the running peak across windows is
    exactly the same maximum a single whole-signal call would have found.
    """
    n = len(samples)
    if n == 0:
        return -120.0
    if n <= window_samples:
        peak = _true_peak_linear_window(samples.astype(np.float64), oversample=oversample)
        return float(20.0 * np.log10(peak + _EPS))

    # Each window is converted to float64 on its own (never the whole `samples`
    # up front, B10b) — the same whole-signal allocation this function exists
    # to avoid, just moved one line earlier.
    peak = 0.0
    start = 0
    while start < n:
        end = min(start + window_samples, n)
        # +1 sample of look-ahead so the boundary itself is interpolated.
        window = samples[start : min(end + 1, n)].astype(np.float64)
        peak = max(peak, _true_peak_linear_window(window, oversample=oversample))
        start = end
    return float(20.0 * np.log10(peak + _EPS))


def clip_count(samples: NDArray[np.float32], *, threshold: float = 0.999) -> int:
    """Number of samples at or beyond full scale."""
    return int(np.sum(np.abs(samples) >= threshold))


def _soft_limit_peaks(samples: NDArray[np.float64], ceiling_linear: float) -> NDArray[np.float64]:
    """Compress only the samples above ``ceiling_linear``, ``tanh``-shaped.

    A uniform gain reduction (turn the whole signal down until the loudest
    sample fits) would drag average loudness down with it — exactly the wrong
    trade when the loud sample is a single spectral-subtraction artefact
    (`spectral_gate_denoise`'s musical-noise tendency) rather than the
    programme content. Bending only the samples that actually exceed the
    ceiling keeps the measured loudness close to what pass 2's gain intended.
    """
    magnitude = np.abs(samples)
    over = magnitude > ceiling_linear
    if not np.any(over):
        return samples
    limited = samples.copy()
    ratio = magnitude[over] / ceiling_linear
    limited[over] = np.sign(samples[over]) * ceiling_linear * np.tanh(ratio)
    return limited


def normalize_loudness(
    pcm: Pcm,
    *,
    target_lufs: float,
    true_peak_ceiling_dbtp: float = TRUE_PEAK_CEILING_DBTP,
    window_samples: int = _MEASURE_WINDOW_SAMPLES,
) -> tuple[Pcm, float]:
    """Two-pass loudness normalisation: measure, then apply gain plus a peak limiter.

    Pass 1 measures :func:`integrated_loudness`. Pass 2 applies the gain that
    hits ``target_lufs`` exactly and then, only if that gain pushes the true
    peak past the ceiling, runs :func:`_soft_limit_peaks` so it is the outlier
    samples that get pulled down rather than the whole signal's level.

    B10b: pass 2 used to build one whole-signal float64 `candidate` array (the
    gained signal), run `true_peak_dbtp` on a float32 copy of it, optionally
    limit that whole array, then clip and downcast it — up to three
    whole-signal-sized allocations alive together. It now runs in the same
    bounded windows the measurement functions above use: a first windowed pass
    decides whether the limiter is needed at all (no full-length array), and a
    second windowed pass writes the gained-and-optionally-limited result
    straight into the one float32 buffer the caller actually needs.
    """
    measured = integrated_loudness(pcm)
    gain_db = target_lufs - measured
    gain = 10.0 ** (gain_db / 20.0)
    ceiling_linear = 10.0 ** (true_peak_ceiling_dbtp / 20.0)

    samples = pcm.samples
    n = len(samples)

    peak_linear = 0.0
    start = 0
    while start < n:
        end = min(start + window_samples, n)
        # +1 sample of look-ahead, same as `true_peak_dbtp`'s own windows.
        window = samples[start : min(end + 1, n)].astype(np.float64) * gain
        peak_linear = max(peak_linear, _true_peak_linear_window(window, oversample=4))
        start = end
    needs_limiting = float(20.0 * np.log10(peak_linear + _EPS)) > true_peak_ceiling_dbtp

    output = np.empty(n, dtype=np.float32)
    start = 0
    while start < n:
        end = min(start + window_samples, n)
        chunk = samples[start:end].astype(np.float64) * gain
        if needs_limiting:
            chunk = _soft_limit_peaks(chunk, ceiling_linear)
        output[start:end] = np.clip(chunk, -1.0, 1.0).astype(np.float32)
        start = end

    result = Pcm(samples=output, sample_rate=pcm.sample_rate)
    return result, integrated_loudness(result)


def mix(original: Pcm, processed: Pcm, ratio: float) -> Pcm:
    """Blend ``processed`` over ``original`` by ``ratio`` (0 = original, 1 = fully processed)."""
    ratio = float(np.clip(ratio, 0.0, 1.0))
    length = min(len(original.samples), len(processed.samples))
    blended = ratio * processed.samples[:length].astype(np.float64) + (
        1.0 - ratio
    ) * original.samples[:length].astype(np.float64)
    return Pcm(
        samples=np.clip(blended, -1.0, 1.0).astype(np.float32), sample_rate=processed.sample_rate
    )


def crossfade_concat(chunks: list[Pcm], *, crossfade_ms: int = CHUNK_CROSSFADE_MS) -> Pcm:
    """Join processed chunks with an equal-power crossfade at each boundary.

    Each chunk was cut with :data:`CHUNK_CROSSFADE_MS` of extra audio at its
    tail (the caller's job); this only blends that overlap back down to one
    continuous stream so no click lands at a chunk boundary.

    Blends in **float32** (B10b): each iteration below reallocates the whole
    growing `out` array (`np.concatenate` cannot grow in place), so a run over
    many chunks briefly holds both the old and the new copy of everything
    joined so far — in float64 that peak was itself a fraction of the whole
    signal's size for every chunk after the first, on top of every other
    whole-signal array `run_clean_chain` builds. The crossfade maths (a cosine/
    sine power blend over `crossfade_samples`, typically ~48,000 of them) loses
    nothing perceptible at float32 precision; only the boundary math briefly
    upconverts, not the untouched `head`/`tail` slices.
    """
    if not chunks:
        return Pcm(samples=np.zeros(0, dtype=np.float32), sample_rate=48_000)
    if len(chunks) == 1:
        return chunks[0]

    sample_rate = chunks[0].sample_rate
    fade_samples = int(sample_rate * crossfade_ms / 1000)
    out = chunks[0].samples
    for chunk in chunks[1:]:
        nxt = chunk.samples
        fade = min(fade_samples, len(out), len(nxt))
        if fade <= 0:
            out = np.concatenate([out, nxt])
            continue
        t = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        fade_out = np.cos(t * np.pi / 2.0).astype(np.float32)
        fade_in = np.sin(t * np.pi / 2.0).astype(np.float32)
        head = out[:-fade]
        blended = (out[-fade:] * fade_out + nxt[:fade] * fade_in).astype(np.float32)
        tail = nxt[fade:]
        out = np.concatenate([head, blended, tail])
    return Pcm(samples=out.astype(np.float32, copy=False), sample_rate=sample_rate)
