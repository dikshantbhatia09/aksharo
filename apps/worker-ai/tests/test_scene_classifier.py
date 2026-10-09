"""Screen Share & Presentation Slide Detection Engine tests (Pillar 3 §04)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from numpy.typing import NDArray

from worker_ai.passes.faces import FaceBox, FaceSample
from worker_ai.processors.scene_classifier import (
    CANVAS_FIT_CENTER_Y,
    EDGE_DENSITY_THRESHOLD,
    LAYOUT_MODE_CANVAS_FIT,
    LAYOUT_MODE_CROP_FACE,
    LAYOUT_MODE_PIP_BUBBLE,
    MAX_CLASSIFICATION_LATENCY_MS,
    MAX_FACE_AREA_RATIO_THRESHOLD,
    MIN_DETECTION_ACCURACY_SLA,
    PRESENTATION_FIT_Y,
    SCENE_SCREEN_SHARE,
    SCENE_TALKING_HEAD,
    SCREEN_SHARE_SLIDE,
    TALKING_HEAD,
    classify_scene_frame,
    classify_video_scenes,
    compute_axis_aligned_line_density,
    compute_canny_edges,
    compute_edge_density,
    compute_max_face_area_ratio,
    detect_uniform_rect_fill_ratio,
    extract_primary_face_box,
    process_scene_classifier,
    to_grayscale,
)


def _make_powerpoint_slide_frame(
    width: int = 1920,
    height: int = 1080,
    *,
    seed: int = 101,
) -> NDArray[np.uint8]:
    """Generate a realistic 16:9 PowerPoint presentation slide frame with a
    clean uniform background, header banner, bullet-point text lines, and
    architecture diagram boxes.
    """
    rng = np.random.default_rng(seed)
    frame = np.full((height, width, 3), 248, dtype=np.uint8)

    banner_top = max(8, int(height * 0.04))
    banner_bot = max(banner_top + 16, int(height * 0.15))
    margin_x = max(12, int(width * 0.035))

    # Top title banner
    frame[banner_top:banner_bot, margin_x : width - margin_x] = (42, 28, 18)
    glyph_top = banner_top + max(4, (banner_bot - banner_top) // 4)
    glyph_bot = banner_bot - max(4, (banner_bot - banner_top) // 4)
    for col in range(margin_x + 16, int(width * 0.80), 8):
        if rng.random() > 0.15:
            frame[glyph_top:glyph_bot, col : col + 4] = (255, 255, 255)

    # Bullet-point text rows on the left half
    row_step = max(14, int(height * 0.042))
    glyph_h = max(6, int(row_step * 0.45))
    for row in range(banner_bot + row_step // 2, height - margin_x - glyph_h, row_step):
        frame[row : row + glyph_h, margin_x + 8 : margin_x + 8 + glyph_h] = (220, 90, 30)
        line_len = int(rng.integers(int(width * 0.25), int(width * 0.43)))
        start_c = margin_x + 14 + glyph_h
        for col in range(start_c, min(width // 2 - 8, start_c + line_len), 6):
            if (col // 6) % 7 != 0:
                frame[row : row + glyph_h, col : col + 3] = (25, 25, 30)

    # Diagram boxes & chart bars on the right half
    right_x = width // 2 + margin_x // 2
    box_area_top = banner_bot + row_step // 2
    box_area_h = max(60, height - box_area_top - margin_x)
    box_step = max(20, box_area_h // 4)
    bh = max(14, int(box_step * 0.76))
    bw = max(40, width - right_x - margin_x)
    for box_idx in range(4):
        by = box_area_top + box_idx * box_step
        if by + bh >= height:
            break
        frame[by : by + bh, right_x : right_x + bw] = (232, 238, 248)
        frame[by : by + 2, right_x : right_x + bw] = (40, 80, 160)
        frame[by + bh - 2 : by + bh, right_x : right_x + bw] = (40, 80, 160)
        frame[by : by + bh, right_x : right_x + 2] = (40, 80, 160)
        frame[by : by + bh, right_x + bw - 2 : right_x + bw] = (40, 80, 160)
        for col in range(right_x + 10, right_x + bw - 10, 6):
            frame[by + 4 : by + max(6, bh // 2), col : col + 3] = (25, 40, 70)

    return frame


def _make_code_editor_frame(
    width: int = 1920,
    height: int = 1080,
    *,
    seed: int = 202,
) -> NDArray[np.uint8]:
    """Generate a realistic VS Code / IDE software demo frame with dark theme
    background, file-tree sidebar, line-number gutter, syntax-highlighted code
    tokens, and bottom terminal panel.
    """
    rng = np.random.default_rng(seed)
    frame = np.full((height, width, 3), 30, dtype=np.uint8)

    # Activity bar + File explorer sidebar
    sidebar_w = max(60, int(width * 0.18))
    frame[:, :sidebar_w] = (37, 37, 38)
    frame[:, sidebar_w : sidebar_w + 2] = (65, 65, 70)
    row_step_sb = max(10, int(height * 0.025))
    for row in range(max(12, int(height * 0.05)), height - 16, row_step_sb):
        indent = int(rng.integers(8, max(12, sidebar_w // 4)))
        max_tok = max(indent + 16, sidebar_w - 8)
        for col in range(indent, max_tok, 6):
            frame[row : row + max(4, row_step_sb // 2), col : col + 3] = (204, 204, 204)

    # Top tab bar
    tab_h = max(12, int(height * 0.038))
    frame[:tab_h, sidebar_w:] = (45, 45, 48)
    frame[tab_h - 1 : tab_h + 1, sidebar_w:] = (80, 80, 90)

    # Code editor lines + syntax tokens
    palette = [
        (212, 212, 212),
        (156, 220, 254),
        (206, 145, 120),
        (78, 201, 176),
        (220, 220, 170),
        (197, 134, 192),
    ]
    gutter_x = sidebar_w + max(20, int(width * 0.03))
    frame[tab_h:, gutter_x : gutter_x + 1] = (60, 60, 65)
    code_step = max(9, int(height * 0.022))
    glyph_h = max(4, code_step // 2)
    for row in range(tab_h + 6, int(height * 0.72), code_step):
        frame[row : row + glyph_h, sidebar_w + 4 : gutter_x - 4 : 4] = (133, 133, 133)
        indent_px = gutter_x + 8 + int(rng.integers(0, 5)) * max(6, int(width * 0.012))
        span_min = max(40, int(width * 0.15))
        span_max = max(span_min + 20, int(width * 0.58))
        line_end = min(width - 12, indent_px + int(rng.integers(span_min, span_max)))
        color = palette[int(rng.integers(0, len(palette)))]
        for col in range(indent_px, line_end, 6):
            if (col // 6) % 6 == 0:
                color = palette[int(rng.integers(0, len(palette)))]
                continue
            frame[row : row + glyph_h, col : col + 3] = color

    # Bottom terminal panel
    term_y = int(height * 0.74)
    frame[term_y : term_y + 2, sidebar_w:] = (90, 90, 100)
    for row in range(term_y + 8, height - 10, code_step):
        line_end = min(width - 16, sidebar_w + int(width * 0.55))
        for col in range(sidebar_w + 10, line_end, 6):
            frame[row : row + glyph_h, col : col + 3] = (180, 230, 180)

    return frame


def _make_excel_spreadsheet_frame(
    width: int = 1920,
    height: int = 1080,
    *,
    seed: int = 303,
) -> NDArray[np.uint8]:
    """Generate a realistic financial spreadsheet frame with formula bar,
    column/row headers, dense cell gridlines, and numeric cell entries.
    """
    rng = np.random.default_rng(seed)
    frame = np.full((height, width, 3), 255, dtype=np.uint8)

    # Top ribbon & header
    ribbon_h = max(18, int(height * 0.085))
    formula_h = max(28, int(height * 0.12))
    frame[:ribbon_h, :] = (33, 115, 70)
    frame[ribbon_h:formula_h, :] = (243, 242, 241)
    frame[formula_h - 1 : formula_h + 1, :] = (160, 160, 160)

    # Gridlines & cell numbers
    row_h = max(12, int(height * 0.028))
    col_w = max(36, int(width * 0.065))
    for y in range(formula_h, height, row_h):
        frame[y : y + 1, :] = (195, 195, 195)
    for x in range(max(20, int(width * 0.03)), width, col_w):
        frame[formula_h:, x : x + 1] = (195, 195, 195)

    glyph_h = max(4, row_h // 2)
    for r_idx, y in enumerate(range(formula_h + 3, height - row_h, row_h)):
        for _c_idx, x in enumerate(range(max(24, int(width * 0.035)), width - col_w, col_w)):
            if r_idx == 0 or rng.random() > 0.15:
                for cx in range(x + 4, x + col_w - 6, 6):
                    frame[y : y + glyph_h, cx : cx + 3] = (25, 25, 25)

    return frame


def _make_studio_interview_frame(
    width: int = 1920,
    height: int = 1080,
    *,
    seed: int = 404,
) -> NDArray[np.uint8]:
    """Generate a natural studio camera interview frame with smooth lighting
    gradients, soft background bokeh, and sensor noise (low high-frequency edge
    density and prominent speaker face).
    """
    rng = np.random.default_rng(seed)
    y_grad = np.linspace(45.0, 115.0, height, dtype=np.float32)[:, None]
    x_grad = np.linspace(60.0, 130.0, width, dtype=np.float32)[None, :]
    base = 0.5 * (y_grad + x_grad)
    noise = rng.normal(0.0, 6.5, size=(height, width)).astype(np.float32)
    ch_b = np.clip(base + noise - 10.0, 0, 255).astype(np.uint8)
    ch_g = np.clip(base + noise, 0, 255).astype(np.uint8)
    ch_r = np.clip(base + noise + 14.0, 0, 255).astype(np.uint8)
    return np.stack([ch_b, ch_g, ch_r], axis=-1)


def test_classifier_identifies_powerpoint_code_editor_and_excel_vs_studio_interview() -> None:
    """Unit test (Pillar 3 §04 §5 Step 4):
    Classifier correctly identifies PowerPoint slides, code editors, and Excel
    sheets vs studio interviews.
    """
    ppt_frame = _make_powerpoint_slide_frame()
    code_frame = _make_code_editor_frame()
    excel_frame = _make_excel_spreadsheet_frame()
    studio_frame = _make_studio_interview_frame()

    # 1. PowerPoint slide (no face) -> SCENE_SCREEN_SHARE / CANVAS_FIT
    ppt_res = classify_scene_frame(ppt_frame, faces=None)
    assert ppt_res == SCENE_SCREEN_SHARE
    assert ppt_res == SCREEN_SHARE_SLIDE
    assert ppt_res.is_screen_share is True
    assert ppt_res.layout_mode == LAYOUT_MODE_CANVAS_FIT
    assert ppt_res.edge_density > EDGE_DENSITY_THRESHOLD
    assert ppt_res.max_face_area_ratio == 0.0
    assert ppt_res.presentation_y == CANVAS_FIT_CENTER_Y

    # 2. VS Code editor demo (no face) -> SCENE_SCREEN_SHARE / CANVAS_FIT
    code_res = classify_scene_frame(code_frame, faces=[])
    assert code_res.scene_type == SCENE_SCREEN_SHARE
    assert code_res.classification == SCREEN_SHARE_SLIDE
    assert code_res.is_screen_share is True
    assert code_res.layout_mode == LAYOUT_MODE_CANVAS_FIT
    assert code_res.edge_density > EDGE_DENSITY_THRESHOLD

    # 3. Excel spreadsheet with tiny corner presenter webcam (< 8% frame area) -> PIP_BUBBLE
    webcam_pip_face = [FaceBox(x=0.82, y=0.76, w=0.14, h=0.20, score=0.96)]  # area = 2.8% < 8%
    excel_res = classify_scene_frame(
        excel_frame,
        faces=webcam_pip_face,
        pip_position="bottom-center",
    )
    assert excel_res.scene_type == SCENE_SCREEN_SHARE
    assert excel_res.classification == SCREEN_SHARE_SLIDE
    assert excel_res.is_screen_share is True
    assert excel_res.layout_mode == LAYOUT_MODE_PIP_BUBBLE
    assert 0.0 < excel_res.max_face_area_ratio < MAX_FACE_AREA_RATIO_THRESHOLD
    assert excel_res.pip_webcam_box == {
        "x": 0.82,
        "y": 0.76,
        "width": 0.14,
        "height": 0.2,
    }
    assert excel_res.presentation_y == PRESENTATION_FIT_Y

    # 4. Studio talking-head interview (face covers 12% >= 8%) -> SCENE_TALKING_HEAD / CROP_FACE
    studio_face = [FaceBox(x=0.35, y=0.18, w=0.30, h=0.42, score=0.98)]  # area = 12.6% >= 8%
    studio_res = classify_scene_frame(studio_frame, faces=studio_face)
    assert studio_res == SCENE_TALKING_HEAD
    assert studio_res == TALKING_HEAD
    assert studio_res.is_screen_share is False
    assert studio_res.layout_mode == LAYOUT_MODE_CROP_FACE
    assert studio_res.max_face_area_ratio >= MAX_FACE_AREA_RATIO_THRESHOLD
    assert studio_res.pip_webcam_box is None

    # 5. Studio frame when speaker briefly looks away (0 faces, low edge) -> SCENE_TALKING_HEAD
    studio_no_face_res = classify_scene_frame(studio_frame, faces=None)
    assert studio_no_face_res.scene_type == SCENE_TALKING_HEAD
    assert studio_no_face_res.is_screen_share is False
    assert studio_no_face_res.layout_mode == LAYOUT_MODE_CROP_FACE


def test_screen_share_detection_accuracy_and_latency_slas() -> None:
    """SLA Verification (Pillar 3 §04 §1):
    - Slide / screen share detection accuracy: >= 98.2%.
    - Classification latency: <= 15 ms per sampled frame.
    """
    samples: list[tuple[NDArray[np.uint8], Any, bool]] = []
    # Generate 120 diverse screen-share frames (40 PowerPoint, 40 Code Editor, 40 Excel)
    for i in range(40):
        samples.append((_make_powerpoint_slide_frame(640, 360, seed=1000 + i), None, True))
        samples.append(
            (
                _make_code_editor_frame(640, 360, seed=2000 + i),
                [{"x": 0.84, "y": 0.78, "width": 0.12, "height": 0.18}],
                True,
            )
        )
        samples.append((_make_excel_spreadsheet_frame(640, 360, seed=3000 + i), 0.03, True))

    # Generate 80 diverse studio interview frames (with talking-head faces and b-roll)
    for i in range(40):
        samples.append(
            (
                _make_studio_interview_frame(640, 360, seed=4000 + i),
                [FaceBox(x=0.32, y=0.20, w=0.28, h=0.40, score=0.95)],
                False,
            )
        )
        samples.append((_make_studio_interview_frame(640, 360, seed=5000 + i), None, False))

    correct = 0
    latencies_ms: list[float] = []
    for frame, faces, expected_is_screen_share in samples:
        res = classify_scene_frame(frame, faces)
        latencies_ms.append(res.latency_ms)
        if res.is_screen_share is expected_is_screen_share:
            correct += 1

    accuracy = correct / len(samples)
    mean_latency_ms = sum(latencies_ms) / len(latencies_ms)
    p95_latency_ms = float(np.percentile(latencies_ms, 95))

    assert accuracy >= MIN_DETECTION_ACCURACY_SLA, (
        f"Expected accuracy >= {MIN_DETECTION_ACCURACY_SLA * 100:.1f}%, got {accuracy * 100:.2f}%"
    )
    assert mean_latency_ms <= MAX_CLASSIFICATION_LATENCY_MS, (
        f"Expected mean latency <= {MAX_CLASSIFICATION_LATENCY_MS}ms, got {mean_latency_ms:.2f}ms"
    )
    assert p95_latency_ms <= MAX_CLASSIFICATION_LATENCY_MS, (
        f"Expected p95 latency <= {MAX_CLASSIFICATION_LATENCY_MS}ms, got {p95_latency_ms:.2f}ms"
    )


def test_face_area_ratio_and_vision_helpers_handle_all_input_shapes() -> None:
    """Verifies pixel vs normalised face boxes, FaceSample, and vision feature helpers."""
    # Pixel coordinates on 1920x1080: 192x108 box = 1% area
    ratio_px, box_px = extract_primary_face_box(
        [[1600, 860, 192, 108]],
        source_width=1920,
        source_height=1080,
    )
    assert ratio_px == pytest.approx(0.01, abs=1e-4)
    assert box_px is not None
    assert box_px["width"] == pytest.approx(0.10, abs=1e-3)
    assert box_px["height"] == pytest.approx(0.10, abs=1e-3)

    # FaceSample input
    sample = FaceSample(
        t_ms=500,
        boxes=(
            FaceBox(x=0.80, y=0.75, w=0.10, h=0.15, score=0.9),
            FaceBox(x=0.10, y=0.20, w=0.20, h=0.25, score=0.95),
        ),
    )
    assert compute_max_face_area_ratio(sample) == pytest.approx(0.05, abs=1e-4)

    # Mapping with explicit areaRatio
    area_map = {"areaRatio": 0.04, "centerX": 0.85, "centerY": 0.8}
    assert compute_max_face_area_ratio(area_map) == pytest.approx(0.04, abs=1e-3)
    assert compute_max_face_area_ratio(0.0) == 0.0

    # Grayscale & Canny on 2D array
    ppt = _make_powerpoint_slide_frame(480, 270)
    gray = to_grayscale(ppt)
    assert gray.ndim == 2
    assert to_grayscale(gray) is gray
    edges = compute_canny_edges(gray)
    assert edges.shape == gray.shape
    assert compute_edge_density(ppt, downsample=False) > EDGE_DENSITY_THRESHOLD
    assert compute_axis_aligned_line_density(gray) > 0.03
    assert detect_uniform_rect_fill_ratio(gray) > 0.35


@pytest.mark.asyncio
async def test_classify_video_scenes_and_process_scene_classifier() -> None:
    """Verifies timeline segmentation with flicker suppression and async job processor."""
    studio = _make_studio_interview_frame(480, 270)
    slide = _make_powerpoint_slide_frame(480, 270)
    code = _make_code_editor_frame(480, 270)

    # 0..2s talking head -> 2..4s screen share slide -> 4..6s code editor with PIP webcam
    frames = [studio, studio, studio, studio, slide, slide, slide, slide, code, code, code, code]
    faces: list[Any] = [
        [FaceBox(0.3, 0.2, 0.35, 0.45, 0.98)],
        [FaceBox(0.3, 0.2, 0.35, 0.45, 0.98)],
        [FaceBox(0.3, 0.2, 0.35, 0.45, 0.98)],
        [FaceBox(0.3, 0.2, 0.35, 0.45, 0.98)],
        None,
        None,
        None,
        None,
        [FaceBox(0.84, 0.78, 0.12, 0.18, 0.95)],
        [FaceBox(0.84, 0.78, 0.12, 0.18, 0.95)],
        [FaceBox(0.84, 0.78, 0.12, 0.18, 0.95)],
        [FaceBox(0.84, 0.78, 0.12, 0.18, 0.95)],
    ]

    segments = classify_video_scenes(
        frames,
        faces,
        sample_interval_sec=0.5,
        min_segment_duration_sec=1.0,
    )
    assert len(segments) == 3
    assert segments[0].scene_type == SCENE_TALKING_HEAD
    assert segments[0].layout_mode == LAYOUT_MODE_CROP_FACE
    assert segments[1].scene_type == SCENE_SCREEN_SHARE
    assert segments[1].layout_mode == LAYOUT_MODE_CANVAS_FIT
    assert segments[2].scene_type == SCENE_SCREEN_SHARE
    assert segments[2].layout_mode == LAYOUT_MODE_PIP_BUBBLE
    assert segments[2].pip_webcam_box is not None

    class _FakeEnvelope:
        def __init__(self) -> None:
            self.payload: dict[str, Any] = {
                "frames": [slide, code],
                "faces": [None, [{"x": 0.84, "y": 0.78, "width": 0.12, "height": 0.18}]],
                "sampleIntervalSec": 1.0,
            }

        def log_fields(self) -> dict[str, str]:
            return {"jobId": "test-scene-classifier-job"}

    class _FakeContext:
        envelope = _FakeEnvelope()
        workdir = Path(".")

        async def progress(self, pct: int, *, message: str = "") -> None:
            assert 0 <= pct <= 100
            assert isinstance(message, str)

    outcome = await process_scene_classifier(_FakeContext())  # type: ignore[arg-type]
    assert outcome.result["hasScreenShare"] is True
    assert outcome.result["dominantLayoutMode"] == LAYOUT_MODE_PIP_BUBBLE
    assert len(outcome.result["segments"]) == 2
