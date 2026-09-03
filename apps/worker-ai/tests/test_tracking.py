from __future__ import annotations

import os

import numpy as np
import pytest

from worker_ai.passes.tracking import (
    BrightBlobDetector,
    Detection,
    IouTracker,
    OneEuroFilter,
    YuNetDetector,
    YuNetModelUnavailableError,
    iou,
    track_subject,
)


def test_iou_identical_boxes_is_one() -> None:
    a = Detection(t_ms=0, x=0.1, y=0.1, w=0.2, h=0.2)
    assert iou(a, a) == pytest.approx(1.0)


def test_iou_disjoint_boxes_is_zero() -> None:
    a = Detection(t_ms=0, x=0.0, y=0.0, w=0.1, h=0.1)
    b = Detection(t_ms=0, x=0.5, y=0.5, w=0.1, h=0.1)
    assert iou(a, b) == 0.0


def test_one_euro_filter_smooths_noisy_signal_toward_mean() -> None:
    f = OneEuroFilter(min_cutoff=1.0, beta=0.0)
    values = [0.5 + (0.05 if i % 2 == 0 else -0.05) for i in range(50)]
    outputs = [f(i / 30, v) for i, v in enumerate(values)]
    # A jittery alternating signal should settle to a much smaller amplitude
    # than the raw jitter once the filter has warmed up.
    tail = outputs[-10:]
    assert max(tail) - min(tail) < 0.05


def test_one_euro_filter_first_call_passes_through() -> None:
    f = OneEuroFilter()
    assert f(0.0, 0.42) == 0.42


def test_iou_tracker_links_overlapping_boxes_across_frames() -> None:
    tracker = IouTracker()
    a = tracker.link([Detection(t_ms=0, x=0.1, y=0.1, w=0.1, h=0.1)])
    b = tracker.link([Detection(t_ms=200, x=0.12, y=0.11, w=0.1, h=0.1)])
    assert a is not None
    assert b is not None
    assert b.x == pytest.approx(0.12)


def test_iou_tracker_returns_none_on_empty_frame() -> None:
    tracker = IouTracker()
    tracker.link([Detection(t_ms=0, x=0.1, y=0.1, w=0.1, h=0.1)])
    assert tracker.link([]) is None


def test_multi_face_prefers_speaking_speaker() -> None:
    frames = [
        (
            0,
            [
                Detection(t_ms=0, x=0.0, y=0.0, w=0.1, h=0.1, speaker_id="a"),
                Detection(t_ms=0, x=0.5, y=0.5, w=0.3, h=0.3, speaker_id="b"),
            ],
        )
    ]
    points = track_subject(frames, speaking_speaker_at={0: "a"})
    assert points[0].cx == pytest.approx(0.05, abs=1e-6)


def test_multi_face_falls_back_to_largest_without_diarisation() -> None:
    frames = [
        (
            0,
            [
                Detection(t_ms=0, x=0.0, y=0.0, w=0.1, h=0.1, speaker_id="a"),
                Detection(t_ms=0, x=0.5, y=0.5, w=0.3, h=0.3, speaker_id="b"),
            ],
        )
    ]
    points = track_subject(frames)
    assert points[0].cx == pytest.approx(0.65, abs=1e-6)


def test_no_detection_anywhere_uses_saliency_fallback() -> None:
    frames: list[tuple[int, list[Detection]]] = [(t, []) for t in range(0, 1000, 200)]
    points = track_subject(frames, saliency_center=(0.5, 0.5))
    assert all(p.fallback for p in points)
    assert all(p.cx == 0.5 and p.cy == 0.5 for p in points)


def test_missing_frame_holds_last_known_center() -> None:
    frames = [
        (0, [Detection(t_ms=0, x=0.2, y=0.2, w=0.1, h=0.1)]),
        (200, []),
        (400, []),
    ]
    points = track_subject(frames, min_cutoff=100.0, beta=0.0)  # near-passthrough smoothing
    assert points[1].fallback is True
    assert points[1].cx == pytest.approx(points[0].cx, abs=0.05)


# ---------------------------------------------------------------------------
# Synthetic "moving rectangle face" tracking accuracy (acceptance criterion 1)
# ---------------------------------------------------------------------------


def _render_moving_rect_frames(
    *, n_frames: int, width: int = 100, height: int = 100, rect_size: int = 10
) -> tuple[list[np.ndarray], list[float]]:
    """A bright `rect_size`x`rect_size` square moving left-to-right across a
    dark frame, linearly in x. Returns (frames, true_cx_normalised).
    """
    frames: list[np.ndarray] = []
    true_cx: list[float] = []
    span = width - rect_size
    for i in range(n_frames):
        frame = np.zeros((height, width), dtype=np.float64)
        x0 = round((i / max(1, n_frames - 1)) * span)
        y0 = (height - rect_size) // 2
        frame[y0 : y0 + rect_size, x0 : x0 + rect_size] = 1.0
        frames.append(frame)
        true_cx.append((x0 + rect_size / 2) / width)
    return frames, true_cx


def test_synthetic_moving_rectangle_tracking_error_under_3_percent_of_width() -> None:
    n_frames = 30
    frames, true_cx = _render_moving_rect_frames(n_frames=n_frames)
    detector = BrightBlobDetector(frames=frames, frame_interval_ms=200)

    detection_frames: list[tuple[int, list[Detection]]] = []
    for i in range(n_frames):
        t_ms = i * 200
        detection_frames.append((t_ms, detector.detect(i, t_ms)))

    points = track_subject(detection_frames, min_cutoff=5.0, beta=0.5)

    errors = [abs(p.cx - true_cx[i]) for i, p in enumerate(points)]
    max_error = max(errors)
    assert max_error < 0.03, f"tracking error {max_error:.4f} exceeds 3% of width"


def test_yunet_detector_raises_without_model_path() -> None:
    with pytest.raises(YuNetModelUnavailableError):
        YuNetDetector("", frames=[])


@pytest.mark.slow
def test_yunet_detector_real_model() -> None:
    """YuNet ONNX weights (M15, H-22): skips when not provisioned locally."""
    model_path = os.environ.get("YUNET_MODEL_PATH", "")
    if not model_path:
        pytest.skip("YUNET_MODEL_PATH not set — no model weights on this machine (H-22)")

    # A plain BGR uint8 frame with a bright rectangular blob is not a real
    # face, so this only proves the session loads and runs end to end
    # (`detect` returns cleanly, whatever it finds — zero faces is a legal
    # answer for a frame with no face in it).
    frame = np.zeros((240, 320, 3), dtype=np.uint8)
    frame[80:160, 120:200] = 200
    detector = YuNetDetector(model_path, frames=[frame])

    detections = detector.detect(0, 0)
    assert isinstance(detections, list)
    for detection in detections:
        assert 0.0 <= detection.x <= 1.0
        assert 0.0 <= detection.y <= 1.0
        assert detection.score >= 0.0
