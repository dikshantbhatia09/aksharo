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
    "DEFAULT_STREAMER_DIVIDER_COLOR",
    "FACECAM_OVERLAY",
    "FACE_TRACK_VERSION",
    "FaceBox",
    "FaceSample",
    "FacecamRect",
    "LAYOUT_SINGLE_SPEAKER",
    "LAYOUT_STREAMER_SPLIT",
    "LAYOUT_TWO_SPEAKER_CONVERSATION",
    "MAX_FACES_PER_SAMPLE",
    "MIN_FACE_HEIGHT",
    "SmoothedKeyframe",
    "SpeakerCluster",
    "StreamerClassification",
    "TWO_SPEAKER_MIN_SEPARATION_RATIO",
    "TwoSpeakerClassification",
    "YuNetOnnxDetector",
    "apply_critically_damped_smoothing",
    "bound_faces",
    "build_reframe_trajectory",
    "calculate_mouth_aspect_ratio",
    "classify_streamer_layout",
    "classify_two_speaker_layout",
    "cluster_speaker_faces_kmeans",
    "correlate_active_speaker",
    "decode_yunet",
    "detect_corner_facecam",
    "detect_face_track",
    "extract_raw_face_centers",
    "face_track_document",
    "iter_bgr_frames",
    "kmeans_face_clusters",
    "nms",
    "plan_dialogue_monologue_segments",
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


# ---------------------------------------------------------------------------
# Two-Speaker Vertical Split-Screen Layout Engine (Pillar 3 §02)
# ---------------------------------------------------------------------------

#: Minimum horizontal cluster separation as a fraction of frame width to
#: classify a source as a two-speaker side-by-side conversation.
TWO_SPEAKER_MIN_SEPARATION_RATIO = 0.35

LAYOUT_TWO_SPEAKER_CONVERSATION = "TWO_SPEAKER_CONVERSATION"
LAYOUT_SINGLE_SPEAKER = "SINGLE_SPEAKER"


def _median_float(values: Sequence[float], default: float = 0.5) -> float:
    if not values:
        return default
    ordered = sorted(float(v) for v in values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return 0.5 * (ordered[mid - 1] + ordered[mid])


def _floor_even(value: float, minimum: int = 2) -> int:
    return max(minimum, int(math.floor(value / 2.0)) * 2)


def _round_even(value: float, minimum: int = 2) -> int:
    return max(minimum, int(round(value / 2.0)) * 2)


class SpeakerCluster(dict[str, Any]):
    """One speaker cluster identified by k-means (k=2) over face samples."""

    def __init__(
        self,
        *,
        speaker_id: int,
        role: str,
        center_x: float,
        center_y: float,
        median_box: FaceBox,
        crop_box: dict[str, int],
        sample_count: int,
    ) -> None:
        super().__init__(
            speakerId=speaker_id,
            role=role,
            centerX=round(float(center_x), 4),
            centerY=round(float(center_y), 4),
            medianBox={
                "x": round(float(median_box.x), 4),
                "y": round(float(median_box.y), 4),
                "width": round(float(median_box.w), 4),
                "height": round(float(median_box.h), 4),
                "score": round(float(median_box.score), 4),
            },
            cropBox=dict(crop_box),
            sampleCount=int(sample_count),
        )
        self._median_box = median_box

    @property
    def speaker_id(self) -> int:
        return int(self["speakerId"])

    @property
    def role(self) -> str:
        return str(self["role"])

    @property
    def center_x(self) -> float:
        return float(self["centerX"])

    @property
    def centerX(self) -> float:  # noqa: N802
        return float(self["centerX"])

    @property
    def center_y(self) -> float:
        return float(self["centerY"])

    @property
    def centerY(self) -> float:  # noqa: N802
        return float(self["centerY"])

    @property
    def median_box(self) -> FaceBox:
        return self._median_box

    @property
    def crop_box(self) -> dict[str, int]:
        return dict(self["cropBox"])

    @property
    def sample_count(self) -> int:
        return int(self["sampleCount"])


class TwoSpeakerClassification(dict[str, Any]):
    """Result of k-means (k=2) speaker clustering and split-screen layout classification."""

    def __init__(
        self,
        *,
        layout: str,
        is_two_speaker: bool,
        delta_x: float,
        delta_x_px: float,
        separation_ratio: float,
        clusters: tuple[SpeakerCluster, ...],
        top_crop: dict[str, int],
        bottom_crop: dict[str, int],
        divider_color: str = "#1A1A1A",
        active_speaker_highlight: bool = True,
    ) -> None:
        split_config = {
            "enabled": bool(is_two_speaker),
            "topCrop": dict(top_crop),
            "bottomCrop": dict(bottom_crop),
            "dividerColor": divider_color,
            "activeSpeakerHighlight": bool(active_speaker_highlight),
        }
        super().__init__(
            layout=layout,
            classification=layout,
            enabled=bool(is_two_speaker),
            isTwoSpeaker=bool(is_two_speaker),
            deltaX=round(float(delta_x), 4),
            deltaXPx=round(float(delta_x_px), 2),
            separationRatio=round(float(separation_ratio), 4),
            clusters=list(clusters),
            topCrop=dict(top_crop),
            bottomCrop=dict(bottom_crop),
            splitScreenConfig=split_config,
        )
        self._clusters = clusters

    @property
    def layout(self) -> str:
        return str(self["layout"])

    @property
    def classification(self) -> str:
        return str(self["classification"])

    @property
    def enabled(self) -> bool:
        return bool(self["enabled"])

    @property
    def is_two_speaker(self) -> bool:
        return bool(self["isTwoSpeaker"])

    @property
    def delta_x(self) -> float:
        return float(self["deltaX"])

    @property
    def delta_x_px(self) -> float:
        return float(self["deltaXPx"])

    @property
    def separation_ratio(self) -> float:
        return float(self["separationRatio"])

    @property
    def clusters(self) -> tuple[SpeakerCluster, ...]:
        return self._clusters

    @property
    def top_crop(self) -> dict[str, int]:
        return dict(self["topCrop"])

    @property
    def topCrop(self) -> dict[str, int]:  # noqa: N802
        return dict(self["topCrop"])

    @property
    def bottom_crop(self) -> dict[str, int]:
        return dict(self["bottomCrop"])

    @property
    def bottomCrop(self) -> dict[str, int]:  # noqa: N802
        return dict(self["bottomCrop"])

    @property
    def host_box(self) -> FaceBox | None:
        return self._clusters[0].median_box if len(self._clusters) >= 1 else None

    @property
    def guest_box(self) -> FaceBox | None:
        return self._clusters[1].median_box if len(self._clusters) >= 2 else None

    @property
    def split_screen_config(self) -> dict[str, Any]:
        return dict(self["splitScreenConfig"])


def _extract_candidate_boxes(
    samples_or_boxes: Sequence[Any],
    *,
    source_width: int,
    source_height: int,
) -> tuple[list[FaceBox], int, int]:
    """Normalise diverse caller inputs into a flat list of normalised ``FaceBox``
    instances plus ``(total_samples, dual_face_samples)``.
    """
    sw = max(1.0, float(source_width))
    sh = max(1.0, float(source_height))
    flat: list[FaceBox] = []
    total_samples = 0
    dual_samples = 0

    def _to_norm_box(item: Any) -> FaceBox | None:
        if isinstance(item, FaceBox):
            x, y, w, h, score = item.x, item.y, item.w, item.h, item.score
        elif isinstance(item, Mapping):
            if "w" in item or "width" in item:
                x = float(item.get("x", 0.0))
                y = float(item.get("y", 0.0))
                w = float(item.get("w", item.get("width", 0.12)))
                h = float(item.get("h", item.get("height", 0.16)))
                score = float(item.get("score", 0.95))
            else:
                cx = float(item.get("centerX", item.get("cx", item.get("x", 0.5))))
                cy = float(item.get("centerY", item.get("cy", item.get("y", 0.4))))
                w = float(item.get("size", 0.12))
                h = float(item.get("size", 0.16))
                if cx > 1.5 or cy > 1.5:
                    cx /= sw
                    cy /= sh
                if w > 1.5:
                    w /= sw
                if h > 1.5:
                    h /= sh
                return FaceBox(
                    x=max(0.0, cx - w / 2.0),
                    y=max(0.0, cy - h / 2.0),
                    w=w,
                    h=h,
                    score=0.95,
                )
        elif isinstance(item, (Sequence, np.ndarray)):
            if len(item) >= 4:
                x, y, w, h = float(item[0]), float(item[1]), float(item[2]), float(item[3])
                score = float(item[4]) if len(item) >= 5 else 0.95
            elif len(item) >= 2:
                cx, cy = float(item[0]), float(item[1])
                if cx > 1.5 or cy > 1.5:
                    cx /= sw
                    cy /= sh
                w, h = 0.10, 0.16
                return FaceBox(
                    x=max(0.0, cx - w / 2.0),
                    y=max(0.0, cy - h / 2.0),
                    w=w,
                    h=h,
                    score=0.95,
                )
            else:
                return None
        else:
            return None

        # Convert pixel boxes to normalised 0..1 coordinates when values exceed 1.5
        if x > 1.5 or y > 1.5 or w > 1.5 or h > 1.5:
            x /= sw
            y /= sh
            w /= sw
            h /= sh
        if w <= 0.0 or h < MIN_FACE_HEIGHT:
            return None
        return FaceBox(
            x=min(1.0, max(0.0, x)),
            y=min(1.0, max(0.0, y)),
            w=min(1.0, max(0.01, w)),
            h=min(1.0, max(MIN_FACE_HEIGHT, h)),
            score=score,
        )

    for entry in samples_or_boxes:
        if isinstance(entry, FaceSample):
            total_samples += 1
            usable = bound_faces(entry.boxes)[:2]
            if len(usable) >= 2:
                dual_samples += 1
            flat.extend(usable)
        elif (
            isinstance(entry, (Sequence, np.ndarray))
            and len(entry) == 2
            and isinstance(entry[0], (int, float))
            and isinstance(entry[1], (Sequence, np.ndarray))
            and (len(entry[1]) == 0 or isinstance(entry[1][0], (Sequence, np.ndarray, FaceBox, Mapping)))
        ):
            # Raw `faces.json` sample `[t_ms, boxes]`
            total_samples += 1
            sample_boxes = [b for raw_b in entry[1] if (b := _to_norm_box(raw_b)) is not None]
            sample_boxes.sort(key=lambda b: b.w * b.h, reverse=True)
            kept = sample_boxes[:2]
            if len(kept) >= 2:
                dual_samples += 1
            flat.extend(kept)
        else:
            box = _to_norm_box(entry)
            if box is not None:
                flat.append(box)

    return flat, total_samples, dual_samples


def _compute_pane_crop(
    median_box: FaceBox,
    *,
    side: str,
    midpoint_x: float,
    separation_x: float,
    source_width: int,
    source_height: int,
) -> dict[str, int]:
    """Compute an optimised 9:8 half-canvas crop window (1080 x 960 aspect ratio)
    for one speaker in source pixel coordinates, clamped to the speaker's side
    of the frame so neither pane ever bleeds into the other speaker.
    """
    sw = max(2, int(source_width))
    sh = max(2, int(source_height))
    pane_ratio = 1080.0 / 960.0  # 1.125 (9:8 half of 9:16)

    cx = (median_box.x + median_box.w / 2.0) * sw
    cy = (median_box.y + median_box.h / 2.0) * sh
    mid_px = midpoint_x * sw
    sep_px = max(64.0, separation_x * sw)

    widest = _floor_even(min(sep_px, mid_px if side == "left" else (sw - mid_px), float(sw)))
    tallest = min(_floor_even(sh), _floor_even(widest / pane_ratio))
    if tallest < 16:
        tallest = _floor_even(sh * 0.5)
        widest = min(_floor_even(sw * 0.5), _round_even(tallest * pane_ratio))

    wanted_h = (median_box.h * sh) / 0.22
    floor_h = min(0.5 * sh, float(tallest))
    crop_h = _floor_even(min(float(tallest), max(floor_h, wanted_h)))
    crop_w = min(_round_even(crop_h * pane_ratio), widest, _floor_even(sw))

    if side == "left":
        low_x = 0
        high_x = max(0, int(math.floor(mid_px)) - crop_w)
    else:
        low_x = min(sw - crop_w, int(math.ceil(mid_px)))
        high_x = max(low_x, sw - crop_w)

    raw_left = int(round(cx - crop_w / 2.0))
    clamped_left = min(max(raw_left, low_x), max(low_x, high_x))
    raw_top = int(round(cy - crop_h / 3.0))
    clamped_top = min(max(raw_top, 0), max(0, sh - crop_h))

    return {
        "x": (clamped_left // 2) * 2,
        "y": (clamped_top // 2) * 2,
        "width": crop_w,
        "height": crop_h,
    }


def cluster_speaker_faces_kmeans(
    samples_or_boxes: Sequence[Any],
    *,
    k: int = 2,
    source_width: int = 1920,
    source_height: int = 1080,
    min_separation_ratio: float = TWO_SPEAKER_MIN_SEPARATION_RATIO,
    max_iters: int = 50,
    divider_color: str = "#1A1A1A",
    active_speaker_highlight: bool = True,
) -> TwoSpeakerClassification:
    """Group detected face centers across sample frames using k-means (``k=2``),
    compute stable median bounding boxes for each speaker, and classify the
    video as ``TWO_SPEAKER_CONVERSATION`` when cluster centers are separated by
    ``delta_x > 0.35 * width``.
    """
    if k != 2:
        raise ValueError(f"Two-speaker split-screen clustering requires k=2, got k={k}")

    boxes, total_samples, dual_samples = _extract_candidate_boxes(
        samples_or_boxes,
        source_width=source_width,
        source_height=source_height,
    )
    default_crop = {
        "x": 0,
        "y": 0,
        "width": _floor_even(source_width * 0.5),
        "height": _floor_even(source_height * 0.5),
    }

    if len(boxes) < 2 or source_width <= source_height:
        return TwoSpeakerClassification(
            layout=LAYOUT_SINGLE_SPEAKER,
            is_two_speaker=False,
            delta_x=0.0,
            delta_x_px=0.0,
            separation_ratio=0.0,
            clusters=(),
            top_crop=default_crop,
            bottom_crop=default_crop,
            divider_color=divider_color,
            active_speaker_highlight=active_speaker_highlight,
        )

    centers = [(b.x + b.w / 2.0, b.y + b.h / 2.0) for b in boxes]
    sorted_cx = sorted(c[0] for c in centers)
    # Deterministic quantile initialisation (25th and 75th percentiles)
    q25_idx = max(0, (len(sorted_cx) - 1) // 4)
    q75_idx = min(len(sorted_cx) - 1, (3 * (len(sorted_cx) - 1)) // 4)
    c0_x = sorted_cx[q25_idx]
    c1_x = sorted_cx[q75_idx]
    if abs(c1_x - c0_x) < 1e-6:
        c0_x = sorted_cx[0]
        c1_x = sorted_cx[-1]

    c0_y = _median_float([cy for cx, cy in centers if cx <= 0.5 * (c0_x + c1_x)], 0.45)
    c1_y = _median_float([cy for cx, cy in centers if cx > 0.5 * (c0_x + c1_x)], 0.45)

    assignments = [0] * len(boxes)
    for _ in range(max(1, max_iters)):
        new_assignments: list[int] = []
        for cx, cy in centers:
            # Horizontal position is primary for side-by-side speaker seating
            d0 = math.hypot(cx - c0_x, 0.35 * (cy - c0_y))
            d1 = math.hypot(cx - c1_x, 0.35 * (cy - c1_y))
            new_assignments.append(0 if d0 <= d1 else 1)

        group0 = [centers[i] for i, a in enumerate(new_assignments) if a == 0]
        group1 = [centers[i] for i, a in enumerate(new_assignments) if a == 1]
        if not group0 or not group1:
            assignments = new_assignments
            break

        next_c0_x = sum(pt[0] for pt in group0) / len(group0)
        next_c0_y = sum(pt[1] for pt in group0) / len(group0)
        next_c1_x = sum(pt[0] for pt in group1) / len(group1)
        next_c1_y = sum(pt[1] for pt in group1) / len(group1)

        shift = max(
             abs(next_c0_x - c0_x),
            abs(next_c0_y - c0_y),
            abs(next_c1_x - c1_x),
            abs(next_c1_y - c1_y),
        )
        c0_x, c0_y, c1_x, c1_y = next_c0_x, next_c0_y, next_c1_x, next_c1_y
        assignments = new_assignments
        if shift < 1e-6:
            break

    boxes_0 = [boxes[i] for i, a in enumerate(assignments) if a == 0]
    boxes_1 = [boxes[i] for i, a in enumerate(assignments) if a == 1]
    if not boxes_0 or not boxes_1:
        mid = len(boxes) // 2
        ordered_boxes = sorted(boxes, key=lambda b: b.x + b.w / 2.0)
        boxes_0 = ordered_boxes[:mid]
        boxes_1 = ordered_boxes[mid:]

    # Ensure Cluster 0 is always Left (Host / Speaker 1) and Cluster 1 is Right (Guest / Speaker 2)
    med_cx_0 = _median_float([b.x + b.w / 2.0 for b in boxes_0])
    med_cx_1 = _median_float([b.x + b.w / 2.0 for b in boxes_1])
    if med_cx_0 > med_cx_1:
        boxes_0, boxes_1 = boxes_1, boxes_0
        med_cx_0, med_cx_1 = med_cx_1, med_cx_0

    def _build_median_box(cluster_boxes: Sequence[FaceBox]) -> tuple[FaceBox, float, float, float]:
        cxs = [b.x + b.w / 2.0 for b in cluster_boxes]
        cys = [b.y + b.h / 2.0 for b in cluster_boxes]
        ws = [b.w for b in cluster_boxes]
        hs = [b.h for b in cluster_boxes]
        scores = [b.score for b in cluster_boxes]
        med_cx = _median_float(cxs)
        med_cy = _median_float(cys)
        med_w = _median_float(ws, 0.10)
        med_h = _median_float(hs, 0.16)
        med_score = _median_float(scores, 0.95)
        mad_x = _median_float([abs(cx - med_cx) for cx in cxs], 0.0)
        box = FaceBox(
            x=min(1.0, max(0.0, med_cx - med_w / 2.0)),
            y=min(1.0, max(0.0, med_cy - med_h / 2.0)),
            w=min(1.0, max(0.01, med_w)),
            h=min(1.0, max(MIN_FACE_HEIGHT, med_h)),
            score=med_score,
        )
        return box, med_cx, med_cy, mad_x

    host_box, host_cx, host_cy, host_mad_x = _build_median_box(boxes_0)
    guest_box, guest_cx, guest_cy, guest_mad_x = _build_median_box(boxes_1)

    separation_ratio = abs(guest_cx - host_cx)
    delta_x_px = separation_ratio * float(source_width)
    midpoint_x = 0.5 * (host_cx + guest_cx)

    top_crop = _compute_pane_crop(
        host_box,
        side="left",
        midpoint_x=midpoint_x,
        separation_x=separation_ratio,
        source_width=source_width,
        source_height=source_height,
    )
    bottom_crop = _compute_pane_crop(
        guest_box,
        side="right",
        midpoint_x=midpoint_x,
        separation_x=separation_ratio,
        source_width=source_width,
        source_height=source_height,
    )

    host_cluster = SpeakerCluster(
        speaker_id=0,
        role="host",
        center_x=host_cx,
        center_y=host_cy,
        median_box=host_box,
        crop_box=top_crop,
        sample_count=len(boxes_0),
    )
    guest_cluster = SpeakerCluster(
        speaker_id=1,
        role="guest",
        center_x=guest_cx,
        center_y=guest_cy,
        median_box=guest_box,
        crop_box=bottom_crop,
        sample_count=len(boxes_1),
    )

    min_cluster_share = min(len(boxes_0), len(boxes_1)) / max(1, len(boxes))
    # Reject a single speaker walking across the frame (zero dual-face samples AND wide intra-cluster spread)
    walking_single_speaker = (
        total_samples > 0
        and dual_samples == 0
        and max(host_mad_x, guest_mad_x) > 0.08 * max(0.35, separation_ratio)
    )
    is_two_speaker = (
        separation_ratio > float(min_separation_ratio)
        and min_cluster_share >= 0.15
        and not walking_single_speaker
    )
    layout = LAYOUT_TWO_SPEAKER_CONVERSATION if is_two_speaker else LAYOUT_SINGLE_SPEAKER

    return TwoSpeakerClassification(
        layout=layout,
        is_two_speaker=is_two_speaker,
        delta_x=separation_ratio,
        delta_x_px=delta_x_px,
        separation_ratio=separation_ratio,
        clusters=(host_cluster, guest_cluster),
        top_crop=top_crop,
        bottom_crop=bottom_crop,
        divider_color=divider_color,
        active_speaker_highlight=active_speaker_highlight,
    )


kmeans_face_clusters = cluster_speaker_faces_kmeans
classify_two_speaker_layout = cluster_speaker_faces_kmeans


def plan_dialogue_monologue_segments(
    speaker_turns: Sequence[Mapping[str, Any] | tuple[float, float, Any]],
    *,
    monologue_threshold_sec: float = 10.0,
    merge_gap_sec: float = 1.2,
) -> list[dict[str, Any]]:
    """Alternate between ``SPLIT_SCREEN`` during rapid back-and-forth dialogue
    and ``SOLO_FULL_SCREEN`` during extended monologues (>= ``monologue_threshold_sec``).
    """
    if not speaker_turns:
        return []

    normalised: list[tuple[float, float, str]] = []
    for item in speaker_turns:
        if isinstance(item, Mapping):
            start = float(item.get("startSec", item.get("start", 0.0)))
            end = float(item.get("endSec", item.get("end", start)))
            raw_sp = item.get("speaker", item.get("activeSpeaker", "top"))
        else:
            start, end, raw_sp = float(item[0]), float(item[1]), item[2]
        if end <= start:
            continue
        speaker = "bottom" if str(raw_sp).lower() in ("1", "guest", "bottom", "right", "speaker_2", "b") else "top"
        if normalised and normalised[-1][2] == speaker and (start - normalised[-1][1]) <= merge_gap_sec:
            prev_s, _, prev_sp = normalised[-1]
            normalised[-1] = (prev_s, max(end, normalised[-1][1]), prev_sp)
        else:
            normalised.append((start, end, speaker))

    segments: list[dict[str, Any]] = []
    for start, end, speaker in normalised:
        duration = end - start
        mode = "SOLO_FULL_SCREEN" if duration >= monologue_threshold_sec else "SPLIT_SCREEN"
        if (
            segments
            and segments[-1]["mode"] == "SPLIT_SCREEN"
            and mode == "SPLIT_SCREEN"
            and (start - float(segments[-1]["endSec"])) <= merge_gap_sec
        ):
            segments[-1]["endSec"] = round(end, 4)
            segments[-1]["activeSpeaker"] = speaker
        else:
            segments.append(
                {
                    "startSec": round(start, 4),
                    "endSec": round(end, 4),
                    "mode": mode,
                    "activeSpeaker": speaker,
                }
            )
    return segments


LAYOUT_STREAMER_SPLIT: str = "STREAMER_SPLIT"
FACECAM_OVERLAY: str = "FACECAM_OVERLAY"
DEFAULT_STREAMER_DIVIDER_COLOR: str = "#8B5CF6"  # Twitch Purple
STREAMER_TOP_PANE_SHARE: float = 0.35
STREAMER_BOTTOM_PANE_SHARE: float = 0.65


@dataclass(frozen=True, slots=True)
class FacecamRect:
    """Normalised bounding box and telemetry for a streamer webcam overlay."""

    x: float
    y: float
    width: float
    height: float
    corner: str  # "top-left" | "top-right" | "bottom-left" | "bottom-right"
    stability_score: float  # 0.0 .. 1.0 (higher = more stationary)
    presence_share: float  # fraction of examined frames with a face in this corner
    std_x: float  # normalized position standard deviation in X
    std_y: float  # normalized position standard deviation in Y


@dataclass(frozen=True, slots=True)
class StreamerClassification:
    """Classification and geometry of a streamer gameplay + corner facecam split."""

    layout: str  # "STREAMER_SPLIT" | "SINGLE_SPEAKER"
    is_streamer: bool
    facecam_rect: FacecamRect | None
    facecam_crop: dict[str, int]  # {x, y, width, height} in source pixels
    gameplay_crop: dict[str, int]  # {x, y, width, height} in source pixels
    top_pane_height: int  # 672 on 1080x1920
    bottom_pane_height: int  # 1248 on 1080x1920
    divider_color: str  # "#8B5CF6"
    confidence: float


def detect_corner_facecam(
    samples: Sequence[FaceSample],
    *,
    source_width: int = 1920,
    source_height: int = 1080,
    max_scan_seconds: float = 30.0,
    min_presence_ratio: float = 0.20,
    max_position_std: float = 0.028,
    min_stability_score: float = 0.60,
) -> FacecamRect | None:
    """Detect stationary human face persistently situated in one of the 4 corners of a 16:9 stream.

    A stationary webcam overlay exhibits near-zero displacement across time (position standard deviation
    <= max_position_std) and resides consistently in one corner quadrant.
    """
    if not samples:
        return None

    interval_ms = DEFAULT_INTERVAL_MS
    max_samples = int(max_scan_seconds * 1000 / interval_ms) if interval_ms > 0 else 120
    scanned_samples = samples[:max_samples]
    total_scanned = len(scanned_samples)
    if total_scanned == 0:
        return None

    corner_boxes: dict[str, list[tuple[float, float, FaceBox]]] = {
        "top-left": [],
        "top-right": [],
        "bottom-left": [],
        "bottom-right": [],
    }

    for sample in scanned_samples:
        for box in sample.boxes:
            cx = box.x + box.w / 2.0
            cy = box.y + box.h / 2.0

            # Must be a reasonable facecam face size (not taking over the entire frame)
            if box.w > 0.30 or box.h > 0.35:
                continue

            # Classify into 4 corner quadrants
            if cx <= 0.34 and cy <= 0.42:
                corner_boxes["top-left"].append((cx, cy, box))
            elif cx >= 0.66 and cy <= 0.42:
                corner_boxes["top-right"].append((cx, cy, box))
            elif cx <= 0.34 and cy >= 0.58:
                corner_boxes["bottom-left"].append((cx, cy, box))
            elif cx >= 0.66 and cy >= 0.58:
                corner_boxes["bottom-right"].append((cx, cy, box))

    best_candidate: FacecamRect | None = None
    best_score: float = -1.0

    for corner, hits in corner_boxes.items():
        if not hits:
            continue

        presence_share = len(hits) / total_scanned
        if presence_share < min_presence_ratio:
            continue

        cxs = [h[0] for h in hits]
        cys = [h[1] for h in hits]
        std_x = float(np.std(cxs)) if len(cxs) > 1 else 0.0
        std_y = float(np.std(cys)) if len(cys) > 1 else 0.0

        if std_x > max_position_std or std_y > max_position_std:
            continue

        # Position stability score (0.0 to 1.0)
        stability_score = max(0.0, min(1.0, 1.0 - (std_x + std_y) * 15.0))
        if stability_score < min_stability_score:
            continue

        # Median center and dimensions
        median_cx = float(np.median(cxs))
        median_cy = float(np.median(cys))
        median_w = float(np.median([h[2].w for h in hits]))
        median_h = float(np.median([h[2].h for h in hits]))

        # Expand box around streamer's face with padding to frame head, shoulders, and webcam border
        cam_w = min(0.48, max(0.18, median_w * 2.3))
        cam_h = min(0.48, max(0.20, median_h * 2.1))

        cam_x = max(0.0, min(1.0 - cam_w, median_cx - cam_w / 2.0))
        cam_y = max(0.0, min(1.0 - cam_h, median_cy - cam_h / 2.0))

        # Overall confidence score combining presence and stability
        candidate_score = stability_score * 0.6 + presence_share * 0.4

        if candidate_score > best_score:
            best_score = candidate_score
            best_candidate = FacecamRect(
                x=round(cam_x, 4),
                y=round(cam_y, 4),
                width=round(cam_w, 4),
                height=round(cam_h, 4),
                corner=corner,
                stability_score=round(stability_score, 4),
                presence_share=round(presence_share, 4),
                std_x=round(std_x, 4),
                std_y=round(std_y, 4),
            )

    return best_candidate


def classify_streamer_layout(
    samples: Sequence[FaceSample] | None = None,
    *,
    source_width: int = 1920,
    source_height: int = 1080,
    canvas_width: int = 1080,
    canvas_height: int = 1920,
    manual_facecam_crop: Mapping[str, Any] | None = None,
    divider_color: str = DEFAULT_STREAMER_DIVIDER_COLOR,
    min_presence_ratio: float = 0.20,
    max_position_std: float = 0.045,
) -> StreamerClassification:
    """Classify video stream as streamer gameplay + facecam layout and compute
    pixel-perfect dual crop regions (Top 35% webcam, Bottom 65% gameplay).
    """
    top_pane_height = int(round(canvas_height * STREAMER_TOP_PANE_SHARE / 2.0)) * 2
    bottom_pane_height = canvas_height - top_pane_height

    def _even(val: float | int) -> int:
        return int(math.floor(val / 2.0)) * 2

    # 1. Action gameplay crop centered on 16:9 canvas for bottom 65% pane
    # Target aspect ratio: canvas_width / bottom_pane_height (e.g. 1080 / 1248 = 0.86538)
    gameplay_aspect = canvas_width / max(1, bottom_pane_height)
    game_h = _even(source_height)
    game_w = min(_even(source_width), _even(game_h * gameplay_aspect))
    game_x = max(0, _even((source_width - game_w) / 2))
    game_y = 0
    gameplay_crop = {"x": game_x, "y": game_y, "width": game_w, "height": game_h}

    # 2. Check for manual facecam crop or auto-detect
    if manual_facecam_crop:
        raw_x = float(manual_facecam_crop.get("x", 0))
        raw_y = float(manual_facecam_crop.get("y", 0))
        raw_w = float(manual_facecam_crop.get("width", manual_facecam_crop.get("w", 0.25)))
        raw_h = float(manual_facecam_crop.get("height", manual_facecam_crop.get("h", 0.25)))

        # Normalize or treat as pixels
        if raw_x <= 1.0 and raw_y <= 1.0 and raw_w <= 1.0 and raw_h <= 1.0:
            norm_x, norm_y, norm_w, norm_h = raw_x, raw_y, raw_w, raw_h
            px_x = _even(norm_x * source_width)
            px_y = _even(norm_y * source_height)
            px_w = _even(norm_w * source_width)
            px_h = _even(norm_h * source_height)
        else:
            px_x = _even(raw_x)
            px_y = _even(raw_y)
            px_w = _even(raw_w)
            px_h = _even(raw_h)
            norm_x = px_x / max(1, source_width)
            norm_y = px_y / max(1, source_height)
            norm_w = px_w / max(1, source_width)
            norm_h = px_h / max(1, source_height)

        corner = "top-left"
        if norm_x >= 0.5 and norm_y >= 0.5:
            corner = "bottom-right"
        elif norm_x >= 0.5:
            corner = "top-right"
        elif norm_y >= 0.5:
            corner = "bottom-left"

        facecam_rect = FacecamRect(
            x=round(norm_x, 4),
            y=round(norm_y, 4),
            width=round(norm_w, 4),
            height=round(norm_h, 4),
            corner=corner,
            stability_score=1.0,
            presence_share=1.0,
            std_x=0.0,
            std_y=0.0,
        )

        return StreamerClassification(
            layout=LAYOUT_STREAMER_SPLIT,
            is_streamer=True,
            facecam_rect=facecam_rect,
            facecam_crop={"x": px_x, "y": px_y, "width": px_w, "height": px_h},
            gameplay_crop=gameplay_crop,
            top_pane_height=top_pane_height,
            bottom_pane_height=bottom_pane_height,
            divider_color=divider_color,
            confidence=1.0,
        )

    # 3. Auto-detect corner facecam
    facecam = detect_corner_facecam(
        samples or [],
        source_width=source_width,
        source_height=source_height,
        min_presence_ratio=min_presence_ratio,
        max_position_std=max_position_std,
    )

    if facecam is None:
        # Default single speaker / non-streamer fallback
        default_cam = {
            "x": _even(source_width * 0.72),
            "y": _even(source_height * 0.68),
            "width": _even(source_width * 0.25),
            "height": _even(source_height * 0.28),
        }
        return StreamerClassification(
            layout=LAYOUT_SINGLE_SPEAKER,
            is_streamer=False,
            facecam_rect=None,
            facecam_crop=default_cam,
            gameplay_crop=gameplay_crop,
            top_pane_height=top_pane_height,
            bottom_pane_height=bottom_pane_height,
            divider_color=divider_color,
            confidence=0.0,
        )

    facecam_px = {
        "x": _even(facecam.x * source_width),
        "y": _even(facecam.y * source_height),
        "width": _even(facecam.width * source_width),
        "height": _even(facecam.height * source_height),
    }

    confidence = round(facecam.stability_score * 0.6 + facecam.presence_share * 0.4, 4)

    return StreamerClassification(
        layout=LAYOUT_STREAMER_SPLIT,
        is_streamer=True,
        facecam_rect=facecam,
        facecam_crop=facecam_px,
        gameplay_crop=gameplay_crop,
        top_pane_height=top_pane_height,
        bottom_pane_height=bottom_pane_height,
        divider_color=divider_color,
        confidence=confidence,
    )



