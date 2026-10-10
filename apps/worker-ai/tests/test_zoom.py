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


def test_clamp_face_origin_bounds_and_eyeline_alignment() -> None:
    from worker_ai.passes.zoom import clamp_face_origin

    # Out-of-bounds coordinates clamped
    assert clamp_face_origin(0.05, 0.05) == (0.2, 0.2)
    assert clamp_face_origin(0.95, 0.95) == (0.8, 0.6)

    # In-bounds coordinates preserved verbatim
    assert clamp_face_origin(0.5, 0.35) == (0.5, 0.35)

    # Upper third eye-line [0.28, 0.38] remains intact
    eye_line_y = 0.33
    ox, oy = clamp_face_origin(0.48, eye_line_y)
    assert 0.28 <= oy <= 0.38
    assert ox == 0.48


def test_zoom_preset_off_returns_zero_events() -> None:
    cues = [Cue(t_ms=t, kind="emphasis", confidence=0.9, reason="test") for t in (0, 5000, 10000)]
    events = build_zoom_events(cues, subject_track=[], preset="off")
    assert events == []


def test_zoom_presets_pacing_gaps() -> None:
    cues = [
        Cue(t_ms=0, kind="emphasis", confidence=0.9, reason="a"),
        Cue(t_ms=3000, kind="emphasis", confidence=0.9, reason="b"),
        Cue(t_ms=5000, kind="emphasis", confidence=0.9, reason="c"),
        Cue(t_ms=8000, kind="emphasis", confidence=0.9, reason="d"),
    ]

    # Subtle: min gap 7000ms -> cues at 0 and 8000ms accepted
    events_subtle = build_zoom_events(
        cues, subject_track=[], preset="subtle", min_gap_ms=ZOOM_PRESETS["subtle"].min_gap_ms
    )
    assert [e.start_ms for e in events_subtle] == [0, 8000]

    # Standard: min gap 4000ms -> cues at 0 and 5000ms accepted
    events_standard = build_zoom_events(
        cues, subject_track=[], preset="standard", min_gap_ms=ZOOM_PRESETS["standard"].min_gap_ms
    )
    assert [e.start_ms for e in events_standard] == [0, 5000]

    # Fast: min gap 2500ms -> cues at 0, 3000, 8000ms accepted
    events_fast = build_zoom_events(
        cues, subject_track=[], preset="fast", min_gap_ms=ZOOM_PRESETS["fast"].min_gap_ms
    )
    assert [e.start_ms for e in events_fast] == [0, 3000, 8000]


def test_zoom_jump_transition_creates_instant_punch_keyframes() -> None:
    cues = [Cue(t_ms=1000, kind="emphasis", confidence=0.9, reason="punch")]
    events = build_zoom_events(cues, subject_track=[(1000, 0.45, 0.35)], preset="standard", transition="jump")
    assert len(events) == 1
    rows = events[0].keyframes
    # Instant punch jump: scale at t=0 is immediately scale_to (1.2)
    assert len(rows) == 3
    assert rows[0].t_ms == 0
    assert rows[0].scale == pytest.approx(1.2)
    assert rows[1].scale == pytest.approx(1.2)
    assert rows[2].scale == pytest.approx(1.0)  # jumps back to 1.0


def test_zoom_creep_transition_creates_continuous_ken_burns_easing() -> None:
    cues = [Cue(t_ms=1000, kind="emphasis", confidence=0.9, reason="creep")]
    events = build_zoom_events(cues, subject_track=[(1000, 0.5, 0.33)], preset="standard", transition="creep")
    assert len(events) == 1
    rows = events[0].keyframes
    assert len(rows) == 3
    assert rows[0].t_ms == 0
    assert rows[0].scale == pytest.approx(1.0)
    assert rows[1].t_ms == 3000
    assert rows[1].scale == pytest.approx(1.08)
    assert rows[1].ease == "inOut"


def test_zoom_alternate_transition_cycles_cadence() -> None:
    cues = [
        Cue(t_ms=0, kind="emphasis", confidence=0.9, reason="sentence1"),
        Cue(t_ms=4000, kind="emphasis", confidence=0.9, reason="sentence2"),
        Cue(t_ms=8000, kind="emphasis", confidence=0.9, reason="sentence3"),
    ]
    events = build_zoom_events(cues, subject_track=[(0, 0.5, 0.35)], preset="standard", transition="alternate")
    assert len(events) == 3
    # Event 0: jump punch
    assert events[0].keyframes[0].scale == pytest.approx(1.2)
    # Event 1: creep
    assert events[1].keyframes[1].scale == pytest.approx(1.08)
    # Event 2: ease
    assert events[2].keyframes[0].scale == pytest.approx(1.0)


def test_zoom_generation_latency_sla() -> None:
    import time

    # SLA: Zoom trajectory generation latency <= 120 ms
    cues = [
        Cue(t_ms=i * 3000, kind="sentence_start", confidence=0.8, reason="sentence")
        for i in range(100)
    ]
    track = [(i * 200, 0.48, 0.34) for i in range(1500)]

    t0 = time.perf_counter()
    events = build_zoom_events(cues, subject_track=track, preset="standard")
    duration_ms = (time.perf_counter() - t0) * 1000.0

    assert len(events) > 0
    assert duration_ms <= 120.0

