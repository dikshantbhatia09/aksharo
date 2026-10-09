"""Automated Test Suite: Acoustic Energy, Pitch Spike & Emotion Detection Engine (Pillar 2 §07).

Validates:
1. Step 1 — Lightweight Acoustic Feature Extractor (`acoustic.py`):
   - Frame-level RMS loudness (100ms frames), dBFS profile, and >15 dB peak spike detection.
   - Zero-crossing rate (ZCR) and speech rate acceleration.
   - Fast YIN / FFT autocorrelation pitch tracking (F0):
     * Monotone speeches: sigma_F0 <= 18 Hz (and < 15 Hz penalty threshold).
     * Dynamic emotional speech: sigma_F0 >= 45 Hz.
2. Step 2 — ONNX YAMNet & Spectral Audio Event Detector (0.96s sliding spectrograms):
   - 0.96-second (96x64 log-mel) sliding spectrogram extraction with 0.48s hop.
   - Class 16 (`Laughter`), Class 17 (`Giggly laughter`), and Class 23 (`Applause`) probabilities.
   - `YamnetOnnxDetector` session execution and graceful fallback via `load_yamnet_detector`.
3. Step 3 — Virality Scoring Integration (`scoring.py` & `highlights.py`):
   - Awards up to +20 points for high pitch variance (>= 40 Hz) and confirmed laughter.
   - Penalizes monotone windows (sigma_F0 < 15 Hz) with flat dynamics.
   - Distinguishes emotional confession vs monotone corporate report on identical transcript text
     ("We lost everything in that crash").
   - End-to-end `discover()` integration with 16kHz PCM audio and `AcousticEmotionAggregator`.
4. Step 4 & Performance SLAs:
   - Standup comedy vs monotone lecture audio clips verifying laughter duration and pitch variance.
   - High-stakes keynote highlight with audience applause (Class 23).
   - Laughter detection precision >= 96.0% across labeled multi-clip benchmark.
   - Audio acoustic feature extraction speed >= 25x realtime on CPU.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from numpy.typing import NDArray

from worker_ai.audio import TARGET_SAMPLE_RATE, Pcm, write_wav
from worker_ai.highlights.acoustic import (
    HIGH_VARIANCE_PITCH_STD_HZ,
    MONOTONE_PITCH_STD_HZ,
    OPUS_DYNAMIC_STD_HZ,
    OPUS_MONOTONE_STD_HZ,
    SPIKE_THRESHOLD_DB,
    YAMNET_CLASS_APPLAUSE,
    YAMNET_CLASS_GIGGLY_LAUGHTER,
    YAMNET_CLASS_LAUGHTER,
    YAMNET_MEL_BINS,
    YAMNET_NUM_CLASSES,
    YAMNET_PATCH_FRAMES,
    AcousticFeatures,
    SpectralYamnetDetector,
    WindowAcousticFeatures,
    YamnetOnnxDetector,
    analyze_pcm_window,
    analyze_wav_window,
    compute_rms_dbfs_profile,
    compute_speech_rate_acceleration,
    compute_zero_crossing_rate,
    extract_pitch_track_yin,
    extract_window_acoustic_features,
    extract_yamnet_patches,
    load_yamnet_detector,
)
from worker_ai.highlights.contracts import HighlightsOptions
from worker_ai.highlights.scoring import (
    WordFeatures,
    acoustic_energy_and_penalty,
    reasons_for,
    score,
    virality_index,
)
from worker_ai.highlights.windows import Word, build_units
from worker_ai.processors.highlights import discover

# ---------------------------------------------------------------------------
# Synthetic 16kHz Audio Generators (Standup Comedy, Monotone Lecture, Keynote)
# ---------------------------------------------------------------------------


def _synthesize_harmonic_voice(
    f0_profile_hz: NDArray[np.float64],
    envelope: NDArray[np.float64],
    sample_rate: int = TARGET_SAMPLE_RATE,
) -> NDArray[np.float32]:
    """Generate multi-harmonic voiced speech/laughter from instantaneous F0 and envelope."""
    phase = 2.0 * np.pi * np.cumsum(f0_profile_hz) / sample_rate
    # Fundamental + 2nd, 3rd, 4th vocalic harmonics within [150 Hz, 2400 Hz]
    signal = (
        1.00 * np.sin(phase)
        + 0.55 * np.sin(2.0 * phase)
        + 0.30 * np.sin(3.0 * phase)
        + 0.15 * np.sin(4.0 * phase)
    )
    signal = signal / 1.65
    return (signal * envelope).astype(np.float32)


def make_monotone_lecture_audio(
    duration_sec: float = 6.0,
    sample_rate: int = TARGET_SAMPLE_RATE,
    base_f0_hz: float = 125.0,
) -> NDArray[np.float32]:
    """Generate a monotone lecture audio clip: flat pitch (~4 Hz std dev) and flat volume."""
    n = int(duration_sec * sample_rate)
    t = np.linspace(0.0, duration_sec, n, endpoint=False)
    # Very small pitch drift (+/- 5 Hz -> std dev ~ 3.5 Hz, well below 15 Hz)
    f0 = base_f0_hz + 5.0 * np.sin(2.0 * np.pi * 0.8 * t)
    # Steady flat amplitude with mild 2 Hz syllable undulation
    envelope = 0.12 * (0.90 + 0.10 * np.sin(2.0 * np.pi * 2.0 * t))
    return _synthesize_harmonic_voice(f0, envelope, sample_rate)


def make_standup_comedy_audio(
    duration_sec: float = 6.0,
    sample_rate: int = TARGET_SAMPLE_RATE,
    laughter_start_sec: float = 2.0,
    laughter_end_sec: float = 5.5,
    burst_rate_hz: float = 5.8,
) -> NDArray[np.float32]:
    """Generate a standup comedy clip: animated setup + contagious host/guest laughter burst.

    - Setup (0..laughter_start_sec): animated pitch sweeping 115-275 Hz (sigma_F0 >= 45 Hz).
    - Punchline & Laughter (laughter_start_sec..laughter_end_sec): 5.8 Hz rhythmic staccato
      vocalic "ha-ha-ha" bursts with >15 dB peak explosion above baseline.
    """
    n = int(duration_sec * sample_rate)
    t = np.linspace(0.0, duration_sec, n, endpoint=False)

    # Expressive pitch contour sweeping between 110 Hz and 280 Hz (sigma_F0 >= 50 Hz)
    f0 = 185.0 + 75.0 * np.sin(2.0 * np.pi * 1.3 * t) + 25.0 * np.cos(2.0 * np.pi * 2.7 * t)

    # Baseline animated speech envelope (0.045 RMS)
    envelope = np.full(n, 0.045, dtype=np.float64)

    # Laughter region: rhythmic 5.8 Hz vocalic bursts ("ha-ha-ha-ha") with deep inter-burst troughs
    # and high-energy amplitude explosion (0.68 peak -> >16 dB 100ms RMS spike above 0.045 baseline)
    laugh_mask = (t >= laughter_start_sec) & (t < laughter_end_sec)
    t_laugh = t[laugh_mask] - laughter_start_sec
    burst_wave = np.maximum(0.0, np.sin(2.0 * np.pi * burst_rate_hz * t_laugh)) ** 2.0
    envelope[laugh_mask] = 0.015 + 0.68 * burst_wave
    f0[laugh_mask] = 235.0 + 55.0 * np.sin(2.0 * np.pi * burst_rate_hz * t_laugh)

    return _synthesize_harmonic_voice(f0, envelope, sample_rate)


def make_keynote_applause_audio(
    duration_sec: float = 6.0,
    sample_rate: int = TARGET_SAMPLE_RATE,
    applause_start_sec: float = 2.5,
    seed: int = 42,
) -> NDArray[np.float32]:
    """Generate a high-stakes keynote clip: speech projection followed by thunderous applause."""
    rng = np.random.default_rng(seed)
    n = int(duration_sec * sample_rate)
    t = np.linspace(0.0, duration_sec, n, endpoint=False)

    # Dramatic vocal projection in first 2.5s (high pitch modulation)
    f0 = 175.0 + 68.0 * np.sin(2.0 * np.pi * 1.4 * t)
    env = np.where(t < applause_start_sec, 0.08 + 0.04 * np.sin(2.0 * np.pi * 2.5 * t), 0.0)
    speech = _synthesize_harmonic_voice(f0, env, sample_rate)

    # Thunderous audience applause from applause_start_sec..duration_sec:
    # Broadband high-frequency stochastic clapping transients
    noise = rng.standard_normal(n)
    # High-pass / band-emphasis via first-order difference to mimic crisp handclaps (1-7 kHz)
    claps = np.empty_like(noise)
    claps[0] = noise[0]
    claps[1:] = noise[1:] - 0.65 * noise[:-1]
    claps = claps / (np.std(claps) + 1e-9)

    applause_env = np.where(t >= applause_start_sec, 0.38, 0.0)
    applause = (claps * applause_env).astype(np.float32)

    mixed: NDArray[np.float32] = np.asarray(
        np.clip(speech + applause, -1.0, 1.0), dtype=np.float32
    )
    return mixed


def make_words_for_sentence(text: str, duration_ms: int = 6_000) -> list[Word]:
    tokens = text.split()
    step = max(120, duration_ms // max(1, len(tokens)))
    words: list[Word] = []
    clock = 0
    for i, tok in enumerate(tokens):
        words.append(
            Word(wid=f"w{i + 1:03d}", text=tok, start_ms=clock, end_ms=clock + int(step * 0.85))
        )
        clock += step
    return words


# ---------------------------------------------------------------------------
# Step 1 & Step 4 Tests: Standup Comedy vs Monotone Lecture & Keynote Applause
# ---------------------------------------------------------------------------


def test_standup_comedy_vs_monotone_lecture_acoustic_metrics() -> None:
    """Step 4: Standup comedy clip shows high pitch variance (>=45 Hz), >15 dB spike, and laughter;
    monotone lecture shows low pitch variance (<=18 Hz), flat dynamics, and zero laughter."""
    comedy_pcm = make_standup_comedy_audio(
        duration_sec=6.0, laughter_start_sec=1.5, laughter_end_sec=5.5
    )
    lecture_pcm = make_monotone_lecture_audio(duration_sec=6.0)

    comedy_feat = extract_window_acoustic_features(comedy_pcm, TARGET_SAMPLE_RATE, 0, 6_000)
    lecture_feat = extract_window_acoustic_features(lecture_pcm, TARGET_SAMPLE_RATE, 0, 6_000)

    # 1. Pitch variance (Opus Clip thresholds: monotone <= 18 Hz, dynamic >= 45 Hz)
    assert lecture_feat.pitch_std_dev_hz <= OPUS_MONOTONE_STD_HZ
    assert lecture_feat.pitch_std_dev_hz < MONOTONE_PITCH_STD_HZ
    assert comedy_feat.pitch_std_dev_hz >= OPUS_DYNAMIC_STD_HZ
    assert comedy_feat.pitch_range_hz > lecture_feat.pitch_range_hz * 4.0

    # 2. Loudness spike (Spikes Studio > 15 dB explosion above baseline)
    assert comedy_feat.rms_max_spike_db >= SPIKE_THRESHOLD_DB
    assert lecture_feat.rms_max_spike_db < 4.0

    # 3. Laughter duration & probability
    assert comedy_feat.laughter_duration_sec >= 2.0
    assert comedy_feat.laughter_probability >= 0.70
    assert lecture_feat.laughter_duration_sec == 0.0
    assert lecture_feat.laughter_probability < 0.10


def test_keynote_applause_detection_and_projection(tmp_path: Path) -> None:
    """User Story 2: Keynote clip with thunderous applause sets applause_detected=True."""
    keynote_pcm = make_keynote_applause_audio(duration_sec=6.0, applause_start_sec=2.0)
    wav_path = write_wav(
        tmp_path / "keynote.wav", Pcm(samples=keynote_pcm, sample_rate=TARGET_SAMPLE_RATE)
    )

    feat = analyze_wav_window(wav_path, start_ms=0, end_ms=6_000)
    assert isinstance(feat, WindowAcousticFeatures)
    assert feat.applause_detected is True
    assert feat.applause_probability >= 0.60
    assert feat.pitch_std_dev_hz >= HIGH_VARIANCE_PITCH_STD_HZ
    assert feat.zcr_mean > 0.08


# ---------------------------------------------------------------------------
# Step 2 Tests: ONNX YAMNet Laughter Detector & 0.96s Sliding Spectrograms
# ---------------------------------------------------------------------------


class _FakeYamnetOnnxSession:
    """Stub ONNX session verifying 0.96s (N, 96, 64) spectrogram feed and 521-class output."""

    def __init__(
        self, c16_laugh: float = 0.88, c17_giggle: float = 0.76, c23_applause: float = 0.05
    ) -> None:
        self.calls: list[dict[str, Any]] = []
        self.c16 = c16_laugh
        self.c17 = c17_giggle
        self.c23 = c23_applause

    def run(self, output_names: list[str] | None, input_feed: dict[str, Any]) -> list[Any]:
        self.calls.append(input_feed)
        patches = next(iter(input_feed.values()))
        num_patches = patches.shape[0]
        out = np.zeros((num_patches, YAMNET_NUM_CLASSES), dtype=np.float32)
        out[:, YAMNET_CLASS_LAUGHTER] = self.c16
        out[:, YAMNET_CLASS_GIGGLY_LAUGHTER] = self.c17
        out[:, YAMNET_CLASS_APPLAUSE] = self.c23
        return [out]


def test_yamnet_096s_spectrogram_patch_dimensions() -> None:
    """Step 2: 0.96-second sliding spectrograms have shape (N, 96, 64) with 0.48s hop."""
    samples = make_standup_comedy_audio(duration_sec=3.0)
    log_patches, lin_patches = extract_yamnet_patches(samples, TARGET_SAMPLE_RATE)

    assert log_patches.ndim == 3
    assert log_patches.shape[1] == YAMNET_PATCH_FRAMES  # 96 frames (0.96s)
    assert log_patches.shape[2] == YAMNET_MEL_BINS  # 64 Mel bins
    assert lin_patches.shape == log_patches.shape
    # For 3.0s audio with 0.96s window and 0.48s hop: starts at 0.0, 0.48, 0.96, 1.44, 1.92 -> 5
    assert log_patches.shape[0] == 5


def test_onnx_yamnet_detector_extracts_class_16_17_23() -> None:
    """Step 2: YamnetOnnxDetector runs inference over 0.96s spectrograms for Classes 16, 17, 23."""
    fake_session = _FakeYamnetOnnxSession(c16_laugh=0.91, c17_giggle=0.82, c23_applause=0.65)
    detector = YamnetOnnxDetector(fake_session, model_path="yamnet.onnx")

    samples = make_standup_comedy_audio(duration_sec=3.0)
    res = detector.classify(samples, TARGET_SAMPLE_RATE, window_offset_ms=1_000)

    assert len(fake_session.calls) == 1
    fed_tensor = fake_session.calls[0]["input"]
    assert fed_tensor.shape == (5, 96, 64)

    assert res.laughter_probability >= 0.91
    assert res.giggly_laughter_probability == pytest.approx(0.82, abs=1e-3)
    assert res.applause_probability == pytest.approx(0.65, abs=1e-3)
    assert res.applause_detected is True
    assert res.laughter_duration_sec >= 2.0
    labels = {ev.label for ev in res.events}
    assert {"Laughter", "Giggly laughter", "Applause"} <= labels


def test_load_yamnet_detector_fallback_on_missing_or_corrupt_onnx(tmp_path: Path) -> None:
    """load_yamnet_detector falls back to SpectralYamnetDetector when file is missing or invalid."""
    # Missing file
    det_missing = load_yamnet_detector(str(tmp_path / "does_not_exist.onnx"))
    assert isinstance(det_missing, SpectralYamnetDetector)

    # Corrupt ONNX file
    bad_onnx = tmp_path / "corrupt_yamnet.onnx"
    bad_onnx.write_bytes(b"not a valid protobuf onnx graph")
    det_corrupt = load_yamnet_detector(str(bad_onnx))
    assert isinstance(det_corrupt, SpectralYamnetDetector)


# ---------------------------------------------------------------------------
# Step 3 Tests: Virality Scoring Multiplier (+20 pts) & Monotone Penalty
# ---------------------------------------------------------------------------


def test_scoring_awards_up_to_20_points_for_high_pitch_variance_and_laughter() -> None:
    """Step 3: High pitch variance (>= 40 Hz) and confirmed laughter award +20 S_energy points;
    monotone windows (< 15 Hz) with flat dynamics are penalized."""
    # Identical lexical sentence from §1 of the specification:
    # "We lost everything in that crash"
    sentence = (
        "We lost everything in that crash and nobody in the company "
        "knew how we would survive the night."
    )
    words = make_words_for_sentence(sentence, duration_ms=6_000)
    units = build_units(words, min_ms=3_000, max_ms=30_000)
    wf = WordFeatures(words, units)
    signals = wf.signals(0, len(words) - 1, words[0].start_ms, words[-1].end_ms)

    # 1. Gripping emotional confession / comedy delivery (sigma_F0 = 48 Hz, confirmed laughter)
    emotional_window_ac = WindowAcousticFeatures(
        rms_mean=0.18,
        rms_max_spike_db=17.5,
        pitch_std_dev_hz=48.0,
        pitch_range_hz=165.0,
        laughter_duration_sec=2.4,
        applause_detected=True,
        laughter_probability=0.92,
        applause_probability=0.75,
    )
    s_energy_high, penalty_high = acoustic_energy_and_penalty(emotional_window_ac)
    assert s_energy_high == 20.0
    assert penalty_high == 0.0

    # 2. Monotone corporate report (sigma_F0 = 8 Hz < 15 Hz, flat dynamics)
    monotone_window_ac = WindowAcousticFeatures(
        rms_mean=0.08,
        rms_max_spike_db=1.2,
        pitch_std_dev_hz=8.0,
        pitch_range_hz=16.0,
        laughter_duration_sec=0.0,
        applause_detected=False,
        laughter_probability=0.0,
    )
    s_energy_mono, penalty_mono = acoustic_energy_and_penalty(monotone_window_ac)
    assert s_energy_mono < 2.0
    assert penalty_mono >= 5.0

    # Compare full ViralityBreakdown and Score on the exact same words!
    v_emotional = virality_index(signals, acoustic=emotional_window_ac)
    v_monotone = virality_index(signals, acoustic=monotone_window_ac)

    assert v_emotional.energy == 20.0
    assert v_emotional.total - v_monotone.total >= 20

    sc_emotional = score(signals, goal="reach", acoustic=emotional_window_ac)
    sc_monotone = score(signals, goal="reach", acoustic=monotone_window_ac)
    assert sc_emotional.emotion > sc_monotone.emotion + 0.50
    assert sc_emotional.potential > sc_monotone.potential + 0.15

    # Verify explainable reasons include laughter / emotional inflection
    reasons = reasons_for(signals, sc_emotional, [], acoustic=emotional_window_ac)
    emotion_reasons = [r for r in reasons if r.label == "emotion"]
    assert len(emotion_reasons) >= 1
    assert "laughter" in emotion_reasons[0].explanation.lower()


def test_discover_ranks_laughter_clip_above_monotone_clip_with_pcm_audio() -> None:
    """End-to-end integration: discover() with PCM audio ranks the standup laughter window first."""
    # Two disjoint windows with identical neutral text:
    # Window 1 (0..18s) is monotone lecture; Window 2 (45..63s) has standup laughter
    words: list[dict[str, Any]] = []
    sentence_a = (
        "we walked into the studio this morning and sat down "
        "around the microphone to record the show."
    )
    sentence_b = (
        "everyone at the table looked at the screen and could not "
        "believe what happened in that moment."
    )
    wid = 1
    clock = 0
    for s in (sentence_a, sentence_b):
        for tok in s.split():
            words.append(
                {"wid": f"w{wid:04d}", "text": tok, "startMs": clock, "endMs": clock + 420}
            )
            wid += 1
            clock += 480
        clock += 600

    first_section_end_ms = clock
    second_section_start_ms = 45_000
    clock = second_section_start_ms
    for s in (sentence_a, sentence_b):
        for tok in s.split():
            words.append(
                {"wid": f"w{wid:04d}", "text": tok, "startMs": clock, "endMs": clock + 420}
            )
            wid += 1
            clock += 480
        clock += 600
    total_ms = clock + 1_000

    # Construct 16kHz PCM audio: 0..45s is monotone lecture; 45s..total_ms is standup with laughter
    mono_samples = make_monotone_lecture_audio(duration_sec=second_section_start_ms / 1000.0)
    comedy_samples = make_standup_comedy_audio(
        duration_sec=(total_ms - second_section_start_ms) / 1000.0,
        laughter_start_sec=2.0,
        laughter_end_sec=12.0,
    )
    full_samples = np.concatenate([mono_samples, comedy_samples])
    pcm = Pcm(samples=full_samples, sample_rate=TARGET_SAMPLE_RATE)

    opts = HighlightsOptions.model_validate(
        {
            "count": 2,
            "minDurationMs": 10_000,
            "maxDurationMs": 20_000,
            "contentGoal": "reach",
            "language": "en",
        }
    )
    proposals, _ = discover(words, opts, duration_ms=total_ms, pcm=pcm)
    assert len(proposals) == 2
    # The top-ranked proposal (proposals[0]) must be the second window (>= 45,000 ms) with laughter!
    assert proposals[0].start_ms >= second_section_start_ms
    assert proposals[0].potential_score > proposals[1].potential_score
    assert first_section_end_ms < 20_000


# ---------------------------------------------------------------------------
# Key Performance SLAs: >= 96% Laughter Precision & >= 25x Realtime Speed
# ---------------------------------------------------------------------------


def test_laughter_detection_precision_sla_above_96_percent() -> None:
    """SLA: Laughter detection precision must be >= 96.0% across positive and negative clips."""
    detector = SpectralYamnetDetector()

    # 25 positive laughter clips (varied burst rates 4.5..7.5 Hz and pitch contours)
    positive_clips = [
        make_standup_comedy_audio(
            duration_sec=3.0,
            laughter_start_sec=0.3,
            laughter_end_sec=2.8,
            burst_rate_hz=4.6 + (i % 6) * 0.45,
        )
        for i in range(25)
    ]

    # 25 negative non-laughter clips (monotone lectures, applause, silence, steady tones)
    negative_clips: list[NDArray[np.float32]] = []
    for i in range(15):
        negative_clips.append(
            make_monotone_lecture_audio(duration_sec=3.0, base_f0_hz=110.0 + i * 6.0)
        )
    for i in range(10):
        negative_clips.append(
            make_keynote_applause_audio(duration_sec=3.0, applause_start_sec=0.2, seed=100 + i)
        )

    true_positives = 0
    false_positives = 0

    for clip_pcm in positive_clips:
        res = detector.classify(clip_pcm, TARGET_SAMPLE_RATE)
        if res.laughter_probability >= 0.50:
            true_positives += 1

    for clip_pcm in negative_clips:
        res = detector.classify(clip_pcm, TARGET_SAMPLE_RATE)
        if res.laughter_probability >= 0.50:
            false_positives += 1

    precision = true_positives / max(1, true_positives + false_positives)
    recall = true_positives / len(positive_clips)

    assert precision >= 0.96, f"Laughter precision {precision:.3f} fell below 96.0% SLA"
    assert recall >= 0.96, f"Laughter recall {recall:.3f} fell below 96.0%"


def test_acoustic_extraction_speed_sla_at_least_25x_realtime_on_cpu() -> None:
    """SLA: Audio acoustic feature extraction speed must be >= 25x realtime on CPU."""
    audio_duration_sec = 30.0
    samples = make_standup_comedy_audio(
        duration_sec=audio_duration_sec,
        laughter_start_sec=10.0,
        laughter_end_sec=22.0,
    )

    t0 = time.perf_counter()
    feat = extract_window_acoustic_features(
        samples,
        TARGET_SAMPLE_RATE,
        start_ms=0,
        end_ms=int(audio_duration_sec * 1000),
    )
    elapsed_sec = max(1e-6, time.perf_counter() - t0)
    realtime_factor = audio_duration_sec / elapsed_sec

    assert feat.laughter_duration_sec > 0.0
    assert realtime_factor >= 25.0, (
        f"Acoustic extraction speed {realtime_factor:.1f}x realtime is below 25x SLA "
        f"(took {elapsed_sec:.3f}s for {audio_duration_sec}s audio)"
    )


def test_edge_cases_empty_and_short_windows() -> None:
    """Edge cases: empty array, invalid bounds, and sub-400ms slices return safe defaults."""
    empty = np.zeros(0, dtype=np.float32)
    w_empty = extract_window_acoustic_features(empty, TARGET_SAMPLE_RATE, 0, 1000)
    assert w_empty.rms_mean == 0.0
    assert w_empty.laughter_duration_sec == 0.0
    assert w_empty.applause_detected is False

    short = np.zeros(1600, dtype=np.float32)  # 100ms
    ac_short = analyze_pcm_window(short, TARGET_SAMPLE_RATE, 0, 100)
    assert ac_short == AcousticFeatures()

    rms_m, spike_db, _, _, _ = compute_rms_dbfs_profile(empty, TARGET_SAMPLE_RATE)
    assert rms_m == 0.0
    assert spike_db == 0.0

    zcr_m, _ = compute_zero_crossing_rate(empty, TARGET_SAMPLE_RATE)
    assert zcr_m == 0.0

    p_std, p_rng, _ = extract_pitch_track_yin(empty, TARGET_SAMPLE_RATE)
    assert p_std == 0.0
    assert p_rng == 0.0

    accel = compute_speech_rate_acceleration(empty, TARGET_SAMPLE_RATE)
    assert accel == 0.0
