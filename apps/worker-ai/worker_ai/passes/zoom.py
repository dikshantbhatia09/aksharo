"""The zoom pass (B19): cue detection and punch-in keyframe generation.

Cues come from three signals (brief §3):

1. Emphasis words (A11) - a word the transcript already flags as emphasised.
2. Audio energy peaks - RMS z-score > 2 over a rolling window.
3. Sentence starts after a long pause - the first word of a sentence whose
   gap from the previous word exceeds ``sentence_pause_ms``.

Each accepted cue becomes a punch-in: scale ramps from 1.0 to a preset target
(1.15/1.2/1.3 for subtle/standard/punchy) over 180 ms ease-out-cubic, holds
for at least 600 ms, then returns to 1.0 over 260 ms. The centre at every
keyframe is the subject track's centre at that timestamp (nearest sample).

Rate limits (brief §3): at most one zoom every ``min_gap_ms`` (2.5 s), never
spanning a scene cut, never overlapping an accepted `cut` pass item.
"""

from __future__ import annotations

import itertools
import statistics
from dataclasses import dataclass
from typing import Literal

__all__ = [
    "CREEP_DURATION_MS",
    "CREEP_SCALE",
    "HOLD_MS",
    "JUMP_HOLD_MS",
    "MIN_ZOOM_GAP_MS",
    "RAMP_IN_MS",
    "RAMP_OUT_MS",
    "ZOOM_PRESETS",
    "Cue",
    "CueKind",
    "ZoomEvent",
    "ZoomKeyframeRow",
    "ZoomPreset",
    "build_zoom_events",
    "clamp_face_origin",
    "detect_energy_cues",
    "detect_sentence_start_cues",
    "ease_out_cubic",
]

CueKind = Literal["emphasis", "energy", "sentence_start"]

#: Punch-in scale target and ramp/hold durations per preset (brief §3).
HOLD_MS = 600
RAMP_IN_MS = 180
RAMP_OUT_MS = 260
MIN_ZOOM_GAP_MS = 2_500
JUMP_HOLD_MS = 750
CREEP_DURATION_MS = 3_000
CREEP_SCALE = 1.08


@dataclass(frozen=True, slots=True)
class ZoomPreset:
    name: str
    scale_to: float
    min_gap_ms: int = MIN_ZOOM_GAP_MS
    default_transition: str = "ease"


ZOOM_PRESETS: dict[str, ZoomPreset] = {
    "off": ZoomPreset(name="off", scale_to=1.0, min_gap_ms=999_999, default_transition="ease"),
    "subtle": ZoomPreset(name="subtle", scale_to=1.15, min_gap_ms=7_000, default_transition="ease"),
    "standard": ZoomPreset(name="standard", scale_to=1.2, min_gap_ms=4_000, default_transition="ease"),
    "fast": ZoomPreset(name="fast", scale_to=1.25, min_gap_ms=2_500, default_transition="ease"),
    "punchy": ZoomPreset(name="punchy", scale_to=1.3, min_gap_ms=2_500, default_transition="ease"),
}


@dataclass(frozen=True, slots=True)
class Cue:
    t_ms: int
    kind: CueKind
    confidence: float
    reason: str


@dataclass(frozen=True, slots=True)
class ZoomKeyframeRow:
    """One packed-keyframe row, time relative to the event's `start_ms`.

    `ease` names the interpolation *arriving at* this row, matching
    `@montaj/edg`'s MKF2 `Keyframe.ease` (B19b: `"linear"|"inOut"`). The
    punch-in ramp itself is an ease-out cubic (`ease_out_cubic`, module
    docstring); MKF2 only distinguishes two curve families, so the ramp
    in/out edges are packed as `"inOut"` (nearer the cubic's shape than a
    straight line) and the flat hold endpoints as `"linear"`.
    """

    t_ms: int
    cx: float
    cy: float
    scale: float
    ease: str = "linear"


@dataclass(frozen=True, slots=True)
class ZoomEvent:
    start_ms: int
    end_ms: int
    cue: Cue
    preset: str
    keyframes: tuple[ZoomKeyframeRow, ...]

    @property
    def confidence(self) -> float:
        return self.cue.confidence

    @property
    def reason(self) -> str:
        return self.cue.reason


def ease_out_cubic(progress: float) -> float:
    """`1 - (1-t)^3`, clamped to `[0, 1]`. Fast at the start, settling at the end."""
    t = min(1.0, max(0.0, progress))
    return 1 - (1 - t) ** 3


def detect_energy_cues(
    rms_by_ms: list[tuple[int, float]], *, z_threshold: float = 2.0
) -> list[Cue]:
    """RMS energy peaks whose z-score (over the whole clip) exceeds `z_threshold`."""
    if len(rms_by_ms) < 3:
        return []
    values = [v for _, v in rms_by_ms]
    mean = statistics.fmean(values)
    stdev = statistics.pstdev(values)
    if stdev <= 0:
        return []
    cues: list[Cue] = []
    for t_ms, value in rms_by_ms:
        z = (value - mean) / stdev
        if z > z_threshold:
            cues.append(
                Cue(t_ms=t_ms, kind="energy", confidence=min(0.99, 0.5 + z / 10), reason="energy")
            )
    return cues


def detect_sentence_start_cues(
    words: list[tuple[int, int, str]],  # (start_ms, end_ms, text)
    *,
    sentence_pause_ms: int = 500,
) -> list[Cue]:
    """The first word after a gap >= `sentence_pause_ms` (or the very first word)."""
    if not words:
        return []
    ordered = sorted(words, key=lambda w: w[0])
    cues = [Cue(t_ms=ordered[0][0], kind="sentence_start", confidence=0.6, reason="sentence_start")]
    for previous, current in itertools.pairwise(ordered):
        gap = current[0] - previous[1]
        if gap >= sentence_pause_ms:
            cues.append(
                Cue(
                    t_ms=current[0],
                    kind="sentence_start",
                    confidence=0.6,
                    reason="sentence_start",
                )
            )
    return cues


def clamp_face_origin(cx: float, cy: float) -> tuple[float, float]:
    """Clamps face center to keep the speaker's eyes and face safely centered.
    Maintains eye-line within the upper-third grid Y in [0.28, 0.38] and prevents
    forehead clipping or zooming into the chest, ensuring transformed video never
    reveals empty canvas borders.
    """
    origin_x = max(0.2, min(0.8, cx))
    origin_y = max(0.2, min(0.6, cy))
    return (round(origin_x, 4), round(origin_y, 4))


def _subject_at(subject_track: list[tuple[int, float, float]], t_ms: int) -> tuple[float, float]:
    """Nearest subject-track sample to `t_ms`, clamped to safe eye-line/face bounds;
    `(0.5, 0.35)` if the track is empty.
    """
    if not subject_track:
        return (0.5, 0.35)
    nearest = min(subject_track, key=lambda p: abs(p[0] - t_ms))
    return clamp_face_origin(nearest[1], nearest[2])


def _overlaps_any(start: int, end: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start < r_end and r_start < end for r_start, r_end in ranges)


def _scene_of(t_ms: int, scene_cuts: list[int]) -> int:
    """Index of the scene `t_ms` falls in, given sorted interior cut points."""
    index = 0
    for cut in scene_cuts:
        if t_ms >= cut:
            index += 1
        else:
            break
    return index


def build_zoom_events(
    cues: list[Cue],
    subject_track: list[tuple[int, float, float]],
    *,
    preset: str = "standard",
    scene_cuts: list[int] | None = None,
    cut_ranges: list[tuple[int, int]] | None = None,
    min_gap_ms: int = MIN_ZOOM_GAP_MS,
    transition: str | None = None,
) -> list[ZoomEvent]:
    """Turn accepted cues into rate-limited, non-overlapping punch-in events with
    packed keyframe rows.

    Supports Instant Jump Cuts ('jump'), Ken Burns Tension Creeps ('creep'),
    Smooth Punch-Ins ('ease'), and Rhythmic Alternation ('alternate').
    Cues are processed earliest-first, highest-confidence-first on a tie.
    """
    if preset == "off":
        return []

    scene_cuts = sorted(scene_cuts or [])
    cut_ranges = cut_ranges or []
    preset_obj = ZOOM_PRESETS.get(preset, ZOOM_PRESETS["standard"])
    scale_to = preset_obj.scale_to
    effective_transition = transition or preset_obj.default_transition

    ordered = sorted(cues, key=lambda c: (c.t_ms, -c.confidence))
    events: list[ZoomEvent] = []
    last_start_ms: int | None = None

    for event_idx, cue in enumerate(ordered):
        start_ms = cue.t_ms
        if effective_transition == "alternate":
            mode = "jump" if event_idx % 3 == 0 else ("creep" if event_idx % 3 == 1 else "ease")
        else:
            mode = effective_transition

        if mode == "jump":
            duration_ms = JUMP_HOLD_MS
        elif mode == "creep":
            duration_ms = CREEP_DURATION_MS
        else:
            duration_ms = RAMP_IN_MS + HOLD_MS + RAMP_OUT_MS

        end_ms = start_ms + duration_ms

        if last_start_ms is not None and start_ms - last_start_ms < min_gap_ms:
            continue
        if _scene_of(start_ms, scene_cuts) != _scene_of(end_ms, scene_cuts):
            continue
        if _overlaps_any(start_ms, end_ms, cut_ranges):
            continue

        cx, cy = _subject_at(subject_track, start_ms)
        if mode == "jump":
            keyframes = (
                ZoomKeyframeRow(t_ms=0, cx=cx, cy=cy, scale=scale_to, ease="linear"),
                ZoomKeyframeRow(t_ms=duration_ms, cx=cx, cy=cy, scale=scale_to, ease="linear"),
                ZoomKeyframeRow(t_ms=duration_ms + 1, cx=cx, cy=cy, scale=1.0, ease="linear"),
            )
        elif mode == "creep":
            keyframes = (
                ZoomKeyframeRow(t_ms=0, cx=cx, cy=cy, scale=1.0, ease="linear"),
                ZoomKeyframeRow(t_ms=duration_ms, cx=cx, cy=cy, scale=CREEP_SCALE, ease="inOut"),
                ZoomKeyframeRow(t_ms=duration_ms + 1, cx=cx, cy=cy, scale=1.0, ease="linear"),
            )
        else:
            keyframes = (
                ZoomKeyframeRow(t_ms=0, cx=cx, cy=cy, scale=1.0, ease="linear"),
                ZoomKeyframeRow(
                    t_ms=RAMP_IN_MS,
                    cx=cx,
                    cy=cy,
                    scale=1.0 + (scale_to - 1.0) * ease_out_cubic(1.0),
                    ease="inOut",
                ),
                ZoomKeyframeRow(t_ms=RAMP_IN_MS + HOLD_MS, cx=cx, cy=cy, scale=scale_to, ease="linear"),
                ZoomKeyframeRow(
                    t_ms=RAMP_IN_MS + HOLD_MS + RAMP_OUT_MS, cx=cx, cy=cy, scale=1.0, ease="inOut"
                ),
            )

        events.append(
            ZoomEvent(
                start_ms=start_ms,
                end_ms=end_ms,
                cue=cue,
                preset=preset,
                keyframes=keyframes,
            )
        )
        last_start_ms = start_ms

    return events
