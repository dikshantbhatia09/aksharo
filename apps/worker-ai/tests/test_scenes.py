from __future__ import annotations

from worker_ai.passes.scenes import FrameStat, detect_scenes, scene_ranges


def _stats(*values: tuple[int, float, float, float]) -> list[FrameStat]:
    return [FrameStat(t_ms=t, hue=h, sat=s, val=v) for t, h, s, v in values]


def test_no_cut_below_threshold() -> None:
    frames = _stats((0, 100, 100, 100), (200, 102, 101, 99), (400, 101, 100, 101))
    assert detect_scenes(frames, threshold=27.0) == []


def test_cut_detected_on_large_content_change() -> None:
    frames = _stats(
        (0, 100, 100, 100),
        (200, 100, 100, 100),
        (400, 200, 200, 200),  # big jump -> cut
        (600, 200, 200, 200),
    )
    boundaries = detect_scenes(frames, threshold=27.0, min_scene_len_ms=0)
    assert len(boundaries) == 1
    assert boundaries[0].at_ms == 400


def test_min_scene_len_suppresses_a_second_cut_too_soon() -> None:
    frames = _stats(
        (0, 0, 0, 0),
        (100, 200, 200, 200),  # cut
        (200, 0, 0, 0),  # would be a cut, but too soon
        (900, 200, 200, 200),  # far enough later -> cut
    )
    boundaries = detect_scenes(frames, threshold=27.0, min_scene_len_ms=600)
    assert [b.at_ms for b in boundaries] == [100, 900]


def test_fewer_than_two_frames_is_empty() -> None:
    assert detect_scenes([]) == []
    assert detect_scenes(_stats((0, 0, 0, 0))) == []


def test_scene_ranges_from_boundaries() -> None:
    from worker_ai.passes.scenes import SceneBoundary

    boundaries = [SceneBoundary(at_ms=1000, score=50), SceneBoundary(at_ms=3000, score=50)]
    ranges = scene_ranges(boundaries, 5000)
    assert ranges == [(0, 1000), (1000, 3000), (3000, 5000)]


def test_scene_ranges_no_boundaries_is_one_scene() -> None:
    assert scene_ranges([], 5000) == [(0, 5000)]


def test_scene_cut_fixture_content_detector_matches_known_boundary() -> None:
    """A fixture resembling a hard cut halfway through a 10s clip sampled at 5fps."""
    frames: list[FrameStat] = []
    for i in range(25):
        t_ms = i * 200
        if i < 12:
            frames.append(FrameStat(t_ms=t_ms, hue=40, sat=60, val=80))
        else:
            frames.append(FrameStat(t_ms=t_ms, hue=140, sat=160, val=180))
    boundaries = detect_scenes(frames, threshold=27.0, min_scene_len_ms=0)
    assert len(boundaries) == 1
    assert boundaries[0].at_ms == 12 * 200
