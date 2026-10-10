"""Unit and SLA verification tests for Silence Trimming Engine (Pillar 5, Functionality 03).

Verifies:
1. Long pause compression down to natural 0.25s breathing interval (0.12s decay + 0.13s onset).
2. Preservation of short pauses (< threshold).
3. 0.0% speech syllable clipping rate (safe lead-in/lead-out margins >= 80ms).
4. Subtitle synchronization: word timestamp adjustment shifts subsequent words forward by trimmed delta.
5. Acoustic energy tracking at -38 dBFS with synthetic PCM.
6. Full end-to-end silence trimming pipeline execution.
"""

from __future__ import annotations

import numpy as np
import pytest

from worker_ai.passes.autocut import Word
from worker_ai.processors.silence_trimmer import (
    DEFAULT_ACOUSTIC_ENERGY_THRESHOLD_DBFS,
    DEFAULT_SILENCE_THRESHOLD_MS,
    DEFAULT_SPEECH_ONSET_MS,
    DEFAULT_TARGET_BREATH_MS,
    DEFAULT_WORD_DECAY_MS,
    SilenceInterval,
    SilenceTrimmerConfig,
    TrimCut,
    adjust_word_timestamps,
    calculate_frame_energy_dbfs,
    compress_energy_silences,
    compress_silence_interval,
    detect_and_compress_silences,
    detect_energy_silence_gaps,
    extract_word_silence_intervals,
    run_silence_trimming_pipeline,
    verify_speech_boundaries,
)


def _make_word(wid: str, s: int, e: int, t: str) -> Word:
    return Word(wid=wid, s=s, e=e, t=t)


class TestPauseCompression:
    def test_compress_long_pause_to_exact_breathing_interval(self) -> None:
        """A 2.0s pause between words is compressed to exactly 0.25s (250ms)."""
        w1 = _make_word("0:0", 1_000, 1_500, "hello")
        w2 = _make_word("0:1", 3_500, 4_000, "world")  # 2000ms pause (1500 to 3500)

        interval = SilenceInterval(
            start_ms=w1.e,
            end_ms=w2.s,
            prev_word_id=w1.wid,
            next_word_id=w2.wid,
        )

        cut = compress_silence_interval(
            interval,
            threshold_ms=400,
            word_decay_ms=120,
            speech_onset_ms=130,
        )

        assert cut is not None
        assert cut.reason == "pause"
        # Kept 120ms after w1: cut starts at 1500 + 120 = 1620
        assert cut.start_ms == 1_620
        # Kept 130ms before w2: cut ends at 3500 - 130 = 3370
        assert cut.end_ms == 3_370
        # Trimmed duration: 3370 - 1620 = 1750ms
        assert cut.duration_ms == 1_750

        # Remaining pause: total gap (2000) - trimmed (1750) = 250ms (0.25s)
        remaining_pause = interval.duration_ms - cut.duration_ms
        assert remaining_pause == DEFAULT_TARGET_BREATH_MS
        assert remaining_pause == 250

    def test_short_pause_below_threshold_is_preserved(self) -> None:
        """A natural 300ms pause below 400ms threshold is preserved without cuts."""
        interval = SilenceInterval(start_ms=1_000, end_ms=1_300)
        cut = compress_silence_interval(interval, threshold_ms=400)
        assert cut is None

    def test_lead_in_and_trailing_silence_compression(self) -> None:
        """Lead-in and trailing dead-air intervals are pruned safely."""
        w1 = _make_word("0:0", 1_000, 1_500, "start")
        words = [w1]
        duration_ms = 4_000

        # Lead-in is 1000ms (0 to 1000): should cut 0 to 1000 - 130 = 870
        # Trailing is 2500ms (1500 to 4000): should cut 1500 + 120 = 1620 to 4000
        cuts = detect_and_compress_silences(
            words,
            duration_ms=duration_ms,
            threshold_ms=400,
            word_decay_ms=120,
            speech_onset_ms=130,
        )

        assert len(cuts) == 2
        lead_cut, trail_cut = cuts[0], cuts[1]

        assert lead_cut.start_ms == 0
        assert lead_cut.end_ms == 870
        assert lead_cut.reason == "silence"

        assert trail_cut.start_ms == 1_620
        assert trail_cut.end_ms == 4_000
        assert trail_cut.reason == "silence"


class TestSyllableProtectionSLA:
    def test_zero_syllable_clipping_rate_enforced(self) -> None:
        """Verify SLA: 0.0% syllable clipping rate with safe margins >= 80ms."""
        words = [
            _make_word("0:0", 100, 400, "The"),
            _make_word("0:1", 2_000, 2_400, "audio"),
            _make_word("0:2", 4_500, 4_900, "stream"),
        ]
        duration_ms = 6_000

        cuts = detect_and_compress_silences(
            words,
            duration_ms=duration_ms,
            threshold_ms=400,
            word_decay_ms=120,
            speech_onset_ms=130,
        )

        # Boundaries have 120ms lead and 130ms trail (> 80ms SLA requirement)
        assert verify_speech_boundaries(words, cuts, min_lead_margin_ms=80, min_trail_margin_ms=80)
        assert verify_speech_boundaries(words, cuts, min_lead_margin_ms=120, min_trail_margin_ms=130)

    def test_boundary_verifier_rejects_violating_cuts(self) -> None:
        """Verifier flags cuts that intrude on phoneme decay/onset buffers."""
        words = [_make_word("0:0", 500, 1_000, "test")]

        # Cut overlaps word
        bad_cut1 = TrimCut(start_ms=900, end_ms=1_500)
        assert not verify_speech_boundaries(words, [bad_cut1], min_lead_margin_ms=80)

        # Cut violates 80ms lead margin (only 50ms after word)
        bad_cut2 = TrimCut(start_ms=1_050, end_ms=1_500)
        assert not verify_speech_boundaries(words, [bad_cut2], min_lead_margin_ms=80)


class TestTimestampSynchronization:
    def test_adjust_word_timestamps_shifts_subsequent_words(self) -> None:
        """Post-compression word timestamps shift so subtitle animations stay synchronized."""
        words = [
            _make_word("0:0", 100, 400, "First"),       # duration 300ms
            _make_word("0:1", 2_000, 2_500, "Second"),   # duration 500ms, gap = 1600ms
            _make_word("0:2", 4_000, 4_300, "Third"),    # duration 300ms, gap = 1500ms
        ]

        cuts = detect_and_compress_silences(
            words,
            duration_ms=5_000,
            threshold_ms=400,
            word_decay_ms=120,
            speech_onset_ms=130,
            include_lead_in=False,
            include_trailing=False,
        )

        assert len(cuts) == 2
        # Cut 1: [400 + 120, 2000 - 130] = [520, 1870], duration = 1350ms
        # Cut 2: [2500 + 120, 4000 - 130] = [2620, 3870], duration = 1250ms
        assert cuts[0].duration_ms == 1_350
        assert cuts[1].duration_ms == 1_250

        adjusted = adjust_word_timestamps(words, cuts)
        assert len(adjusted) == 3

        # Word 1 is before all cuts: unchanged
        assert adjusted[0].s == 100
        assert adjusted[0].e == 400

        # Word 2 is shifted by Cut 1's duration (1350ms)
        # 2000 - 1350 = 650, 2500 - 1350 = 1150
        assert adjusted[1].s == 650
        assert adjusted[1].e == 1_150
        assert adjusted[1].e - adjusted[1].s == 500  # Word duration invariant preserved!

        # In compressed timeline, pause between Word 1 and Word 2 is: 650 - 400 = 250ms (0.25s)!
        assert adjusted[1].s - adjusted[0].e == 250

        # Word 3 is shifted by Cut 1 + Cut 2 (1350 + 1250 = 2600ms)
        # 4000 - 2600 = 1400, 4300 - 2600 = 1700
        assert adjusted[2].s == 1_400
        assert adjusted[2].e == 1_700
        assert adjusted[2].e - adjusted[2].s == 300  # Word duration invariant preserved!

        # In compressed timeline, pause between Word 2 and Word 3 is: 1400 - 1150 = 250ms (0.25s)!
        assert adjusted[2].s - adjusted[1].e == 250

    def test_adjust_word_timestamps_with_dicts(self) -> None:
        """Adjusting works identically with plain dictionaries from API/DB."""
        words = [
            {"s": 100, "e": 300, "t": "hello"},
            {"s": 1_500, "e": 1_800, "t": "world"},
        ]
        # Cut 1: [420, 1370], duration = 950ms
        cut = TrimCut(start_ms=420, end_ms=1_370)
        adjusted = adjust_word_timestamps(words, [cut])

        assert adjusted[0]["s"] == 100
        assert adjusted[0]["e"] == 300
        assert adjusted[1]["s"] == 550
        assert adjusted[1]["e"] == 850
        assert adjusted[1]["s"] - adjusted[0]["e"] == 250


class TestAcousticEnergyTracker:
    def test_calculate_frame_energy_dbfs(self) -> None:
        """Synthetic silence (< -45 dBFS) vs speech audio (> -20 dBFS)."""
        sample_rate = 16_000
        frame_size = 512

        # 1. Very quiet signal (amplitude 0.001 -> RMS ~0.001 -> dBFS ~ -60)
        silent_pcm = (np.random.randn(frame_size * 5) * 0.001).astype(np.float32)
        silent_dbfs = calculate_frame_energy_dbfs(silent_pcm, frame_length_samples=frame_size)
        assert len(silent_dbfs) == 5
        assert np.all(silent_dbfs < DEFAULT_ACOUSTIC_ENERGY_THRESHOLD_DBFS)  # < -38 dBFS

        # 2. Loud tone (amplitude 0.5 -> RMS ~0.35 -> dBFS ~ -9)
        t = np.linspace(0, 1, frame_size * 5, endpoint=False)
        loud_pcm = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        loud_dbfs = calculate_frame_energy_dbfs(loud_pcm, frame_length_samples=frame_size)
        assert len(loud_dbfs) == 5
        assert np.all(loud_dbfs > -15.0)  # > -15 dBFS, well above -38 dBFS

    def test_detect_energy_silence_gaps(self) -> None:
        """Energy tracker detects intervals where energy < -38 dBFS."""
        sample_rate = 16_000
        frame_size = 512

        # 1s loud, 1s silent, 1s loud
        t_loud = np.linspace(0, 1, sample_rate, endpoint=False)
        loud_seg = (0.5 * np.sin(2 * np.pi * 440 * t_loud)).astype(np.float32)
        silent_seg = (np.zeros(sample_rate)).astype(np.float32)

        audio = np.concatenate([loud_seg, silent_seg, loud_seg])
        gaps = detect_energy_silence_gaps(
            audio,
            sample_rate=sample_rate,
            energy_threshold_dbfs=-38.0,
            min_silence_ms=400,
            frame_length_samples=frame_size,
        )

        assert len(gaps) == 1
        gap_start, gap_end = gaps[0]
        # Silent segment is around [1000ms, 2000ms]
        assert 950 <= gap_start <= 1050
        assert 1950 <= gap_end <= 2050


class TestFullPipeline:
    def test_run_silence_trimming_pipeline_end_to_end(self) -> None:
        """Run full pipeline: detects, compresses, shifts, and reports metrics."""
        words = [
            _make_word("0:0", 0, 500, "Welcome"),
            _make_word("0:1", 2_500, 3_000, "back"),     # 2000ms pause (cut 1750ms)
            _make_word("0:2", 5_000, 5_500, "everyone"), # 2000ms pause (cut 1750ms)
        ]
        duration_ms = 7_000  # 1500ms trailing dead air (cut: 5500 + 120 = 5620 to 7000 = 1380ms)

        config = SilenceTrimmerConfig(
            silence_threshold_ms=400,
            word_decay_ms=120,
            speech_onset_ms=130,
        )

        result = run_silence_trimming_pipeline(
            words=words,
            duration_ms=duration_ms,
            config=config,
        )

        assert len(result.cuts) == 3
        # 1750 + 1750 + 1380 = 4880ms total trimmed
        assert result.total_trimmed_ms == 4_880
        assert result.compressed_duration_ms == 7_000 - 4_880
        assert len(result.adjusted_words) == 3

        # Phoneme protection SLA satisfied
        assert verify_speech_boundaries(words, result.cuts, min_lead_margin_ms=80, min_trail_margin_ms=80)
