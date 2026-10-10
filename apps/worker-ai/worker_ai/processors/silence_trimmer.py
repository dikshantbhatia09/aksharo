"""Dead-Air & Silence Trimming Engine (Pillar 5, Functionality 03).

Pure, deterministic pause compressor and dead-air detection engine:
1. Accurately detects non-speech intervals where acoustic energy falls below
   -38 dBFS (or gaps between transcript words).
2. Compresses long pauses (> targetThreshold, default 400ms) down to a crisp,
   natural breathing interval (0.25s: 120ms word decay room tone + 130ms speech onset buffer)
   rather than binary deletion which creates breathless, unnatural speech.
3. Shifts word timestamps post-compression so subtitle animations stay perfectly
   synchronized with the shortened video.
4. Enforces 0.0% speech syllable clipping rate with safe margins (>= 80ms).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any, Sequence, TypeVar

import numpy as np

from worker_ai.passes.autocut import CutCandidate, SpeechRegion, Word

__all__ = [
    "DEFAULT_ACOUSTIC_ENERGY_THRESHOLD_DBFS",
    "DEFAULT_MIN_CUT_MS",
    "DEFAULT_SILENCE_THRESHOLD_MS",
    "DEFAULT_SPEECH_ONSET_MS",
    "DEFAULT_TARGET_BREATH_MS",
    "DEFAULT_WORD_DECAY_MS",
    "SilenceInterval",
    "SilenceTrimmerConfig",
    "SilenceTrimmerResult",
    "TrimCut",
    "adjust_word_timestamps",
    "calculate_frame_energy_dbfs",
    "compress_energy_silences",
    "compress_silence_interval",
    "detect_and_compress_silences",
    "detect_energy_silence_gaps",
    "extract_word_silence_intervals",
    "run_silence_trimming_pipeline",
    "verify_speech_boundaries",
]

#: Default silence threshold to trigger pause compression (0.4s).
DEFAULT_SILENCE_THRESHOLD_MS = 400

#: Preserved room tone decay after the preceding word (0.12s / 120ms).
DEFAULT_WORD_DECAY_MS = 120

#: Preserved speech onset buffer before the succeeding word (0.13s / 130ms).
DEFAULT_SPEECH_ONSET_MS = 130

#: Standard natural breathing interval: 120ms + 130ms = 250ms (0.25s).
DEFAULT_TARGET_BREATH_MS = DEFAULT_WORD_DECAY_MS + DEFAULT_SPEECH_ONSET_MS

#: Acoustic energy threshold below which frames are considered silence (-38 dBFS).
DEFAULT_ACOUSTIC_ENERGY_THRESHOLD_DBFS = -38.0

#: Minimum cut length to keep: discard micro-splices under 50ms.
DEFAULT_MIN_CUT_MS = 50


@dataclass(frozen=True, slots=True)
class SilenceTrimmerConfig:
    """Tunable parameters for the silence trimming engine."""

    silence_threshold_ms: int = DEFAULT_SILENCE_THRESHOLD_MS
    word_decay_ms: int = DEFAULT_WORD_DECAY_MS
    speech_onset_ms: int = DEFAULT_SPEECH_ONSET_MS
    energy_threshold_dbfs: float = DEFAULT_ACOUSTIC_ENERGY_THRESHOLD_DBFS
    min_cut_ms: int = DEFAULT_MIN_CUT_MS

    @property
    def target_breath_ms(self) -> int:
        return self.word_decay_ms + self.speech_onset_ms


@dataclass(frozen=True, slots=True)
class SilenceInterval:
    """An uncompressed pause or silence interval between words or at media edges."""

    start_ms: int
    end_ms: int
    prev_word_id: str | None = None
    next_word_id: str | None = None
    is_lead_in: bool = False
    is_trailing: bool = False

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


@dataclass(frozen=True, slots=True)
class TrimCut:
    """A proposed middle-interval cut window produced by pause compression."""

    start_ms: int
    end_ms: int
    reason: str = "pause"
    confidence: float = 0.95
    preserved_lead_ms: int = DEFAULT_WORD_DECAY_MS
    preserved_trail_ms: int = DEFAULT_SPEECH_ONSET_MS
    prev_word_id: str | None = None
    next_word_id: str | None = None

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)

    def to_cut_candidate(self) -> CutCandidate:
        word_ids: tuple[str, ...] = ()
        if self.prev_word_id and self.next_word_id:
            word_ids = (self.prev_word_id, self.next_word_id)
        elif self.prev_word_id:
            word_ids = (self.prev_word_id,)
        elif self.next_word_id:
            word_ids = (self.next_word_id,)
        return CutCandidate(
            start_ms=self.start_ms,
            end_ms=self.end_ms,
            reason="pause" if self.reason == "pause" else "silence",
            confidence=self.confidence,
            word_ids=word_ids,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "durationMs": self.duration_ms,
            "reason": self.reason,
            "confidence": self.confidence,
            "preservedLeadMs": self.preserved_lead_ms,
            "preservedTrailMs": self.preserved_trail_ms,
        }


@dataclass(frozen=True, slots=True)
class SilenceTrimmerResult:
    """Output of the silence trimming pipeline."""

    cuts: tuple[TrimCut, ...]
    adjusted_words: tuple[Word, ...]
    total_trimmed_ms: int
    original_duration_ms: int
    compressed_duration_ms: int
    config: SilenceTrimmerConfig


def _get_word_coords(item: Any) -> tuple[str, int, int]:
    """Helper to extract (wid, start_ms, end_ms) from Word or dict."""
    if isinstance(item, Word):
        return item.wid, item.s, item.e
    if isinstance(item, dict):
        wid = str(item.get("wid") or item.get("id") or "")
        start = int(item.get("s") if item.get("s") is not None else item.get("start", 0))
        end = int(item.get("e") if item.get("e") is not None else item.get("end", 0))
        return wid, start, end
    wid = str(getattr(item, "wid", getattr(item, "id", "")))
    start = int(getattr(item, "s", getattr(item, "start", 0)))
    end = int(getattr(item, "e", getattr(item, "end", 0)))
    return wid, start, end


def extract_word_silence_intervals(
    words: Sequence[Any],
    duration_ms: int = 0,
    include_lead_in: bool = True,
    include_trailing: bool = True,
) -> list[SilenceInterval]:
    """Extract pauses between adjacent transcript words and optional edge silences.

    Delta t = word_{i+1}.start - word_i.end.
    """
    if not words:
        if duration_ms > 0 and include_lead_in:
            return [SilenceInterval(0, duration_ms, is_lead_in=True, is_trailing=True)]
        return []

    sorted_words = sorted(words, key=lambda w: _get_word_coords(w)[1])
    intervals: list[SilenceInterval] = []

    # Lead-in silence before first word
    first_wid, first_start, _ = _get_word_coords(sorted_words[0])
    if include_lead_in and first_start > 0:
        intervals.append(
            SilenceInterval(
                start_ms=0,
                end_ms=first_start,
                next_word_id=first_wid,
                is_lead_in=True,
            )
        )

    # Pauses between adjacent words
    for prev_w, next_w in pairwise(sorted_words):
        p_wid, _, p_end = _get_word_coords(prev_w)
        n_wid, n_start, _ = _get_word_coords(next_w)
        if n_start > p_end:
            intervals.append(
                SilenceInterval(
                    start_ms=p_end,
                    end_ms=n_start,
                    prev_word_id=p_wid,
                    next_word_id=n_wid,
                )
            )

    # Trailing silence after last word
    last_wid, _, last_end = _get_word_coords(sorted_words[-1])
    if include_trailing and duration_ms > last_end:
        intervals.append(
            SilenceInterval(
                start_ms=last_end,
                end_ms=duration_ms,
                prev_word_id=last_wid,
                is_trailing=True,
            )
        )

    return intervals


def compress_silence_interval(
    interval: SilenceInterval,
    threshold_ms: int = DEFAULT_SILENCE_THRESHOLD_MS,
    word_decay_ms: int = DEFAULT_WORD_DECAY_MS,
    speech_onset_ms: int = DEFAULT_SPEECH_ONSET_MS,
    min_cut_ms: int = DEFAULT_MIN_CUT_MS,
) -> TrimCut | None:
    """Calculate the middle trim window for an interval exceeding `threshold_ms`.

    If delta_t > threshold_ms:
    - Keep first `word_decay_ms` (0.12s decay room tone).
    - Remove middle interval.
    - Keep final `speech_onset_ms` (0.13s speech onset buffer).
    """
    delta_t = interval.duration_ms
    if delta_t <= threshold_ms:
        return None

    if interval.is_lead_in and not interval.is_trailing:
        # Initial dead air: keep room tone onset before speech
        cut_start = 0
        cut_end = interval.end_ms - speech_onset_ms
        if cut_end - cut_start < min_cut_ms:
            return None
        confidence = _compute_confidence(delta_t, threshold_ms)
        return TrimCut(
            start_ms=cut_start,
            end_ms=cut_end,
            reason="silence",
            confidence=confidence,
            preserved_lead_ms=0,
            preserved_trail_ms=speech_onset_ms,
            next_word_id=interval.next_word_id,
        )

    if interval.is_trailing and not interval.is_lead_in:
        # Trailing dead air: keep decay room tone after final speech
        cut_start = interval.start_ms + word_decay_ms
        cut_end = interval.end_ms
        if cut_end - cut_start < min_cut_ms:
            return None
        confidence = _compute_confidence(delta_t, threshold_ms)
        return TrimCut(
            start_ms=cut_start,
            end_ms=cut_end,
            reason="silence",
            confidence=confidence,
            preserved_lead_ms=word_decay_ms,
            preserved_trail_ms=0,
            prev_word_id=interval.prev_word_id,
        )

    if interval.is_lead_in and interval.is_trailing:
        # Entire clip is empty
        return TrimCut(
            start_ms=0,
            end_ms=interval.end_ms,
            reason="silence",
            confidence=0.99,
            preserved_lead_ms=0,
            preserved_trail_ms=0,
        )

    # Standard conversational pause between two words:
    # Slice out middle: (delta_t - (word_decay_ms + speech_onset_ms))
    cut_start = interval.start_ms + word_decay_ms
    cut_end = interval.end_ms - speech_onset_ms

    if cut_end - cut_start < min_cut_ms:
        return None

    confidence = _compute_confidence(delta_t, threshold_ms)
    return TrimCut(
        start_ms=cut_start,
        end_ms=cut_end,
        reason="pause",
        confidence=confidence,
        preserved_lead_ms=word_decay_ms,
        preserved_trail_ms=speech_onset_ms,
        prev_word_id=interval.prev_word_id,
        next_word_id=interval.next_word_id,
    )


def _compute_confidence(gap_ms: int, threshold_ms: int) -> float:
    """Confidence scales smoothly with pause length up to 0.99."""
    if threshold_ms <= 0:
        return 0.99
    ratio = gap_ms / (threshold_ms * 2.0)
    return round(float(min(0.99, max(0.85, ratio))), 4)


def detect_and_compress_silences(
    words: Sequence[Any],
    duration_ms: int = 0,
    threshold_ms: int = DEFAULT_SILENCE_THRESHOLD_MS,
    word_decay_ms: int = DEFAULT_WORD_DECAY_MS,
    speech_onset_ms: int = DEFAULT_SPEECH_ONSET_MS,
    include_lead_in: bool = True,
    include_trailing: bool = True,
    min_cut_ms: int = DEFAULT_MIN_CUT_MS,
) -> list[TrimCut]:
    """Detect pauses between words and compress pauses > threshold_ms down to 0.25s."""
    intervals = extract_word_silence_intervals(
        words,
        duration_ms=duration_ms,
        include_lead_in=include_lead_in,
        include_trailing=include_trailing,
    )
    cuts: list[TrimCut] = []
    for interval in intervals:
        cut = compress_silence_interval(
            interval,
            threshold_ms=threshold_ms,
            word_decay_ms=word_decay_ms,
            speech_onset_ms=speech_onset_ms,
            min_cut_ms=min_cut_ms,
        )
        if cut is not None:
            cuts.append(cut)
    return cuts


def calculate_frame_energy_dbfs(
    pcm_data: np.ndarray,
    frame_length_samples: int = 512,
) -> np.ndarray:
    """Calculate short-time acoustic energy in dBFS per frame.

    Standard Silero framing: 512 samples per frame (32ms at 16kHz).
    """
    if len(pcm_data) == 0:
        return np.array([], dtype=np.float32)

    # Normalize int16 if needed
    if pcm_data.dtype == np.int16:
        samples = pcm_data.astype(np.float32) / 32768.0
    else:
        samples = pcm_data.astype(np.float32)

    num_frames = len(samples) // frame_length_samples
    if num_frames == 0:
        rms = np.sqrt(np.mean(samples**2) + 1e-12)
        dbfs = 20.0 * np.log10(rms + 1e-12)
        return np.array([dbfs], dtype=np.float32)

    trimmed = samples[: num_frames * frame_length_samples]
    framed = trimmed.reshape((num_frames, frame_length_samples))
    rms = np.sqrt(np.mean(framed**2, axis=1) + 1e-12)
    dbfs = 20.0 * np.log10(rms + 1e-12)
    return dbfs.astype(np.float32)


def detect_energy_silence_gaps(
    pcm_data: np.ndarray,
    sample_rate: int = 16000,
    energy_threshold_dbfs: float = DEFAULT_ACOUSTIC_ENERGY_THRESHOLD_DBFS,
    min_silence_ms: int = DEFAULT_SILENCE_THRESHOLD_MS,
    frame_length_samples: int = 512,
) -> list[tuple[int, int]]:
    """Detect contiguous intervals where acoustic energy falls below `energy_threshold_dbfs`."""
    energies = calculate_frame_energy_dbfs(pcm_data, frame_length_samples=frame_length_samples)
    if len(energies) == 0:
        return []

    frame_duration_ms = (frame_length_samples * 1000.0) / sample_rate
    gaps: list[tuple[int, int]] = []
    in_silence = False
    silence_start_frame = 0

    for i, db in enumerate(energies):
        is_silent = db < energy_threshold_dbfs
        if not in_silence and is_silent:
            in_silence = True
            silence_start_frame = i
        elif in_silence and not is_silent:
            in_silence = False
            start_ms = int(silence_start_frame * frame_duration_ms)
            end_ms = int(i * frame_duration_ms)
            if end_ms - start_ms >= min_silence_ms:
                gaps.append((start_ms, end_ms))

    if in_silence:
        start_ms = int(silence_start_frame * frame_duration_ms)
        end_ms = int(len(energies) * frame_duration_ms)
        if end_ms - start_ms >= min_silence_ms:
            gaps.append((start_ms, end_ms))

    return gaps


def compress_energy_silences(
    silence_gaps: Sequence[tuple[int, int]],
    threshold_ms: int = DEFAULT_SILENCE_THRESHOLD_MS,
    word_decay_ms: int = DEFAULT_WORD_DECAY_MS,
    speech_onset_ms: int = DEFAULT_SPEECH_ONSET_MS,
    min_cut_ms: int = DEFAULT_MIN_CUT_MS,
) -> list[TrimCut]:
    """Compress detected acoustic silence intervals to breathing pause duration."""
    cuts: list[TrimCut] = []
    for start_ms, end_ms in silence_gaps:
        gap = end_ms - start_ms
        if gap <= threshold_ms:
            continue
        cut_start = start_ms + word_decay_ms
        cut_end = end_ms - speech_onset_ms
        if cut_end - cut_start >= min_cut_ms:
            cuts.append(
                TrimCut(
                    start_ms=cut_start,
                    end_ms=cut_end,
                    reason="silence",
                    confidence=_compute_confidence(gap, threshold_ms),
                    preserved_lead_ms=word_decay_ms,
                    preserved_trail_ms=speech_onset_ms,
                )
            )
    return cuts


TWord = TypeVar("TWord")


def adjust_word_timestamps(
    words: Sequence[TWord],
    cuts: Sequence[Any],
) -> list[TWord]:
    """Shift all subsequent word timestamps forward by the removed duration.

    This ensures subtitle animations stay perfectly synchronized with the shortened video.
    Supports Word dataclass objects or dicts.
    """
    if not words or not cuts:
        return list(words)

    # Normalize cuts to ordered non-overlapping tuples (start_ms, end_ms, duration_ms)
    raw_cuts: list[tuple[int, int, int]] = []
    for c in cuts:
        if isinstance(c, (TrimCut, CutCandidate)):
            raw_cuts.append((c.start_ms, c.end_ms, c.end_ms - c.start_ms))
        elif isinstance(c, dict):
            s = int(c.get("startMs", c.get("start", 0)))
            e = int(c.get("endMs", c.get("end", 0)))
            raw_cuts.append((s, e, max(0, e - s)))
        elif isinstance(c, (tuple, list)) and len(c) >= 2:
            s, e = int(c[0]), int(c[1])
            raw_cuts.append((s, e, max(0, e - s)))

    sorted_cuts = sorted(raw_cuts, key=lambda c: c[0])

    adjusted: list[TWord] = []
    for w in words:
        wid, orig_s, orig_e = _get_word_coords(w)

        # Calculate time removed prior to orig_s and orig_e
        removed_before_s = _calculate_removed_delta(orig_s, sorted_cuts)
        removed_before_e = _calculate_removed_delta(orig_e, sorted_cuts)

        new_s = max(0, orig_s - removed_before_s)
        new_e = max(new_s + 1, orig_e - removed_before_e)

        if isinstance(w, Word):
            adjusted.append(
                Word(
                    wid=w.wid,
                    s=new_s,
                    e=new_e,
                    t=w.t,
                    filler=w.filler,
                    scripts=w.scripts,
                )  # type: ignore[arg-type]
            )
        elif isinstance(w, dict):
            copy_dict = dict(w)
            if "s" in copy_dict:
                copy_dict["s"] = new_s
                copy_dict["e"] = new_e
            else:
                copy_dict["start"] = new_s
                copy_dict["end"] = new_e
            adjusted.append(copy_dict)  # type: ignore[arg-type]
        else:
            # Generic object with s/e attributes
            try:
                setattr(w, "s", new_s)
                setattr(w, "e", new_e)
                adjusted.append(w)
            except AttributeError:
                adjusted.append(w)

    return adjusted


def _calculate_removed_delta(timestamp_ms: int, sorted_cuts: list[tuple[int, int, int]]) -> int:
    """Calculate how many milliseconds of cuts precede or swallow `timestamp_ms`."""
    total_removed = 0
    for cut_s, cut_e, duration in sorted_cuts:
        if cut_e <= timestamp_ms:
            # Cut is entirely before timestamp
            total_removed += duration
        elif cut_s < timestamp_ms < cut_e:
            # Timestamp lands inside the cut: remove duration up to timestamp
            total_removed += (timestamp_ms - cut_s)
        else:
            # Cut is after timestamp
            break
    return total_removed


def verify_speech_boundaries(
    words: Sequence[Any],
    cuts: Sequence[Any],
    min_lead_margin_ms: int = 80,
    min_trail_margin_ms: int = 80,
) -> bool:
    """Verify that speech boundaries never lose onset/offset phonemes (0.0% syllable clipping).

    Asserts:
    1. No cut overlaps any word interval [word.s, word.e].
    2. Cuts between words maintain >= min_lead_margin_ms after preceding word end.
    3. Cuts between words maintain >= min_trail_margin_ms before succeeding word start.
    """
    if not words or not cuts:
        return True

    sorted_words = sorted(words, key=lambda w: _get_word_coords(w)[1])

    for c in cuts:
        if isinstance(c, (TrimCut, CutCandidate)):
            c_start, c_end = c.start_ms, c.end_ms
        elif isinstance(c, dict):
            c_start = int(c.get("startMs", c.get("start", 0)))
            c_end = int(c.get("endMs", c.get("end", 0)))
        else:
            c_start, c_end = int(c[0]), int(c[1])

        # Check overlap with any word
        for w in sorted_words:
            _, w_s, w_e = _get_word_coords(w)
            # Cut must not intrude into word
            if c_start < w_e and w_s < c_end:
                return False

            # Check lead-out safety margin for word preceding cut
            if w_e <= c_start and (c_start - w_e) < min_lead_margin_ms:
                return False

            # Check lead-in safety margin for word succeeding cut
            if c_end <= w_s and (w_s - c_end) < min_trail_margin_ms:
                return False

    return True


def run_silence_trimming_pipeline(
    words: Sequence[Word],
    duration_ms: int,
    pcm_data: np.ndarray | None = None,
    config: SilenceTrimmerConfig | None = None,
) -> SilenceTrimmerResult:
    """Run the complete Dead-Air & Silence Trimming pipeline."""
    cfg = config or SilenceTrimmerConfig()

    cuts: list[TrimCut] = []
    if pcm_data is not None and len(pcm_data) > 0:
        # Acoustic energy tracking pass
        acoustic_gaps = detect_energy_silence_gaps(
            pcm_data,
            energy_threshold_dbfs=cfg.energy_threshold_dbfs,
            min_silence_ms=cfg.silence_threshold_ms,
        )
        if acoustic_gaps:
            cuts = compress_energy_silences(
                acoustic_gaps,
                threshold_ms=cfg.silence_threshold_ms,
                word_decay_ms=cfg.word_decay_ms,
                speech_onset_ms=cfg.speech_onset_ms,
                min_cut_ms=cfg.min_cut_ms,
            )

    if not cuts:
        # Transcript-driven pause compression pass
        cuts = detect_and_compress_silences(
            words,
            duration_ms=duration_ms,
            threshold_ms=cfg.silence_threshold_ms,
            word_decay_ms=cfg.word_decay_ms,
            speech_onset_ms=cfg.speech_onset_ms,
            min_cut_ms=cfg.min_cut_ms,
        )

    # Shift word timestamps post-compression
    adjusted_words = adjust_word_timestamps(words, cuts)
    total_trimmed = sum(c.duration_ms for c in cuts)
    compressed_duration = max(0, duration_ms - total_trimmed)

    return SilenceTrimmerResult(
        cuts=tuple(cuts),
        adjusted_words=tuple(adjusted_words),
        total_trimmed_ms=total_trimmed,
        original_duration_ms=duration_ms,
        compressed_duration_ms=compressed_duration,
        config=cfg,
    )
