"""Subject tracking primitives for B19's reframe/zoom passes.

This module is pure and dependency-light on purpose (numpy only): it never
opens a video file or a model - a caller hands it per-frame detections (from
whatever detector it wants: a real face model, a saliency map, a synthetic
test fixture) and gets back a smoothed subject-centre track. That split is
what makes ``IouTracker``/``OneEuroFilter``/``track_subject`` fast to
property-test and reusable by both the zoom pass (a punch-in target) and the
reframe pass (a crop-window centre).

Face detection
---------------

The brief calls for OpenCV's YuNet ONNX face detector. This CPU-only,
no-network-download work package cannot commit or fetch that pinned model
weight (the repo's "no downloads into the repo" rule - the same constraint
A10/B18 worked under), so this module defines ``Detection`` and
``FrameDetector`` as the seam a real YuNet adapter plugs into
(``apps/worker-ai/worker_ai/passes/README.md`` documents the seam and the
gap), and ships ``BrightBlobDetector``, a small OpenCV-free stand-in used by
the synthetic tracking tests (a "face" is the brightest axis-aligned
rectangle in a frame - exactly what the brief's own test fixture draws).
Swapping in a real YuNet session only requires implementing
``FrameDetector.detect``.

Pipeline
--------

1. Per frame, a ``FrameDetector`` returns zero or more ``Detection``\\ s.
2. ``IouTracker`` links detections across frames into one running track by
   intersection-over-union overlap with the previous frame's chosen box.
3. Multi-face frames pick the *speaking* track when a diarisation overlap is
   given (via ``speaking_speaker_at``), else the largest box.
4. When a frame has no detection, the previous known centre carries forward
   (a static hold, not a jump to frame-centre).
5. When a scene has no detection at all, the whole scene falls back to the
   saliency centre, ``(0.5, 0.5)`` by default.
6. The resulting raw per-frame centre is smoothed with a one-euro filter
   (``OneEuroFilter``), tuned for camera-motion cadence rather than cursor
   speed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "BrightBlobDetector",
    "Detection",
    "FrameDetector",
    "IouTracker",
    "OneEuroFilter",
    "SubjectPoint",
    "iou",
    "track_subject",
]


@dataclass(frozen=True, slots=True)
class Detection:
    """One detector output, one frame. Box is (x, y, w, h), normalised 0..1."""

    t_ms: int
    x: float
    y: float
    w: float
    h: float
    score: float = 1.0
    speaker_id: str | None = None

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)


@dataclass(frozen=True, slots=True)
class SubjectPoint:
    """One smoothed subject-centre sample."""

    t_ms: int
    cx: float
    cy: float
    #: True when this sample came from the saliency fallback (no detection).
    fallback: bool = False


def iou(a: Detection, b: Detection) -> float:
    """Intersection-over-union of two normalised boxes."""
    ax0, ay0, ax1, ay1 = a.x, a.y, a.x + a.w, a.y + a.h
    bx0, by0, bx1, by1 = b.x, b.y, b.x + b.w, b.y + b.h
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    union = a.area + b.area - inter
    if union <= 0:
        return 0.0
    return inter / union


class OneEuroFilter:
    """The One Euro Filter (Casiez, Roussel, Vogel 2012): adaptive low-pass
    smoothing that stays tight on slow motion and loosens on fast motion, so a
    subject track neither jitters when still nor lags when it moves quickly.
    """

    def __init__(
        self, *, min_cutoff: float = 1.0, beta: float = 0.02, d_cutoff: float = 1.0
    ) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x_prev: float | None = None
        self._dx_prev = 0.0
        self._t_prev: float | None = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt) if dt > 0 else 1.0

    def __call__(self, t_seconds: float, value: float) -> float:
        if self._t_prev is None:
            self._x_prev = value
            self._t_prev = t_seconds
            return value
        dt = max(1e-6, t_seconds - self._t_prev)
        dx = (value - (self._x_prev if self._x_prev is not None else value)) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        dx_hat = a_d * dx + (1 - a_d) * self._dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = self._alpha(cutoff, dt)
        x_hat = a * value + (1 - a) * (self._x_prev if self._x_prev is not None else value)
        self._x_prev = x_hat
        self._dx_prev = dx_hat
        self._t_prev = t_seconds
        return x_hat


class FrameDetector:
    """The seam a real face/subject detector plugs into. ``detect`` returns
    every box found in one frame (an empty list is a legal "nothing found").
    """

    def detect(self, frame_index: int, t_ms: int) -> list[Detection]:  # pragma: no cover - seam
        raise NotImplementedError


@dataclass
class BrightBlobDetector(FrameDetector):
    """Finds the brightest axis-aligned rectangle in a numpy grayscale frame.

    Stand-in for YuNet (see the module docstring) used by the synthetic
    "moving rectangle face" tests: it thresholds on ``brightness_threshold``,
    takes the bounding box of the surviving pixels, and returns it as one
    ``Detection`` per frame (a frame with nothing above threshold yields no
    detection, matching a real detector's "no face this frame").
    """

    frames: list[Any] = field(default_factory=list)
    frame_interval_ms: int = 200  # 5 fps, per the brief
    brightness_threshold: float = 0.6

    def detect(self, frame_index: int, t_ms: int) -> list[Detection]:
        import numpy as np

        if frame_index >= len(self.frames):
            return []
        frame = self.frames[frame_index]
        mask = frame >= self.brightness_threshold
        ys, xs = np.nonzero(mask)
        if ys.size == 0:
            return []
        height, width = frame.shape[:2]
        x0, x1 = float(xs.min()), float(xs.max()) + 1
        y0, y1 = float(ys.min()), float(ys.max()) + 1
        return [
            Detection(
                t_ms=t_ms,
                x=x0 / width,
                y=y0 / height,
                w=(x1 - x0) / width,
                h=(y1 - y0) / height,
                score=1.0,
            )
        ]


class IouTracker:
    """Links per-frame detections into one running track by IoU overlap with
    the previous frame's chosen detection. Multi-face frames are resolved to
    one detection per frame *before* linking (speaking-speaker overlap, else
    largest box) - this tracker only ever sees one candidate box per frame.
    """

    def __init__(self, *, min_iou: float = 0.05) -> None:
        self.min_iou = min_iou
        self._last: Detection | None = None

    def link(self, detections: list[Detection]) -> Detection | None:
        if not detections:
            self._last = None
            return None
        if self._last is None or len(detections) == 1:
            chosen = max(detections, key=lambda d: d.area)
        else:
            last = self._last
            chosen = max(detections, key=lambda d: iou(last, d))
            if iou(last, chosen) < self.min_iou:
                chosen = max(detections, key=lambda d: d.area)
        self._last = chosen
        return chosen


def _select_frame_detection(
    detections: list[Detection], speaking_speaker_id: str | None
) -> Detection | None:
    """Multi-face resolution: the speaking face by diarisation overlap, else the
    largest. A single detection is returned unchanged.
    """
    if not detections:
        return None
    if len(detections) == 1:
        return detections[0]
    if speaking_speaker_id is not None:
        speaking = [d for d in detections if d.speaker_id == speaking_speaker_id]
        if speaking:
            return max(speaking, key=lambda d: d.area)
    return max(detections, key=lambda d: d.area)


def track_subject(
    frames: list[tuple[int, list[Detection]]],
    *,
    speaking_speaker_at: dict[int, str] | None = None,
    saliency_center: tuple[float, float] = (0.5, 0.5),
    min_cutoff: float = 1.0,
    beta: float = 0.02,
) -> list[SubjectPoint]:
    """Build one smoothed subject-centre track from ``(t_ms, detections)`` frames.

    ``speaking_speaker_at`` maps ``t_ms`` to the speaker id judged to be
    speaking at that moment (from diarisation), consulted only on multi-face
    frames. A scene with no detection anywhere in ``frames`` returns the
    saliency centre at every sample (``fallback=True``); a scene with at
    least one detection holds the last known centre across any gap.
    """
    speaking_speaker_at = speaking_speaker_at or {}
    any_detection = any(dets for _, dets in frames)

    filter_x = OneEuroFilter(min_cutoff=min_cutoff, beta=beta)
    filter_y = OneEuroFilter(min_cutoff=min_cutoff, beta=beta)
    tracker = IouTracker()

    last_cx, last_cy = saliency_center
    points: list[SubjectPoint] = []
    for t_ms, detections in frames:
        if not any_detection:
            points.append(SubjectPoint(t_ms=t_ms, cx=last_cx, cy=last_cy, fallback=True))
            continue

        speaker = speaking_speaker_at.get(t_ms)
        chosen = _select_frame_detection(detections, speaker)
        linked = tracker.link([chosen] if chosen is not None else [])
        fallback = linked is None
        if linked is not None:
            last_cx, last_cy = linked.cx, linked.cy

        smoothed_x = filter_x(t_ms / 1000, last_cx)
        smoothed_y = filter_y(t_ms / 1000, last_cy)
        points.append(SubjectPoint(t_ms=t_ms, cx=smoothed_x, cy=smoothed_y, fallback=fallback))
    return points
