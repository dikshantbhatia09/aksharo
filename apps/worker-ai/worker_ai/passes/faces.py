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
"""

from __future__ import annotations

import math
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker_ai.audio import AudioToolError, ffmpeg_path
from worker_ai.passes.frame_sampling import _read_exact, probe_video_size

__all__ = [
    "FACE_TRACK_VERSION",
    "FaceBox",
    "FaceSample",
    "YuNetOnnxDetector",
    "detect_face_track",
    "face_track_document",
    "iter_bgr_frames",
]

#: Bump when the `faces.json` shape changes; the renderer ignores other versions.
FACE_TRACK_VERSION = 1

#: Four samples a second: a caption is up for one to three seconds, so this is
#: several looks per caption, at a quarter of the frame sampler's 10 Hz cost.
DEFAULT_INTERVAL_MS = 250

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
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold

    def detect(self, frame: NDArray[np.uint8]) -> list[FaceBox]:
        """Faces in one BGR `uint8` frame whose longer side is <= 640."""
        height, width = frame.shape[:2]
        canvas = np.zeros((_INPUT_SIZE, _INPUT_SIZE, 3), dtype=np.float32)
        canvas[:height, :width] = frame
        blob = np.ascontiguousarray(canvas.transpose(2, 0, 1)[np.newaxis])
        outputs = dict(
            zip(
                (output.name for output in self._session.get_outputs()),
                self._session.run(None, {self._input_name: blob}),
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


def detect_face_track(
    path: Path,
    detector: YuNetOnnxDetector,
    *,
    interval_ms: int = DEFAULT_INTERVAL_MS,
) -> list[FaceSample]:
    """One `FaceSample` per `interval_ms` over the whole of `path`."""
    return [
        FaceSample(t_ms=t_ms, boxes=tuple(detector.detect(frame)))
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
    reader can tell "looked, found nothing" from "never looked"."""
    return {
        "version": FACE_TRACK_VERSION,
        "intervalMs": interval_ms,
        "source": {"width": source_width, "height": source_height},
        "samples": [
            [
                sample.t_ms,
                [
                    [round(box.x, 4), round(box.y, 4), round(box.w, 4), round(box.h, 4)]
                    for box in sample.boxes
                ],
            ]
            for sample in samples
        ],
    }
