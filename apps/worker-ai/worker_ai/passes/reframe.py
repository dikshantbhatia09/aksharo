"""The reframe pass (B19): 16:9 to 9:16/1:1 crop-window tracking.

Builds a crop-window centre track from the subject track (`tracking.py`),
sampled at 10 Hz, with:

- a deadzone (8% of the source width, brief default) inside which the crop
  does not move at all - this is what keeps a talking head from jittering the
  frame on every small head turn;
- a maximum pan velocity cap, so the window catches up to a subject who moves
  out of the deadzone smoothly rather than snapping;
- a hard cut (no pan) on every scene change - the window jumps straight to
  the new scene's subject position;
- a `letterbox` flag on any scene judged "multi-subject wide shot" (more than
  one detection sustained across the scene, none dominant), where a crop
  cannot represent the shot faithfully and the caller should fall back to a
  letterboxed full-frame crop instead of tracking one subject arbitrarily.

The 10 Hz sample track is then simplified with Ramer-Douglas-Peucker so the
packed keyframe curve only carries the points that shape the pan, not a flat
run of collinear samples.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = [
    "ReframeKeyframeRow",
    "ReframeResult",
    "build_reframe_track",
    "clamp_crop_window",
    "rdp_simplify",
]

SAMPLE_HZ = 10
SAMPLE_INTERVAL_MS = 1000 // SAMPLE_HZ
DEFAULT_DEADZONE_FRACTION = 0.08


@dataclass(frozen=True, slots=True)
class ReframeKeyframeRow:
    t_ms: int
    cx: float
    cy: float
    scale: float


@dataclass(frozen=True, slots=True)
class ReframeResult:
    keyframes: tuple[ReframeKeyframeRow, ...]
    #: Scenes (by index into `scene_ranges`) flagged as multi-subject wide
    #: shots, where the caller should letterbox instead of crop-tracking.
    letterbox_scenes: tuple[int, ...]


def clamp_crop_window(center: float, window_fraction: float) -> float:
    """Clamp a crop window's centre (as a fraction of the source dimension) so
    the window of width/height `window_fraction` never runs off either edge.
    """
    half = window_fraction / 2
    return min(1 - half, max(half, center))


def _target_scale(source_aspect: float, target_aspect: float) -> float:
    """How much wider than the crop window the source frame is, along the axis
    the crop must move in. `source_aspect`/`target_aspect` are width/height.
    Only horizontal panning is modelled (16:9 source -> 9:16/1:1 target: the
    full source height is kept, the crop pans horizontally) - the brief's
    named targets are both narrower-than-source aspects.
    """
    if target_aspect <= 0:
        return 1.0
    return max(1.0, source_aspect / target_aspect)


def build_reframe_track(
    subject_track: list[tuple[int, float, float]],
    *,
    scene_ranges: list[tuple[int, int]],
    multi_subject_scenes: set[int] | None = None,
    source_aspect: float = 16 / 9,
    target_aspect: float = 9 / 16,
    deadzone_fraction: float = DEFAULT_DEADZONE_FRACTION,
    max_velocity_per_s: float = 0.8,
    rdp_epsilon: float = 0.01,
) -> ReframeResult:
    """Build the reframe keyframe curve.

    `subject_track` must be sorted ascending by `t_ms` and cover the whole
    clip (as `track_subject` produces). `scene_ranges` are `[start, end)` ms
    windows (as `scenes.scene_ranges` produces); the crop hard-cuts to the new
    scene's subject position at every boundary. `multi_subject_scenes` names
    scene *indices* to flag `letterbox` for.
    """
    multi_subject_scenes = multi_subject_scenes or set()
    if not subject_track or not scene_ranges:
        return ReframeResult(keyframes=(), letterbox_scenes=())

    scale = _target_scale(source_aspect, target_aspect)
    window_fraction = 1.0 / scale
    max_step = max_velocity_per_s * (SAMPLE_INTERVAL_MS / 1000)

    samples: list[tuple[int, float]] = []
    current_cx: float | None = None

    for scene_start, scene_end in scene_ranges:
        first_sample_ms = scene_start
        t_ms = first_sample_ms
        while t_ms < scene_end:
            target_cx = _subject_center_at(subject_track, t_ms)
            if t_ms == first_sample_ms:
                # Hard cut at every scene boundary (including the first scene).
                current_cx = target_cx
            elif current_cx is not None:
                deviation = target_cx - current_cx
                if abs(deviation) > deadzone_fraction / 2:
                    edge = deadzone_fraction / 2 if deviation > 0 else -deadzone_fraction / 2
                    desired_step = deviation - edge
                    step = max(-max_step, min(max_step, desired_step))
                    current_cx = current_cx + step
            resolved_cx: float = current_cx if current_cx is not None else target_cx
            samples.append((t_ms, clamp_crop_window(resolved_cx, window_fraction)))
            t_ms += SAMPLE_INTERVAL_MS

    simplified = rdp_simplify(samples, epsilon=rdp_epsilon)
    keyframes = tuple(
        ReframeKeyframeRow(t_ms=t_ms, cx=cx, cy=0.5, scale=scale) for t_ms, cx in simplified
    )
    return ReframeResult(
        keyframes=keyframes, letterbox_scenes=tuple(sorted(multi_subject_scenes))
    )


def _subject_center_at(subject_track: list[tuple[int, float, float]], t_ms: int) -> float:
    nearest = min(subject_track, key=lambda p: abs(p[0] - t_ms))
    return nearest[1]


def rdp_simplify(
    points: list[tuple[int, float]], *, epsilon: float
) -> list[tuple[int, float]]:
    """Ramer-Douglas-Peucker line simplification over `(t_ms, value)` points.

    Treats `t_ms` and `value` as a 2D polyline (time is not rescaled against
    value, so `epsilon` is in the same units as `value` — a crop-window centre
    fraction 0..1 — and a curve that is flat in value collapses to its
    endpoints regardless of how long it runs). Endpoints are always kept.
    """
    if len(points) <= 2:
        return list(points)

    def perpendicular_distance(
        point: tuple[int, float], start: tuple[int, float], end: tuple[int, float]
    ) -> float:
        x0, y0 = point
        x1, y1 = start
        x2, y2 = end
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            return float(((x0 - x1) ** 2 + (y0 - y1) ** 2) ** 0.5)
        numerator = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1)
        denominator = (dx**2 + dy**2) ** 0.5
        return float(numerator / denominator)

    def simplify(pts: list[tuple[int, float]]) -> list[tuple[int, float]]:
        if len(pts) <= 2:
            return pts
        start, end = pts[0], pts[-1]
        max_dist = -1.0
        index = 0
        for i in range(1, len(pts) - 1):
            dist = perpendicular_distance(pts[i], start, end)
            if dist > max_dist:
                max_dist = dist
                index = i
        if max_dist > epsilon:
            left = simplify(pts[: index + 1])
            right = simplify(pts[index:])
            return [*left[:-1], *right]
        return [start, end]

    return simplify(points)
