from __future__ import annotations

import pytest

from worker_ai.passes.zoom import (
    HOLD_MS,
    MIN_ZOOM_GAP_MS,
    RAMP_IN_MS,
    RAMP_OUT_MS,
    ZOOM_PRESETS,
    Cue,
    build_zoom_events,
    detect_energy_cues,
    detect_sentence_start_cues,
    ease_out_cubic,
)


def test_ease_out_cubic_endpoints_and_monotonic() -> None:
    assert ease_out_cubic(0.0) == pytest.approx(0.0)
    assert ease_out_cubic(1.0) == pytest.approx(1.0)
    samples = [ease_out_cubic(t / 10) for t in range(11)]
    assert samples == sorted(samples)


def test_ease_out_cubic_clamped_outside_0_1() -> None:
    assert ease_out_cubic(-1) == 0.0
    assert ease_out_cubic(2) == 1.0


def test_detect_energy_cues_flags_outlier_peak() -> None:
    baseline = [(i * 100, 0.1) for i in range(20)]
    baseline[10] = (1000, 0.9)  # a clear outlier
    cues = detect_energy_cues(baseline, z_threshold=2.0)
    assert any(c.t_ms == 1000 for c in cues)


def test_detect_energy_cues_flat_signal_has_no_cues() -> None:
    flat = [(i * 100, 0.5) for i in range(10)]
    assert detect_energy_cues(flat) == []


def test_detect_sentence_start_cues_first_word_and_after_pause() -> None:
    words = [(0, 300, "hi"), (350, 600, "there"), (2000, 2300, "next")]
    cues = detect_sentence_start_cues(words, sentence_pause_ms=500)
    assert [c.t_ms for c in cues] == [0, 2000]


def test_zoom_events_are_monotonic_in_start_time() -> None:
    cues = [
        Cue(t_ms=t, kind="emphasis", confidence=0.8, reason="emphasis") for t in (0, 5000, 10000)
    ]
    events = build_zoom_events(cues, subject_track=[])
    starts = [e.start_ms for e in events]
    assert starts == sorted(starts)


def test_zoom_event_keyframes_have_expected_easing_shape() -> None:
    cues = [Cue(t_ms=0, kind="emphasis", confidence=0.9, reason="emphasis")]
    events = build_zoom_events(cues, subject_track=[(0, 0.4, 0.6)], preset="standard")
    assert len(events) == 1
    rows = events[0].keyframes
    expected_ts = [0, RAMP_IN_MS, RAMP_IN_MS + HOLD_MS, RAMP_IN_MS + HOLD_MS + RAMP_OUT_MS]
    assert [r.t_ms for r in rows] == expected_ts
    assert rows[0].scale == pytest.approx(1.0)
    assert rows[1].scale == pytest.approx(ZOOM_PRESETS["standard"].scale_to)
    assert rows[2].scale == pytest.approx(ZOOM_PRESETS["standard"].scale_to)
    assert rows[3].scale == pytest.approx(1.0)
    # centre follows the subject track at the cue time on every row
    assert all(r.cx == pytest.approx(0.4) and r.cy == pytest.approx(0.6) for r in rows)


def test_zoom_rate_limit_drops_cues_closer_than_min_gap() -> None:
    cues = [
        Cue(t_ms=0, kind="emphasis", confidence=0.9, reason="a"),
        Cue(t_ms=1000, kind="emphasis", confidence=0.9, reason="b"),  # too close
        Cue(t_ms=MIN_ZOOM_GAP_MS, kind="emphasis", confidence=0.9, reason="c"),  # ok
    ]
    events = build_zoom_events(cues, subject_track=[])
    assert [e.start_ms for e in events] == [0, MIN_ZOOM_GAP_MS]


def test_zoom_never_spans_a_scene_cut() -> None:
    end_ms = RAMP_IN_MS + HOLD_MS + RAMP_OUT_MS
    cues = [Cue(t_ms=100, kind="emphasis", confidence=0.9, reason="a")]
    # a scene cut falls inside [100, 100+end_ms)
    events = build_zoom_events(cues, subject_track=[], scene_cuts=[100 + end_ms // 2])
    assert events == []


def test_zoom_never_overlaps_an_accepted_cut() -> None:
    cues = [Cue(t_ms=100, kind="emphasis", confidence=0.9, reason="a")]
    events = build_zoom_events(cues, subject_track=[], cut_ranges=[(50, 500)])
    assert events == []


def test_zoom_allows_event_after_a_cut_range() -> None:
    cues = [Cue(t_ms=5000, kind="emphasis", confidence=0.9, reason="a")]
    events = build_zoom_events(cues, subject_track=[], cut_ranges=[(0, 500)])
    assert len(events) == 1
