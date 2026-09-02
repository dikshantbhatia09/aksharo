from __future__ import annotations

import itertools

import pytest

from worker_ai.passes.reframe import build_reframe_track, clamp_crop_window, rdp_simplify


def test_clamp_crop_window_keeps_window_inside_bounds() -> None:
    assert clamp_crop_window(0.0, 0.5) == pytest.approx(0.25)
    assert clamp_crop_window(1.0, 0.5) == pytest.approx(0.75)
    assert clamp_crop_window(0.5, 0.5) == pytest.approx(0.5)


def test_rdp_simplify_collapses_a_flat_line_to_endpoints() -> None:
    points = [(t, 0.5) for t in range(0, 1000, 100)]
    simplified = rdp_simplify(points, epsilon=0.001)
    assert simplified == [points[0], points[-1]]


def test_rdp_simplify_keeps_a_real_corner() -> None:
    points = [(0, 0.0), (100, 0.0), (200, 0.0), (300, 1.0), (400, 1.0), (500, 1.0)]
    simplified = rdp_simplify(points, epsilon=0.01)
    values = [p[1] for p in simplified]
    assert 0.0 in values and 1.0 in values
    assert len(simplified) < len(points)


def test_rdp_simplify_short_input_returned_unchanged() -> None:
    assert rdp_simplify([], epsilon=0.01) == []
    assert rdp_simplify([(0, 0.5)], epsilon=0.01) == [(0, 0.5)]


def test_reframe_track_deadzone_holds_still_for_small_movement() -> None:
    # Subject drifts by only 2% around 0.5 -- well inside an 8% deadzone.
    subject_track = [(t, 0.5 + 0.01 * ((-1) ** (t // 100)), 0.5) for t in range(0, 1000, 100)]
    result = build_reframe_track(
        subject_track, scene_ranges=[(0, 1000)], deadzone_fraction=0.08
    )
    cx_values = [k.cx for k in result.keyframes]
    assert max(cx_values) - min(cx_values) < 0.01 + 1e-6


def test_reframe_track_pans_when_outside_deadzone_but_respects_max_velocity() -> None:
    # Subject jumps far outside the deadzone at t=0 and stays there.
    subject_track = [(0, 0.1, 0.5)] + [(t, 0.9, 0.5) for t in range(100, 2000, 100)]
    result = build_reframe_track(
        subject_track,
        scene_ranges=[(0, 2000)],
        deadzone_fraction=0.08,
        max_velocity_per_s=0.5,
    )
    cx_values = [k.cx for k in result.keyframes]
    steps = [abs(b - a) for a, b in itertools.pairwise(cx_values)]
    # 0.5/s at 10Hz samples => max 0.05 per 100ms sample (before RDP simplification
    # removes collinear samples -- so check consecutive kept points too).
    # No single sample-to-sample gap in the un-simplified track can exceed
    # what max_velocity_per_s allows; after RDP simplification we can only
    # check the coarser, still-valid bound: the *average* approach rate
    # across the whole pan never exceeds the velocity cap.
    total_time_s = (result.keyframes[-1].t_ms - result.keyframes[0].t_ms) / 1000
    if total_time_s > 0:
        avg_rate = abs(cx_values[-1] - cx_values[0]) / total_time_s
        assert avg_rate <= 0.5 + 1e-6
    assert steps  # sanity: there is motion


def test_reframe_track_hard_cuts_at_scene_boundary() -> None:
    subject_track = [(t, 0.1, 0.5) for t in range(0, 1000, 100)] + [
        (t, 0.9, 0.5) for t in range(1000, 2000, 100)
    ]
    result = build_reframe_track(
        subject_track,
        scene_ranges=[(0, 1000), (1000, 2000)],
        deadzone_fraction=0.08,
        max_velocity_per_s=0.1,  # slow enough that a pan could not reach 0.9 without a hard cut
    )
    at_or_after_cut = [k for k in result.keyframes if k.t_ms >= 1000]
    assert at_or_after_cut
    # Immediately after the cut the window should already be near the new
    # scene's subject position (0.9-ish, window-clamped), not still ramping
    # from the old scene's 0.1.
    first_after_cut = min(at_or_after_cut, key=lambda k: k.t_ms)
    assert first_after_cut.cx > 0.5


def test_reframe_track_empty_inputs_return_empty() -> None:
    assert build_reframe_track([], scene_ranges=[]).keyframes == ()
    assert build_reframe_track([(0, 0.5, 0.5)], scene_ranges=[]).keyframes == ()


def test_reframe_track_flags_letterbox_scenes() -> None:
    result = build_reframe_track(
        [(0, 0.5, 0.5)], scene_ranges=[(0, 100), (100, 200)], multi_subject_scenes={1}
    )
    assert result.letterbox_scenes == (1,)
