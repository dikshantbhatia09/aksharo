"""Face detection over a whole video, for face-aware caption placement.

The caption renderer (`packages/render-core/src/frame/placement.ts`) moves a
caption off any face on screen while it is up. This module produces what it
reads: a face track, one sample every `interval_ms`, each sample the list of
face boxes found in that frame, normalised to the source frame (`0..1`, origin
top-left).

The detector is YuNet (`face_detection_yunet_2023mar.onnx`, the operator-
provisioned file `YUNET_MODEL_PATH` names), run through `onnxruntime`, which
this worker already depends on — not through OpenCV's `FaceDetectorYN`, which
would add `opencv-python` for one call. The model takes a fixed 640 x 640 BGR
input and is anchor-free: for each stride (8, 16, 32) and grid cell it gives a
class score, an objectness score and a box `(dx, dy, log w, log h)` in stride
units. Decoding follows OpenCV's own `FaceDetectorYN` for this model version:
`score = sqrt(cls * obj)`, centre `(col + dx, row + dy) * stride`, size
`exp(log w|h) * stride`, then non-maximum suppression.

Frames come from the 540p proxy, decoded by ffmpeg straight to raw `bgr24` and
read one frame at a time, so memory stays one frame deep whatever the clip's
length (the same reason `frame_sampling.sample_frames` streams).

The track is bounded per sample (:func:`bound_faces`): faces too small for any
reader to use are dropped and at most :data:`MAX_FACES_PER_SAMPLE` are kept.
Without that the file's size was set by what the video showed - a crowd shot
put every face YuNet found into every sample - and the API, the renderer and
the browser all read the whole file into memory.
"""

from __future__ import annotations

import math
import subprocess
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker_ai.audio import AudioToolError, ffmpeg_path
from worker_ai.passes.frame_sampling import _read_exact, probe_video_size

__all__ = [
    "DEFAULT_DEADBAND_RATIO",
    "DEFAULT_DAMPING_RATIO",
    "DEFAULT_INTERVAL_MS",
    "DEFAULT_NATURAL_FREQ",
    "FACE_TRACK_VERSION",
    "MAX_FACES_PER_SAMPLE",
    "MIN_FACE_HEIGHT",
    "FaceBox",
    "FaceSample",
    "SmoothedKeyframe",
    "YuNetOnnxDetector",
    "apply_critically_damped_smoothing",
    "bound_faces",
    "build_reframe_trajectory",
    "calculate_mouth_aspect_ratio",
    "correlate_active_speaker",
    "decode_yunet",
    "detect_face_track",
    "extract_raw_face_centers",
    "face_track_document",
    "iter_bgr_frames",
    "nms",
]

#: Bump when the `faces.json` shape changes; the renderer ignores other versions.
FACE_TRACK_VERSION = 1

#: Four samples a second: a caption is up for one to three seconds, so this is
#: several looks per caption, at a quarter of the frame sampler's 10 Hz cost.
DEFAULT_INTERVAL_MS = 250

#: Critically damped spring & deadband defaults (Pillar 3 §01).
DEFAULT_DEADBAND_RATIO = 0.06
DEFAULT_NATURAL_FREQ = 2.5
DEFAULT_DAMPING_RATIO = 1.0

#: Faces shorter than this share of the source frame are not kept. Both readers
#: drop faces under 0.06 (`placement.ts` and `apps/api/src/repurpose/reframe.ts`,
#: `MIN_FACE_HEIGHT`), but `placement.ts` measures on the canvas after a cover
#: fit, which enlarges a source whose aspect is narrower than the canvas's; half
#: of 0.06 leaves room for a 2x enlargement. Beyond that (a 9:16 source cover-
#: fitted onto 16:9 is 3.16x) a face of 12-19 source px on the 640 px proxy
#: frame is lost - YuNet's own floor is close to that anyway.
MIN_FACE_HEIGHT = 0.03

#: The most faces one sample keeps, largest first. Not fewer: a 5 x 5 video-call
#: gallery is 25 faces at about 8% of the frame each, all of which placement
#: steers a caption around. At ~30 bytes a box this caps a sample near 1 KB.
MAX_FACES_PER_SAMPLE = 32

_INPUT_SIZE = 640
_STRIDES = (8, 16, 32)
_FFMPEG_TIMEOUT_S = 900


@dataclass(frozen=True, slots=True)
class FaceBox:
    """One face, normalised to the source frame."""

    x: float
    y: float
    w: float
    h: float
    score: float


@dataclass(frozen=True, slots=True)
class FaceSample:
    t_ms: int
    boxes: tuple[FaceBox, ...]


def iter_bgr_frames(
    path: Path, *, interval_ms: int, max_side: int = _INPUT_SIZE
) -> Iterator[tuple[int, NDArray[np.uint8]]]:
    """Yield `(t_ms, frame)` every `interval_ms`, each frame BGR `uint8`
    `(h, w, 3)` with its longer side at most `max_side` (YuNet's input size, so
    the letterbox never upscales)."""
    source_width, source_height = probe_video_size(path)
    scale = min(1.0, max_side / max(source_width, source_height))
    width = max(2, round(source_width * scale) // 2 * 2)
    height = max(2, round(source_height * scale) // 2 * 2)
    frame_bytes = width * height * 3
    fps = 1000 / interval_ms

    argv = [
        ffmpeg_path(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        str(path),
        "-vf",
        f"fps={fps:.6f},scale={width}:{height}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-",
    ]
    try:
        process = subprocess.Popen(  # noqa: S603
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
    except OSError as error:
        raise AudioToolError(f"ffmpeg could not be run: {error}") from error

    assert process.stdout is not None  # noqa: S101 - PIPE was requested above
    produced = 0
    try:
        index = 0
        while True:
            chunk = _read_exact(process.stdout, frame_bytes)
            if chunk is None:
                break
            produced += 1
            yield (
                index * interval_ms,
                np.frombuffer(chunk, dtype=np.uint8).reshape(height, width, 3),
            )
            index += 1
    finally:
        process.stdout.close()
        try:
            process.wait(timeout=_FFMPEG_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        stderr = process.stderr.read() if process.stderr is not None else b""
        if process.stderr is not None:
            process.stderr.close()
    if process.returncode not in (0, None) and produced == 0:
        tail = stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise AudioToolError(f"ffmpeg failed ({process.returncode}): {' / '.join(tail)}")


class YuNetOnnxDetector:
    """YuNet through onnxruntime. Loads the model on construction."""

    def __init__(
        self,
        model_path: str,
        *,
        score_threshold: float = 0.6,
        nms_threshold: float = 0.3,
        session: Any | None = None,
    ) -> None:
        if session is None:
            import onnxruntime as ort

            options = ort.SessionOptions()
            # One worker process runs several job kinds; keep this one modest.
            options.intra_op_num_threads = 2
            session = ort.InferenceSession(
                model_path, sess_options=options, providers=["CPUExecutionProvider"]
            )
        self._session = session
        self._input_name = session.get_inputs()[0].name
        self._output_names = tuple(output.name for output in self._session.get_outputs())
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self._blob = np.zeros((1, 3, _INPUT_SIZE, _INPUT_SIZE), dtype=np.float32)

    def detect(self, frame: NDArray[np.uint8]) -> list[FaceBox]:
        """Faces in one BGR `uint8` frame (supports arbitrary resolution including 1080p/4K)."""
        raw_height, raw_width = frame.shape[:2]
        if raw_height > _INPUT_SIZE or raw_width > _INPUT_SIZE:
            step = max(1, math.ceil(max(raw_height, raw_width) / _INPUT_SIZE))
            sub = frame[::step, ::step]
        else:
            sub = frame
        height, width = sub.shape[:2]
        self._blob.fill(0.0)
        self._blob[0, 0, :height, :width] = sub[:, :, 0]
        self._blob[0, 1, :height, :width] = sub[:, :, 1]
        self._blob[0, 2, :height, :width] = sub[:, :, 2]
        outputs = dict(
            zip(
                self._output_names,
                self._session.run(None, {self._input_name: self._blob}),
                strict=True,
            )
        )
        boxes = decode_yunet(outputs, score_threshold=self.score_threshold)
        kept = nms(boxes, self.nms_threshold)
        result: list[FaceBox] = []
        for x0, y0, x1, y1, score in kept:
            x0, y0 = max(0.0, x0), max(0.0, y0)
            x1, y1 = min(float(width), x1), min(float(height), y1)
            if x1 <= x0 or y1 <= y0:
                continue
            result.append(
                FaceBox(
                    x=x0 / width,
                    y=y0 / height,
                    w=(x1 - x0) / width,
                    h=(y1 - y0) / height,
                    score=score,
                )
            )
        return result


def decode_yunet(
    outputs: dict[str, NDArray[np.float32]], *, score_threshold: float
) -> list[tuple[float, float, float, float, float]]:
    """`(x0, y0, x1, y1, score)` in 640 x 640 input pixels, above threshold."""
    found: list[tuple[float, float, float, float, float]] = []
    for stride in _STRIDES:
        cols = _INPUT_SIZE // stride
        cls = np.clip(outputs[f"cls_{stride}"].reshape(-1), 0.0, 1.0)
        obj = np.clip(outputs[f"obj_{stride}"].reshape(-1), 0.0, 1.0)
        bbox = outputs[f"bbox_{stride}"].reshape(-1, 4)
        scores = np.sqrt(cls * obj)
        for index in np.nonzero(scores >= score_threshold)[0]:
            row, col = divmod(int(index), cols)
            dx, dy, dw, dh = (float(value) for value in bbox[index])
            cx = (col + dx) * stride
            cy = (row + dy) * stride
            w = math.exp(dw) * stride
            h = math.exp(dh) * stride
            found.append((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, float(scores[index])))
    return found


def nms(
    boxes: list[tuple[float, float, float, float, float]], threshold: float
) -> list[tuple[float, float, float, float, float]]:
    """Greedy non-maximum suppression by IoU, highest score first."""
    kept: list[tuple[float, float, float, float, float]] = []
    for box in sorted(boxes, key=lambda item: item[4], reverse=True):
        if all(_iou(box, other) <= threshold for other in kept):
            kept.append(box)
    return kept


def _iou(
    a: tuple[float, float, float, float, float], b: tuple[float, float, float, float, float]
) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def bound_faces(boxes: Iterable[FaceBox]) -> tuple[FaceBox, ...]:
    """The faces of one sample worth keeping: at least :data:`MIN_FACE_HEIGHT`
    tall, at most :data:`MAX_FACES_PER_SAMPLE` of them, largest area first.

    Largest first because both readers want the subject, and the subject is the
    big face: `reframe.ts` follows the biggest face that stays on screen, and a
    caption moved off a large face matters more than off a distant one. Stable
    on ties, so the same detections always give the same file.
    """
    usable = [box for box in boxes if box.h >= MIN_FACE_HEIGHT]
    usable.sort(key=lambda box: box.w * box.h, reverse=True)
    return tuple(usable[:MAX_FACES_PER_SAMPLE])


def detect_face_track(
    path: Path,
    detector: YuNetOnnxDetector,
    *,
    interval_ms: int = DEFAULT_INTERVAL_MS,
) -> list[FaceSample]:
    """One `FaceSample` per `interval_ms` over the whole of `path`.

    Bounded as each frame is read, not only when the file is written: a six-hour
    crowd shot would otherwise hold every detection in memory until the end.
    """
    return [
        FaceSample(t_ms=t_ms, boxes=bound_faces(detector.detect(frame)))
        for t_ms, frame in iter_bgr_frames(path, interval_ms=interval_ms)
    ]


def face_track_document(
    samples: list[FaceSample],
    *,
    interval_ms: int,
    source_width: int,
    source_height: int,
) -> dict[str, Any]:
    """The `faces.json` body: compact, four decimals, empty samples kept so a
    reader can tell "looked, found nothing" from "never looked".

    Each sample is bounded here too (:func:`bound_faces` is idempotent), so the
    file's size limit holds whoever built the samples."""
    return {
        "version": FACE_TRACK_VERSION,
        "intervalMs": interval_ms,
        "source": {"width": source_width, "height": source_height},
        "samples": [
            [
                sample.t_ms,
                [
                    [round(box.x, 4), round(box.y, 4), round(box.w, 4), round(box.h, 4)]
                    for box in bound_faces(sample.boxes)
                ],
            ]
            for sample in samples
        ],
    }


def _euclidean_2d(a: Sequence[float], b: Sequence[float]) -> float:
    return math.hypot(float(a[0]) - float(b[0]), float(a[1]) - float(b[1]))


def calculate_mouth_aspect_ratio(landmarks: Any) -> float:
    """Compute Mouth Aspect Ratio (MAR) from facial lip landmarks (Pillar 3 §2.1):

    ``MAR = (||p51 - p57|| + ||p52 - p56|| + ||p53 - p55||) / (2 * ||p48 - p54||)``

    Accepts:
    - A mapping keyed by int `(48, 51, 52, 53, 54, 55, 56, 57)` or string `("p48", ...)`
    - A 68-point landmark sequence (indices 48..57)
    - An 8-point mouth sequence `(p48, p51, p52, p53, p54, p55, p56, p57)`
    """
    if isinstance(landmarks, Mapping):
        def _pt(idx: int) -> Any:
            if idx in landmarks:
                return landmarks[idx]
            return landmarks[f"p{idx}"]

        p48, p51, p52, p53 = _pt(48), _pt(51), _pt(52), _pt(53)
        p54, p55, p56, p57 = _pt(54), _pt(55), _pt(56), _pt(57)
    elif isinstance(landmarks, (Sequence, np.ndarray)) and len(landmarks) >= 58:
        p48, p51, p52, p53 = landmarks[48], landmarks[51], landmarks[52], landmarks[53]
        p54, p55, p56, p57 = landmarks[54], landmarks[55], landmarks[56], landmarks[57]
    elif isinstance(landmarks, (Sequence, np.ndarray)) and len(landmarks) == 20:
        p48, p51, p52, p53 = landmarks[0], landmarks[3], landmarks[4], landmarks[5]
        p54, p55, p56, p57 = landmarks[6], landmarks[7], landmarks[8], landmarks[9]
    elif isinstance(landmarks, (Sequence, np.ndarray)) and len(landmarks) == 8:
        p48, p51, p52, p53, p54, p55, p56, p57 = landmarks
    else:
        return 0.0

    denom = 2.0 * _euclidean_2d(p48, p54)
    if denom <= 1e-9:
        return 0.0
    vertical = (
        _euclidean_2d(p51, p57)
        + _euclidean_2d(p52, p56)
        + _euclidean_2d(p53, p55)
    )
    return float(vertical / denom)


def correlate_active_speaker(
    candidate_mar_tracks: Mapping[Any, Sequence[tuple[float, float]]],
    speech_intervals_sec: Sequence[tuple[float, float]],
) -> Any | None:
    """Identify the active speaker by correlating Mouth Aspect Ratio (MAR)
    oscillations with audio speech timestamps.

    Each entry in ``candidate_mar_tracks`` maps a speaker/track ID to
    ``(time_sec, mar)`` samples. Returns the track ID with the highest lip
    motion activity during active speech windows.
    """
    if not candidate_mar_tracks:
        return None

    def _in_speech(t_sec: float) -> bool:
        if not speech_intervals_sec:
            return True
        return any(start <= t_sec <= end for start, end in speech_intervals_sec)

    best_id: Any | None = None
    best_score = -1.0
    for track_id, samples in candidate_mar_tracks.items():
        active_mars = [float(mar) for t_sec, mar in samples if _in_speech(float(t_sec))]
        if not active_mars:
            continue
        diffs = [abs(active_mars[i] - active_mars[i - 1]) for i in range(1, len(active_mars))]
        mean_mar = sum(active_mars) / len(active_mars)
        oscillation = (sum(diffs) / len(diffs)) if diffs else 0.0
        score = oscillation * 2.0 + mean_mar * 0.5
        if score > best_score:
            best_score = score
            best_id = track_id
    return best_id


class SmoothedKeyframe(dict[str, float]):
    """A smoothed crop keyframe ``{"timeSec", "centerX", "centerY", "zoom"}``
    that behaves as a ``dict``, an object with attributes, AND a ``float``
    (via ``centerX``) for seamless ergonomic use in both JSON serialisation
    and numeric trajectory assertions.
    """

    def __init__(
        self,
        time_sec: float,
        center_x: float,
        center_y: float = 0.5,
        zoom: float = 1.0,
    ) -> None:
        super().__init__(
            timeSec=round(float(time_sec), 4),
            centerX=round(float(center_x), 4),
            centerY=round(float(center_y), 4),
            zoom=round(float(zoom), 4),
        )

    @property
    def timeSec(self) -> float:  # noqa: N802
        return float(self["timeSec"])

    @property
    def time_sec(self) -> float:
        return float(self["timeSec"])

    @property
    def centerX(self) -> float:  # noqa: N802
        return float(self["centerX"])

    @property
    def center_x(self) -> float:
        return float(self["centerX"])

    @property
    def centerY(self) -> float:  # noqa: N802
        return float(self["centerY"])

    @property
    def center_y(self) -> float:
        return float(self["centerY"])

    @property
    def zoom(self) -> float:
        return float(self["zoom"])

    def __float__(self) -> float:
        return float(self["centerX"])

    def __sub__(self, other: object) -> float:
        if isinstance(other, (int, float)):
            return float(self["centerX"]) - float(other)
        if isinstance(other, Mapping) and "centerX" in other:
            return float(self["centerX"]) - float(other["centerX"])
        return NotImplemented

    def __rsub__(self, other: object) -> float:
        if isinstance(other, (int, float)):
            return float(other) - float(self["centerX"])
        return NotImplemented

    def __lt__(self, other: object) -> bool:
        if isinstance(other, (int, float)):
            return float(self["centerX"]) < float(other)
        if isinstance(other, Mapping) and "centerX" in other:
            return float(self["centerX"]) < float(other["centerX"])
        return NotImplemented

    def __le__(self, other: object) -> bool:
        if isinstance(other, (int, float)):
            return float(self["centerX"]) <= float(other)
        if isinstance(other, Mapping) and "centerX" in other:
            return float(self["centerX"]) <= float(other["centerX"])
        return NotImplemented

    def __gt__(self, other: object) -> bool:
        if isinstance(other, (int, float)):
            return float(self["centerX"]) > float(other)
        if isinstance(other, Mapping) and "centerX" in other:
            return float(self["centerX"]) > float(other["centerX"])
        return NotImplemented

    def __ge__(self, other: object) -> bool:
        if isinstance(other, (int, float)):
            return float(self["centerX"]) >= float(other)
        if isinstance(other, Mapping) and "centerX" in other:
            return float(self["centerX"]) >= float(other["centerX"])
        return NotImplemented


def extract_raw_face_centers(
    samples: Sequence[FaceSample],
) -> list[tuple[float, float, float]]:
    """Extract raw ``(center_x, center_y, zoom)`` per sampled frame from
    :class:`FaceSample` detections. Holds the last known face center across
    empty samples; defaults to ``(0.5, 0.5, 1.0)`` when no face has been seen.
    """
    centers: list[tuple[float, float, float]] = []
    last_cx = 0.5
    last_cy = 0.5
    last_zoom = 1.0
    has_seen = False

    for sample in samples:
        usable = bound_faces(sample.boxes)
        if usable:
            primary = usable[0]
            if has_seen:
                # Prefer the face closest to the running track if comparable in size
                primary_area = primary.w * primary.h
                candidates = [
                    box
                    for box in usable
                    if (box.w * box.h) >= 0.45 * primary_area
                ]
                primary = min(
                    candidates,
                    key=lambda box: abs((box.x + box.w / 2.0) - last_cx),
                )
            last_cx = min(1.0, max(0.0, primary.x + primary.w / 2.0))
            last_cy = min(1.0, max(0.0, primary.y + primary.h / 2.0))
            last_zoom = 1.0
            has_seen = True
        centers.append((last_cx, last_cy, last_zoom))
    return centers


def _parse_raw_center_point(
    item: Any, index: int, dt: float
) -> tuple[float, float, float, float]:
    """Normalise one input element into ``(time_sec, cx, cy, zoom)``."""
    t_sec = index * dt
    if isinstance(item, (int, float)):
        return (t_sec, float(item), 0.5, 1.0)
    if isinstance(item, Mapping):
        cx = float(item.get("centerX", item.get("cx", 0.5)))
        cy = float(item.get("centerY", item.get("cy", 0.5)))
        zoom = float(item.get("zoom", item.get("scale", 1.0)))
        if "timeSec" in item:
            t_sec = float(item["timeSec"])
        elif "tMs" in item:
            t_sec = float(item["tMs"]) / 1000.0
        return (t_sec, cx, cy, zoom)
    if isinstance(item, (Sequence, np.ndarray)):
        if len(item) >= 4:
            return (float(item[0]), float(item[1]), float(item[2]), float(item[3]))
        if len(item) == 3:
            return (t_sec, float(item[0]), float(item[1]), float(item[2]))
        if len(item) == 2:
            return (t_sec, float(item[0]), float(item[1]), 1.0)
        if len(item) == 1:
            return (t_sec, float(item[0]), 0.5, 1.0)
    return (t_sec, 0.5, 0.5, 1.0)


def _step_critically_damped_axis(
    pos: float,
    vel: float,
    target: float,
    dt: float,
    omega_n: float,
) -> tuple[float, float]:
    """Advance 1D position and velocity by ``dt`` seconds under the exact
    analytical solution of the critically damped harmonic oscillator
    (``zeta = 1.0``):

    ``x''(t) + 2 * omega_n * x'(t) + omega_n^2 * (x(t) - x_target) = 0``

    Guarantees strictly zero overshoot and smooth S-curve acceleration/deceleration.
    """
    err = pos - target
    if abs(err) <= 1e-5 and abs(vel) <= 1e-4:
        return (target, 0.0)

    # Bound incoming velocity so the trajectory can never cross past target
    if err < 0.0:
        vel = max(0.0, min(vel, -omega_n * err))
    else:
        vel = min(0.0, max(vel, -omega_n * err))

    exp_term = math.exp(-omega_n * dt)
    c1 = err
    c2 = vel + omega_n * err
    next_pos = target + (c1 + c2 * dt) * exp_term
    next_vel = (vel - c2 * omega_n * dt) * exp_term

    # Clamp to target if numerical rounding would cross it
    if (err < 0.0 and next_pos > target) or (err > 0.0 and next_pos < target):
        return (target, 0.0)
    if abs(next_pos - target) <= 2e-4 and abs(next_vel) <= 2e-3:
        return (target, 0.0)
    return (next_pos, next_vel)


def apply_critically_damped_smoothing(
    raw_centers: Sequence[Any],
    sample_fps: float = 6.0,
    deadband_ratio: float = DEFAULT_DEADBAND_RATIO,
    *,
    natural_freq: float = DEFAULT_NATURAL_FREQ,
    omega_n: float | None = None,
    damping_ratio: float = DEFAULT_DAMPING_RATIO,
    inflection_only: bool = False,
    reduce_inflections: bool | None = None,
) -> list[SmoothedKeyframe]:
    """Compute a smooth camera pan trajectory using deadband hysteresis and
    critically damped spring physics (``zeta = 1.0``, ``omega_n = 2.5 rad/s``).

    - Micro-movements within ``deadband_ratio`` (default 6%) produce strictly
      ``0 px`` camera movement (``v = 0``).
    - Step movements outside the deadband follow the exact critically damped
      spring curve with zero overshoot and smooth acceleration/deceleration.
    - When ``inflection_only=True`` (or ``reduce_inflections=True``), redundant
      collinear stationary holds are collapsed to their boundary inflection keyframes.
    """
    if not raw_centers:
        return []
    fps = max(1e-3, float(sample_fps))
    dt = 1.0 / fps
    freq = float(omega_n) if omega_n is not None else float(natural_freq)
    eff_omega_n = max(0.1, freq) * max(0.1, float(damping_ratio))
    deadband = max(0.0, float(deadband_ratio))
    should_reduce = reduce_inflections if reduce_inflections is not None else inflection_only

    parsed = [_parse_raw_center_point(item, idx, dt) for idx, item in enumerate(raw_centers)]
    t0, cx0, cy0, zoom0 = parsed[0]
    x = min(1.0, max(0.0, cx0))
    y = min(1.0, max(0.0, cy0))
    z = min(1.5, max(1.0, zoom0))
    vx = 0.0
    vy = 0.0
    vz = 0.0
    target_x = x
    target_y = y
    target_z = z

    frames: list[SmoothedKeyframe] = [SmoothedKeyframe(t0, x, y, z)]
    for idx in range(1, len(parsed)):
        t_sec, raw_x, raw_y, raw_z = parsed[idx]
        step_dt = max(1e-4, t_sec - parsed[idx - 1][0]) if t_sec > parsed[idx - 1][0] else dt
        clamped_x = min(1.0, max(0.0, raw_x))
        clamped_y = min(1.0, max(0.0, raw_y))
        clamped_z = min(1.5, max(1.0, raw_z))

        if abs(clamped_x - target_x) > deadband:
            target_x = clamped_x
        if abs(clamped_y - target_y) > deadband:
            target_y = clamped_y
        if abs(clamped_z - target_z) > 0.02:
            target_z = clamped_z

        x, vx = _step_critically_damped_axis(x, vx, target_x, step_dt, eff_omega_n)
        y, vy = _step_critically_damped_axis(y, vy, target_y, step_dt, eff_omega_n)
        z, vz = _step_critically_damped_axis(z, vz, target_z, step_dt, eff_omega_n)
        frames.append(SmoothedKeyframe(t_sec, x, y, z))

    if not should_reduce or len(frames) <= 2:
        return frames

    return _emit_inflection_keyframes(frames)


def _emit_inflection_keyframes(frames: Sequence[SmoothedKeyframe]) -> list[SmoothedKeyframe]:
    """Emit keyframes only at inflection / state-change points (pan start,
    peak velocity inflection, pan settle, and clip endpoints) to keep the
    trajectory payload lightweight.
    """
    if len(frames) <= 2:
        return list(frames)

    kept: list[SmoothedKeyframe] = [frames[0]]
    for i in range(1, len(frames) - 1):
        prev_kf = frames[i - 1]
        curr_kf = frames[i]
        next_kf = frames[i + 1]

        dx1 = curr_kf.centerX - prev_kf.centerX
        dx2 = next_kf.centerX - curr_kf.centerX
        dy1 = curr_kf.centerY - prev_kf.centerY
        dy2 = next_kf.centerY - curr_kf.centerY

        stationary_prev = abs(dx1) < 1e-4 and abs(dy1) < 1e-4
        stationary_next = abs(dx2) < 1e-4 and abs(dy2) < 1e-4

        # Skip interior points of a flat stationary hold
        if stationary_prev and stationary_next:
            continue

        # Keep boundary points where motion starts or settles
        if stationary_prev != stationary_next:
            kept.append(curr_kf)
            continue

        # Keep inflection points where acceleration changes sign or curvature is significant
        ddx_prev = (
            (curr_kf.centerX - 2.0 * prev_kf.centerX + frames[i - 2].centerX)
            if i >= 2
            else dx1
        )
        ddx_curr = next_kf.centerX - 2.0 * curr_kf.centerX + prev_kf.centerX
        if ddx_prev * ddx_curr <= 0.0 or abs(ddx_curr) >= 0.002:
            kept.append(curr_kf)

    kept.append(frames[-1])
    return kept


def build_reframe_trajectory(
    samples_or_centers: Sequence[Any],
    *,
    sample_fps: float = 1000.0 / DEFAULT_INTERVAL_MS,
    deadband_ratio: float = DEFAULT_DEADBAND_RATIO,
    interpolation: str = "SPRING_DAMPED",
) -> dict[str, Any]:
    """Build a ``DynamicReframeTrajectory`` payload from ``FaceSample``\\ s or
    raw centre coordinates, emitting inflection keyframes with
    ``SPRING_DAMPED`` interpolation.
    """
    if samples_or_centers and isinstance(samples_or_centers[0], FaceSample):
        raw: Sequence[Any] = extract_raw_face_centers(samples_or_centers)  # type: ignore[arg-type]
    else:
        raw = samples_or_centers

    smoothed = apply_critically_damped_smoothing(
        raw,
        sample_fps=sample_fps,
        deadband_ratio=deadband_ratio,
        inflection_only=True,
    )
    if not smoothed:
        smoothed = [SmoothedKeyframe(0.0, 0.5, 0.5, 1.0)]
    return {
        "keyframes": [dict(kf) for kf in smoothed],
        "interpolation": interpolation,
    }

