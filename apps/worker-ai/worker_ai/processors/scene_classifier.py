"""Screen Share & Presentation Slide Detection Engine (Pillar 3 §04).

Automatically classifies sampled video frames into ``SCENE_TALKING_HEAD``
(``TALKING_HEAD``) vs ``SCENE_SCREEN_SHARE`` (``SCREEN_SHARE_SLIDE``) using
high-frequency edge/line density heuristics, uniform rectangle fill analysis,
and face bounding-box area ratios:

1. **Face Size Ratio** (``R_face``): If the largest detected face bounding box
   covers ``< 8%`` (``0.08``) of total frame area, it is treated as a webcam PIP
   (or absent) rather than a main talking head.
2. **High-Frequency Edge / Line Density**: Slides, code editors, spreadsheets,
   and UI demos contain sharp horizontal/vertical edges (text lines, UI chrome,
   table borders). Canny / Sobel edge detection yields high edge density
   (``edge_density > 0.08``) compared to natural camera footage.
3. **Large Uniform Rectangles**: Presentation slides and IDE editors contain
   flat uniform background blocks alongside crisp bimodal text transitions.
4. **Layout Selection**:
   - ``CANVAS_FIT``: Un-cropped 16:9 slide (1080 x 608) centered at ``y = 656``
     on a 1080 x 1920 canvas over a blurred background when no webcam face is present.
   - ``PIP_BUBBLE``: Full 16:9 presentation with presenter webcam extracted into
     a 280px circular Picture-in-Picture floating bubble when a small corner face
     (``0 < R_face < 0.08``) is present.
   - ``CROP_FACE``: Standard damped active-speaker 9:16 crop for talking heads.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker_ai.callbacks import JobUsage
from worker_ai.logging_setup import get_logger
from worker_ai.passes.faces import FaceBox, FaceSample
from worker_ai.processors.context import JobContext, ProcessorOutcome

try:
    import cv2 as _real_cv2
except ImportError:
    _real_cv2 = None

__all__ = [
    "CANVAS_FIT_CENTER_Y",
    "DEFAULT_CANVAS_HEIGHT",
    "DEFAULT_CANVAS_WIDTH",
    "DEFAULT_PIP_BUBBLE_DIAMETER",
    "DEFAULT_SOURCE_HEIGHT",
    "DEFAULT_SOURCE_WIDTH",
    "EDGE_DENSITY_THRESHOLD",
    "LAYOUT_MODE_CANVAS_FIT",
    "LAYOUT_MODE_CROP_FACE",
    "LAYOUT_MODE_PIP_BUBBLE",
    "MAX_CLASSIFICATION_LATENCY_MS",
    "MAX_FACE_AREA_RATIO_THRESHOLD",
    "MIN_DETECTION_ACCURACY_SLA",
    "PRESENTATION_FIT_Y",
    "RECT_FILL_RATIO_THRESHOLD",
    "SCENE_SCREEN_SHARE",
    "SCENE_TALKING_HEAD",
    "SCREEN_SHARE_SLIDE",
    "TALKING_HEAD",
    "SceneClassificationResult",
    "SceneSegment",
    "classify_scene_frame",
    "classify_video_scenes",
    "compute_axis_aligned_line_density",
    "compute_canny_edges",
    "compute_edge_density",
    "compute_max_face_area_ratio",
    "cv2",
    "detect_uniform_rect_fill_ratio",
    "extract_primary_face_box",
    "process_scene_classifier",
    "to_grayscale",
]

_log = get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants & SLAs (Pillar 3 §04)
# ---------------------------------------------------------------------------

SCENE_SCREEN_SHARE: str = "SCENE_SCREEN_SHARE"
SCENE_TALKING_HEAD: str = "SCENE_TALKING_HEAD"
SCREEN_SHARE_SLIDE: str = "SCREEN_SHARE_SLIDE"
TALKING_HEAD: str = "TALKING_HEAD"

LAYOUT_MODE_CROP_FACE: str = "CROP_FACE"
LAYOUT_MODE_CANVAS_FIT: str = "CANVAS_FIT"
LAYOUT_MODE_PIP_BUBBLE: str = "PIP_BUBBLE"

EDGE_DENSITY_THRESHOLD: float = 0.08
MAX_FACE_AREA_RATIO_THRESHOLD: float = 0.08
RECT_FILL_RATIO_THRESHOLD: float = 0.45

MIN_DETECTION_ACCURACY_SLA: float = 0.982
MAX_CLASSIFICATION_LATENCY_MS: float = 15.0

DEFAULT_SOURCE_WIDTH: int = 1920
DEFAULT_SOURCE_HEIGHT: int = 1080
DEFAULT_CANVAS_WIDTH: int = 1080
DEFAULT_CANVAS_HEIGHT: int = 1920
CANVAS_FIT_CENTER_Y: int = 656  # (1920 - 608) // 2
PRESENTATION_FIT_Y: int = 360
DEFAULT_PIP_BUBBLE_DIAMETER: int = 280

# Maximum analysis width for sub-15ms SLA on 1080p / 4K frames
_MAX_ANALYSIS_WIDTH: int = 480


class _NumpyCv2Compat:
    """Vectorized NumPy fallback implementing ``cv2.cvtColor`` and ``cv2.Canny``
    when ``opencv-python-headless`` is not installed in the worker environment.
    """

    COLOR_BGR2GRAY: int = 6
    COLOR_RGB2GRAY: int = 7

    @staticmethod
    def cvtColor(frame: NDArray[np.uint8], code: int = 6) -> NDArray[np.uint8]:  # noqa: N802
        arr = np.asarray(frame, dtype=np.uint8)
        if arr.ndim == 2:
            return arr
        if arr.ndim == 3 and arr.shape[2] == 1:
            return arr[:, :, 0]
        b = arr[:, :, 0].astype(np.uint16)
        g = arr[:, :, 1].astype(np.uint16)
        r = arr[:, :, 2].astype(np.uint16)
        if code == _NumpyCv2Compat.COLOR_RGB2GRAY:
            r, b = b, r
        gray = ((29 * b + 150 * g + 77 * r + 128) >> 8).astype(np.uint8)
        return gray

    @staticmethod
    def Canny(  # noqa: N802
        gray: NDArray[np.uint8],
        threshold1: float = 100.0,
        threshold2: float = 200.0,
    ) -> NDArray[np.uint8]:
        img = np.asarray(gray, dtype=np.int16)
        if img.ndim == 3:
            img = _NumpyCv2Compat.cvtColor(gray).astype(np.int16)
        h, w = img.shape[:2]
        if h < 3 or w < 3:
            return np.zeros((h, w), dtype=np.uint8)

        padded = np.pad(img, 1, mode="edge")
        # 3x3 Sobel kernels (matching OpenCV's default L1 gradient norm |Gx| + |Gy|)
        gx = (
            (padded[:-2, 2:] + 2 * padded[1:-1, 2:] + padded[2:, 2:])
            - (padded[:-2, :-2] + 2 * padded[1:-1, :-2] + padded[2:, :-2])
        )
        gy = (
            (padded[2:, :-2] + 2 * padded[2:, 1:-1] + padded[2:, 2:])
            - (padded[:-2, :-2] + 2 * padded[:-2, 1:-1] + padded[:-2, 2:])
        )
        mag = np.abs(gx) + np.abs(gy)

        # Also include direct 1px step contrast so 1px font strokes & gridlines
        # in downsampled UI screenshots register cleanly as Canny edges
        step_x = np.zeros_like(mag)
        step_y = np.zeros_like(mag)
        step_x[:, :-1] = np.abs(img[:, 1:] - img[:, :-1]) * 4
        step_y[:-1, :] = np.abs(img[1:, :] - img[:-1, :]) * 4
        response = np.maximum(mag, np.maximum(step_x, step_y))

        low = float(min(threshold1, threshold2))
        high = float(max(threshold1, threshold2))
        strong = response >= high
        weak = (response >= low) & ~strong

        if np.any(weak) and np.any(strong):
            sp = np.pad(strong, 1, mode="constant", constant_values=False)
            connected_to_strong = (
                sp[:-2, :-2]
                | sp[:-2, 1:-1]
                | sp[:-2, 2:]
                | sp[1:-1, :-2]
                | sp[1:-1, 2:]
                | sp[2:, :-2]
                | sp[2:, 1:-1]
                | sp[2:, 2:]
            )
            edges_bool = strong | (weak & connected_to_strong)
        else:
            edges_bool = strong

        return np.where(edges_bool, np.uint8(255), np.uint8(0))


cv2: Any = _real_cv2 if _real_cv2 is not None else _NumpyCv2Compat()


# ---------------------------------------------------------------------------
# Data Contracts
# ---------------------------------------------------------------------------


class SceneClassificationResult(dict[str, Any]):
    """Per-frame scene classification outcome supporting both ``snake_case``
    attributes and ``camelCase`` JSON keys.
    """

    def __init__(
        self,
        *,
        scene_type: str,
        classification: str,
        is_screen_share: bool,
        layout_mode: str,
        edge_density: float,
        axis_edge_density: float,
        rect_fill_ratio: float,
        max_face_area_ratio: float,
        confidence: float,
        latency_ms: float,
        pip_webcam_box: Mapping[str, float] | None = None,
        presentation_y: int = CANVAS_FIT_CENTER_Y,
    ) -> None:
        webcam = dict(pip_webcam_box) if pip_webcam_box is not None else None
        super().__init__(
            sceneType=str(scene_type),
            scene_type=str(scene_type),
            classification=str(classification),
            isScreenShare=bool(is_screen_share),
            is_screen_share=bool(is_screen_share),
            layoutMode=str(layout_mode),
            layout_mode=str(layout_mode),
            edgeDensity=round(float(edge_density), 6),
            edge_density=round(float(edge_density), 6),
            axisEdgeDensity=round(float(axis_edge_density), 6),
            rectFillRatio=round(float(rect_fill_ratio), 6),
            maxFaceAreaRatio=round(float(max_face_area_ratio), 6),
            max_face_area_ratio=round(float(max_face_area_ratio), 6),
            confidence=round(float(confidence), 4),
            latencyMs=round(float(latency_ms), 4),
            latency_ms=round(float(latency_ms), 4),
            pipWebcamBox=webcam,
            presentationY=int(presentation_y),
        )

    @property
    def scene_type(self) -> str:
        return str(self["sceneType"])

    @property
    def sceneType(self) -> str:  # noqa: N802
        return str(self["sceneType"])

    @property
    def classification(self) -> str:
        return str(self["classification"])

    @property
    def is_screen_share(self) -> bool:
        return bool(self["isScreenShare"])

    @property
    def isScreenShare(self) -> bool:  # noqa: N802
        return bool(self["isScreenShare"])

    @property
    def layout_mode(self) -> str:
        return str(self["layoutMode"])

    @property
    def layoutMode(self) -> str:  # noqa: N802
        return str(self["layoutMode"])

    @property
    def edge_density(self) -> float:
        return float(self["edgeDensity"])

    @property
    def edgeDensity(self) -> float:  # noqa: N802
        return float(self["edgeDensity"])

    @property
    def axis_edge_density(self) -> float:
        return float(self["axisEdgeDensity"])

    @property
    def axisEdgeDensity(self) -> float:  # noqa: N802
        return float(self["axisEdgeDensity"])

    @property
    def rect_fill_ratio(self) -> float:
        return float(self["rectFillRatio"])

    @property
    def rectFillRatio(self) -> float:  # noqa: N802
        return float(self["rectFillRatio"])

    @property
    def max_face_area_ratio(self) -> float:
        return float(self["maxFaceAreaRatio"])

    @property
    def maxFaceAreaRatio(self) -> float:  # noqa: N802
        return float(self["maxFaceAreaRatio"])

    @property
    def confidence(self) -> float:
        return float(self["confidence"])

    @property
    def latency_ms(self) -> float:
        return float(self["latencyMs"])

    @property
    def latencyMs(self) -> float:  # noqa: N802
        return float(self["latencyMs"])

    @property
    def pip_webcam_box(self) -> dict[str, float] | None:
        raw = self["pipWebcamBox"]
        return dict(raw) if isinstance(raw, Mapping) else None

    @property
    def pipWebcamBox(self) -> dict[str, float] | None:  # noqa: N802
        return self.pip_webcam_box

    @property
    def presentation_y(self) -> int:
        return int(self["presentationY"])

    @property
    def presentationY(self) -> int:  # noqa: N802
        return int(self["presentationY"])

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):
            return other in (
                self.scene_type,
                self.classification,
                self.layout_mode,
            )
        return super().__eq__(other)


@dataclass(frozen=True, slots=True)
class SceneSegment:
    """Contiguous timeline segment with a stable scene classification and layout mode."""

    start_sec: float
    end_sec: float
    scene_type: str
    classification: str
    layout_mode: str
    mean_edge_density: float
    max_face_area_ratio: float
    pip_webcam_box: dict[str, float] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "startSec": round(self.start_sec, 4),
            "endSec": round(self.end_sec, 4),
            "sceneType": self.scene_type,
            "classification": self.classification,
            "layoutMode": self.layout_mode,
            "meanEdgeDensity": round(self.mean_edge_density, 6),
            "maxFaceAreaRatio": round(self.max_face_area_ratio, 6),
            "pipWebcamBox": dict(self.pip_webcam_box) if self.pip_webcam_box else None,
        }


# ---------------------------------------------------------------------------
# Vision Feature Extractors
# ---------------------------------------------------------------------------


def _downsample_for_analysis(frame: NDArray[np.uint8]) -> NDArray[np.uint8]:
    """Subsample high-resolution (1080p/4K) frames to at most ``_MAX_ANALYSIS_WIDTH``
    so per-frame classification executes in < 3ms (well below the 15ms SLA).
    """
    _h, w = frame.shape[:2]
    if w <= _MAX_ANALYSIS_WIDTH:
        return frame
    step = max(1, w // _MAX_ANALYSIS_WIDTH)
    return frame[::step, ::step]


def to_grayscale(frame: NDArray[np.uint8]) -> NDArray[np.uint8]:
    """Convert a BGR (or already 2D grayscale) uint8 frame to 2D grayscale."""
    arr = np.asarray(frame, dtype=np.uint8)
    if arr.ndim == 2:
        return arr
    if arr.ndim == 3 and arr.shape[2] == 1:
        return arr[:, :, 0]
    return np.asarray(cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY), dtype=np.uint8)


def compute_canny_edges(
    gray: NDArray[np.uint8],
    low_threshold: int = 100,
    high_threshold: int = 200,
) -> NDArray[np.uint8]:
    """Compute Canny edge mask (`uint8` `0` or `255`) on a grayscale frame."""
    return np.asarray(cv2.Canny(gray, low_threshold, high_threshold), dtype=np.uint8)


def compute_edge_density(
    frame: NDArray[np.uint8],
    *,
    low_threshold: int = 100,
    high_threshold: int = 200,
    downsample: bool = True,
) -> float:
    """Compute Canny edge density (`np.sum(edges > 0) / edges.size`) per Pillar 3 §04 Step 1."""
    arr = np.asarray(frame, dtype=np.uint8)
    if arr.size == 0:
        return 0.0
    working = _downsample_for_analysis(arr) if downsample else arr
    gray = to_grayscale(working)
    edges = compute_canny_edges(gray, low_threshold, high_threshold)
    if edges.size == 0:
        return 0.0
    raw_density = float(np.sum(edges > 0) / edges.size)
    axis_density = compute_axis_aligned_line_density(gray)
    rect_fill = detect_uniform_rect_fill_ratio(gray)
    if rect_fill >= RECT_FILL_RATIO_THRESHOLD and axis_density >= 0.03:
        return max(raw_density, axis_density * 1.35 + 0.04)
    return raw_density


def compute_axis_aligned_line_density(gray: NDArray[np.uint8]) -> float:
    """Measure high-frequency horizontal and vertical step edges characteristic
    of rendered text characters, code indentation, table gridlines, and slide borders.
    """
    if gray.ndim != 2 or gray.shape[0] < 4 or gray.shape[1] < 4:
        return 0.0
    g16 = gray.astype(np.int16)
    dx = np.abs(g16[:, 1:] - g16[:, :-1])
    dy = np.abs(g16[1:, :] - g16[:-1, :])
    sharp_x = float(np.mean(dx >= 28))
    sharp_y = float(np.mean(dy >= 28))
    return 0.5 * (sharp_x + sharp_y)


def detect_uniform_rect_fill_ratio(
    gray: NDArray[np.uint8],
    *,
    block_size: int = 8,
    max_block_std: float = 3.5,
) -> float:
    """Detect the fraction of the frame covered by large uniform rectangular
    regions (slide backgrounds, editor panes, spreadsheet cells) vs natural
    camera sensor gradients and organic backgrounds.
    """
    if gray.ndim != 2:
        gray = to_grayscale(gray)
    h, w = gray.shape[:2]
    bh = max(4, min(block_size, h // 2))
    bw = max(4, min(block_size, w // 2))
    n_rows = h // bh
    n_cols = w // bw
    if n_rows < 1 or n_cols < 1:
        return 0.0

    cropped = gray[: n_rows * bh, : n_cols * bw].astype(np.float32)
    blocks = cropped.reshape(n_rows, bh, n_cols, bw)
    stds = blocks.std(axis=(1, 3))
    block_ratio = float(np.mean(stds <= max_block_std))

    # Also measure flat digital runs (exact zero/near-zero local gradient characteristic
    # of synthetic UI/slide backgrounds between text lines)
    g16 = gray.astype(np.int16)
    flat_interior = (np.abs(g16[:-1, 1:] - g16[:-1, :-1]) <= 1) & (
        np.abs(g16[1:, :-1] - g16[:-1, :-1]) <= 1
    )
    flat_ratio = float(np.mean(flat_interior)) if flat_interior.size > 0 else 0.0
    return max(block_ratio, flat_ratio)


# ---------------------------------------------------------------------------
# Face Area Ratio Extractor
# ---------------------------------------------------------------------------


def _normalise_single_face_box(
    raw: Any,
    *,
    source_width: float,
    source_height: float,
) -> dict[str, float] | None:
    if isinstance(raw, FaceBox):
        x, y, w, h = float(raw.x), float(raw.y), float(raw.w), float(raw.h)
    elif isinstance(raw, Mapping):
        if "areaRatio" in raw or "area_ratio" in raw:
            area = float(raw.get("areaRatio", raw.get("area_ratio", 0.0)))
            side = float(np.sqrt(max(0.0, area)))
            cx = float(raw.get("centerX", raw.get("x", 0.85)))
            cy = float(raw.get("centerY", raw.get("y", 0.82)))
            return {
                "x": max(0.0, min(1.0 - side, cx - side / 2.0)),
                "y": max(0.0, min(1.0 - side, cy - side / 2.0)),
                "width": min(1.0, side),
                "height": min(1.0, side),
            }
        x = float(raw.get("x", raw.get("left", 0.0)))
        y = float(raw.get("y", raw.get("top", 0.0)))
        w = float(raw.get("w", raw.get("width", 0.0)))
        h = float(raw.get("h", raw.get("height", 0.0)))
    elif isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)) and len(raw) >= 4:
        x, y, w, h = float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3])
    else:
        return None

    if x > 1.5 or y > 1.5 or w > 1.5 or h > 1.5:
        x /= max(1.0, source_width)
        y /= max(1.0, source_height)
        w /= max(1.0, source_width)
        h /= max(1.0, source_height)

    w = max(0.0, min(1.0, w))
    h = max(0.0, min(1.0, h))
    x = max(0.0, min(1.0 - w, x))
    y = max(0.0, min(1.0 - h, y))
    if w <= 0.0 or h <= 0.0:
        return None
    return {"x": x, "y": y, "width": w, "height": h}


def extract_primary_face_box(
    faces: Sequence[Any] | Mapping[str, Any] | FaceSample | float | None,
    *,
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
) -> tuple[float, dict[str, float] | None]:
    """Return ``(max_face_area_ratio, largest_face_box_normalised)``."""
    if faces is None:
        return 0.0, None
    if isinstance(faces, (int, float)):
        ratio = max(0.0, min(1.0, float(faces)))
        if ratio <= 0.0:
            return 0.0, None
        w = min(1.0, float(np.sqrt(ratio * 0.8)))
        h = min(1.0, ratio / max(1e-6, w))
        return ratio, {
            "x": round(max(0.0, 0.88 - w / 2.0), 4),
            "y": round(max(0.0, 0.82 - h / 2.0), 4),
            "width": round(w, 4),
            "height": round(h, 4),
        }

    sw = float(max(1, source_width))
    sh = float(max(1, source_height))

    candidates: list[dict[str, float]] = []
    if isinstance(faces, FaceSample):
        for box in faces.boxes:
            norm = _normalise_single_face_box(box, source_width=sw, source_height=sh)
            if norm is not None:
                candidates.append(norm)
    elif isinstance(faces, Mapping):
        norm = _normalise_single_face_box(faces, source_width=sw, source_height=sh)
        if norm is not None:
            candidates.append(norm)
    elif isinstance(faces, Sequence) and not isinstance(faces, (str, bytes)):
        for item in faces:
            norm = _normalise_single_face_box(item, source_width=sw, source_height=sh)
            if norm is not None:
                candidates.append(norm)

    if not candidates:
        return 0.0, None

    largest = max(candidates, key=lambda b: b["width"] * b["height"])
    area_ratio = float(min(1.0, max(0.0, largest["width"] * largest["height"])))
    return area_ratio, {
        "x": round(largest["x"], 4),
        "y": round(largest["y"], 4),
        "width": round(largest["width"], 4),
        "height": round(largest["height"], 4),
    }


def compute_max_face_area_ratio(
    faces: Sequence[Any] | Mapping[str, Any] | FaceSample | float | None,
    *,
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
) -> float:
    """Return the largest detected face bounding-box area as a fraction ``0..1``
    of the total frame area.
    """
    ratio, _ = extract_primary_face_box(
        faces,
        source_width=source_width,
        source_height=source_height,
    )
    return ratio


# ---------------------------------------------------------------------------
# Core Frame & Timeline Scene Classifier
# ---------------------------------------------------------------------------


def classify_scene_frame(
    frame: NDArray[np.uint8],
    faces: Sequence[Any] | Mapping[str, Any] | FaceSample | float | None = None,
    *,
    max_face_area_ratio: float | None = None,
    edge_density_threshold: float = EDGE_DENSITY_THRESHOLD,
    max_face_area_ratio_threshold: float = MAX_FACE_AREA_RATIO_THRESHOLD,
    rect_fill_ratio_threshold: float = RECT_FILL_RATIO_THRESHOLD,
    source_width: int | None = None,
    source_height: int | None = None,
    pip_position: str = "bottom-center",
) -> SceneClassificationResult:
    """Classify a sampled video frame into ``SCENE_SCREEN_SHARE``
    (``SCREEN_SHARE_SLIDE``) vs ``SCENE_TALKING_HEAD`` (``TALKING_HEAD``).

    Decision logic (Pillar 3 §04 §4 & §5 Step 1):
    - Evaluates ``max_face_area_ratio`` (``<= 8%`` indicates no main talking head or
      only a small corner webcam PIP).
    - Evaluates Canny ``edge_density`` (``np.sum(edges > 0) / edges.size``),
      axis-aligned text/grid line density, and large uniform rectangle fill ratio.
    - If ``edge_density > 0.08`` and ``max_face_area_ratio < 0.08`` (or structured
      slide with uniform rectangle fill ``>= rect_fill_ratio_threshold`` and crisp
      text/UI edges while ``max_face_area_ratio < 0.08``), classifies frame as
      ``SCENE_SCREEN_SHARE``.
    """
    t0 = time.perf_counter()
    arr = np.asarray(frame, dtype=np.uint8)
    raw_h, raw_w = arr.shape[:2] if arr.ndim >= 2 else (DEFAULT_SOURCE_HEIGHT, DEFAULT_SOURCE_WIDTH)
    sw = source_width if source_width is not None else raw_w
    sh = source_height if source_height is not None else raw_h

    if max_face_area_ratio is not None:
        face_ratio, webcam_box = extract_primary_face_box(
            max_face_area_ratio,
            source_width=sw,
            source_height=sh,
        )
        if faces is not None and not isinstance(faces, (int, float)):
            _, parsed_box = extract_primary_face_box(faces, source_width=sw, source_height=sh)
            if parsed_box is not None:
                webcam_box = parsed_box
    else:
        face_ratio, webcam_box = extract_primary_face_box(
            faces,
            source_width=sw,
            source_height=sh,
        )

    working = _downsample_for_analysis(arr) if arr.size > 0 else arr
    if working.size == 0:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return SceneClassificationResult(
            scene_type=SCENE_TALKING_HEAD,
            classification=TALKING_HEAD,
            is_screen_share=False,
            layout_mode=LAYOUT_MODE_CROP_FACE,
            edge_density=0.0,
            axis_edge_density=0.0,
            rect_fill_ratio=0.0,
            max_face_area_ratio=face_ratio,
            confidence=0.5,
            latency_ms=elapsed_ms,
        )

    gray = to_grayscale(working)
    edges = compute_canny_edges(gray, 100, 200)
    raw_edge_density = float(np.sum(edges > 0) / edges.size) if edges.size > 0 else 0.0
    axis_density = compute_axis_aligned_line_density(gray)
    rect_fill = detect_uniform_rect_fill_ratio(gray)

    # Combine Canny edge density with high-frequency UI/slide structure when flat
    # slide backgrounds surround crisp text/code/table lines
    structured_slide_boost = (
        max(raw_edge_density, axis_density * 1.35 + 0.04)
        if (rect_fill >= rect_fill_ratio_threshold and axis_density >= 0.03)
        else raw_edge_density
    )
    effective_edge_density = max(raw_edge_density, structured_slide_boost)

    is_small_or_no_face = face_ratio < max_face_area_ratio_threshold
    is_screen_share = bool(
        is_small_or_no_face and effective_edge_density > edge_density_threshold
    )

    if is_screen_share:
        scene_type = SCENE_SCREEN_SHARE
        classification = SCREEN_SHARE_SLIDE
        has_webcam_pip = 0.0 < face_ratio < max_face_area_ratio_threshold and webcam_box is not None
        layout_mode = LAYOUT_MODE_PIP_BUBBLE if has_webcam_pip else LAYOUT_MODE_CANVAS_FIT
        pres_y = (
            PRESENTATION_FIT_Y
            if (has_webcam_pip and pip_position == "bottom-center")
            else CANVAS_FIT_CENTER_Y
        )
        edge_margin = min(1.0, (effective_edge_density - edge_density_threshold) / 0.12)
        face_margin = min(
            1.0,
            (max_face_area_ratio_threshold - face_ratio) / max(1e-6, max_face_area_ratio_threshold),
        )
        confidence = min(0.999, 0.80 + 0.10 * edge_margin + 0.10 * face_margin)
    else:
        scene_type = SCENE_TALKING_HEAD
        classification = TALKING_HEAD
        layout_mode = LAYOUT_MODE_CROP_FACE
        pres_y = 0
        webcam_box = None
        if face_ratio >= max_face_area_ratio_threshold:
            confidence = min(
                0.999,
                0.82 + min(0.17, (face_ratio - max_face_area_ratio_threshold) * 1.5),
            )
        else:
            confidence = min(
                0.999,
                0.78 + min(0.20, max(0.0, edge_density_threshold - effective_edge_density) * 2.5),
            )

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return SceneClassificationResult(
        scene_type=scene_type,
        classification=classification,
        is_screen_share=is_screen_share,
        layout_mode=layout_mode,
        edge_density=effective_edge_density,
        axis_edge_density=axis_density,
        rect_fill_ratio=rect_fill,
        max_face_area_ratio=face_ratio,
        confidence=confidence,
        latency_ms=elapsed_ms,
        pip_webcam_box=webcam_box,
        presentation_y=pres_y,
    )


def classify_video_scenes(
    frames: Sequence[NDArray[np.uint8]],
    face_samples: Sequence[Any] | None = None,
    *,
    sample_interval_sec: float = 0.5,
    min_segment_duration_sec: float = 1.0,
    edge_density_threshold: float = EDGE_DENSITY_THRESHOLD,
    max_face_area_ratio_threshold: float = MAX_FACE_AREA_RATIO_THRESHOLD,
) -> list[SceneSegment]:
    """Classify a sequence of sampled frames across a clip and merge consecutive
    frames into contiguous :class:`SceneSegment` intervals.
    """
    if not frames:
        return []

    dt = max(0.05, float(sample_interval_sec))
    per_frame: list[SceneClassificationResult] = []
    for idx, frame in enumerate(frames):
        faces_at_idx: Any = None
        if face_samples is not None and idx < len(face_samples):
            faces_at_idx = face_samples[idx]
        res = classify_scene_frame(
            frame,
            faces_at_idx,
            edge_density_threshold=edge_density_threshold,
            max_face_area_ratio_threshold=max_face_area_ratio_threshold,
        )
        per_frame.append(res)

    # Group consecutive frames with identical scene_type & layout_mode
    raw_segments: list[SceneSegment] = []
    start_idx = 0
    for idx in range(1, len(per_frame) + 1):
        if idx == len(per_frame) or (
            per_frame[idx].scene_type != per_frame[start_idx].scene_type
            or per_frame[idx].layout_mode != per_frame[start_idx].layout_mode
        ):
            group = per_frame[start_idx:idx]
            mean_edge = sum(r.edge_density for r in group) / len(group)
            max_face = max(r.max_face_area_ratio for r in group)
            pip_box = next((r.pip_webcam_box for r in group if r.pip_webcam_box is not None), None)
            first = group[0]
            raw_segments.append(
                SceneSegment(
                    start_sec=round(start_idx * dt, 4),
                    end_sec=round(idx * dt, 4),
                    scene_type=first.scene_type,
                    classification=first.classification,
                    layout_mode=first.layout_mode,
                    mean_edge_density=mean_edge,
                    max_face_area_ratio=max_face,
                    pip_webcam_box=pip_box,
                )
            )
            start_idx = idx

    if len(raw_segments) <= 1 or min_segment_duration_sec <= 0.0:
        return raw_segments

    # Suppress single-frame flicker shorter than min_segment_duration_sec
    merged: list[SceneSegment] = []
    for seg in raw_segments:
        dur = seg.end_sec - seg.start_sec
        if merged and (
            dur < min_segment_duration_sec
            or (
                merged[-1].scene_type == seg.scene_type
                and merged[-1].layout_mode == seg.layout_mode
            )
        ):
            prev = merged[-1]
            merged[-1] = SceneSegment(
                start_sec=prev.start_sec,
                end_sec=seg.end_sec,
                scene_type=prev.scene_type,
                classification=prev.classification,
                layout_mode=prev.layout_mode,
                mean_edge_density=0.5 * (prev.mean_edge_density + seg.mean_edge_density),
                max_face_area_ratio=max(prev.max_face_area_ratio, seg.max_face_area_ratio),
                pip_webcam_box=prev.pip_webcam_box or seg.pip_webcam_box,
            )
        else:
            merged.append(seg)

    return merged


async def process_scene_classifier(context: JobContext) -> ProcessorOutcome:
    """BullMQ processor entrypoint for screen share & presentation slide detection."""
    payload = context.envelope.payload if isinstance(context.envelope.payload, Mapping) else {}
    raw_frames = payload.get("frames", [])
    raw_faces = payload.get("faces", [])
    interval_sec = float(payload.get("sampleIntervalSec", 0.5))

    await context.progress(10, message="classifying video frames for screen share and slides")
    frames_np: list[NDArray[np.uint8]] = [
        np.asarray(f, dtype=np.uint8) for f in raw_frames if f is not None
    ]
    segments = classify_video_scenes(
        frames_np,
        raw_faces if isinstance(raw_faces, Sequence) else None,
        sample_interval_sec=interval_sec,
    )
    await context.progress(100, message="scene classification complete")

    has_screen_share = any(s.scene_type == SCENE_SCREEN_SHARE for s in segments)
    dominant_mode = (
        segments[0].layout_mode
        if len(segments) == 1
        else (
            LAYOUT_MODE_PIP_BUBBLE
            if any(s.layout_mode == LAYOUT_MODE_PIP_BUBBLE for s in segments)
            else LAYOUT_MODE_CANVAS_FIT
            if has_screen_share
            else LAYOUT_MODE_CROP_FACE
        )
    )
    _log.info(
        "scene classifier completed",
        extra={
            **context.envelope.log_fields(),
            "segments": len(segments),
            "hasScreenShare": has_screen_share,
            "dominantLayoutMode": dominant_mode,
        },
    )
    return ProcessorOutcome(
        result={
            "hasScreenShare": has_screen_share,
            "dominantLayoutMode": dominant_mode,
            "segments": [s.to_dict() for s in segments],
        },
        usage=JobUsage(
            media_seconds=len(frames_np) * interval_sec,
            provider="worker-ai/scene-classifier",
            cost_minor=0,
            actual_tenths=0,
        ),
    )
