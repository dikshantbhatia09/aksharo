"""Pillar 3 §07: Streamer Gameplay & Facecam Split Engine Tests.

Verifies:
- Automatic Corner Facecam Detection (top-left, top-right, bottom-left, bottom-right)
- Position stability validation (rejection of wandering faces)
- >= 97.0% Facecam Detection SLA across streamer & non-streamer streams
- Manual override facecam crop handling
- Pixel-perfect Top 35% (Webcam) and Bottom 65% (Gameplay) crop calculation
"""

from __future__ import annotations

import numpy as np
import pytest

from worker_ai.passes.faces import (
    DEFAULT_STREAMER_DIVIDER_COLOR,
    FaceBox,
    FaceSample,
    FacecamRect,
    LAYOUT_SINGLE_SPEAKER,
    LAYOUT_STREAMER_SPLIT,
    StreamerClassification,
    classify_streamer_layout,
    detect_corner_facecam,
)


def test_detects_facecam_in_all_four_corners() -> None:
    """Detects corner facecam accurately across top-left, top-right, bottom-left, bottom-right."""
    corners = {
        "top-left": (0.05, 0.05),
        "top-right": (0.80, 0.06),
        "bottom-left": (0.06, 0.72),
        "bottom-right": (0.78, 0.70),
    }

    for expected_corner, (cx, cy) in corners.items():
        # Streamer sitting in their corner webcam overlay: stable face with small jitter
        samples = [
            FaceSample(
                t_ms=t * 250,
                boxes=(
                    FaceBox(
                        x=cx + float(np.sin(t * 0.1) * 0.003),
                        y=cy + float(np.cos(t * 0.1) * 0.003),
                        w=0.12,
                        h=0.16,
                        score=0.96,
                    ),
                ),
            )
            for t in range(40)
        ]

        result = detect_corner_facecam(samples, source_width=1920, source_height=1080)
        assert result is not None, f"Failed to detect facecam in {expected_corner}"
        assert result.corner == expected_corner
        assert result.presence_share == 1.0
        assert result.stability_score > 0.85
        assert result.std_x < 0.015
        assert result.std_y < 0.015


def test_rejects_wandering_speaker_or_vlogger_as_facecam() -> None:
    """A walking or roaming speaker with high position variance is NOT classified as a stationary facecam."""
    rng = np.random.default_rng(42)
    # Speaker walking back and forth across the frame (x moves from 0.10 to 0.75)
    wandering_samples = [
        FaceSample(
            t_ms=t * 250,
            boxes=(
                FaceBox(
                    x=float(0.10 + (t / 40.0) * 0.65),
                    y=0.30 + float(rng.normal(0, 0.02)),
                    w=0.14,
                    h=0.18,
                    score=0.92,
                ),
            ),
        )
        for t in range(40)
    ]

    detected = detect_corner_facecam(wandering_samples, source_width=1920, source_height=1080)
    assert detected is None

    classification = classify_streamer_layout(
        wandering_samples, source_width=1920, source_height=1080
    )
    assert classification.is_streamer is False
    assert classification.layout == LAYOUT_SINGLE_SPEAKER


def test_facecam_detection_accuracy_exceeds_97_percent_sla() -> None:
    """SLA Verification: >= 97.0% classification accuracy across 100 streamer and non-streamer setups."""
    rng = np.random.default_rng(20261010)
    correct = 0
    total = 100

    corner_coords = [
        ("top-left", 0.04, 0.05),
        ("top-right", 0.78, 0.05),
        ("bottom-left", 0.04, 0.68),
        ("bottom-right", 0.78, 0.68),
    ]

    for idx in range(total):
        if idx < 50:
            # Streamer stream: one stationary face in a corner overlay with small game artifacts
            corner_name, base_cx, base_cy = corner_coords[idx % 4]
            samples = []
            for t in range(32):
                # 90% chance streamer face is visible
                has_streamer = rng.uniform() > 0.10
                boxes: list[FaceBox] = []
                if has_streamer:
                    jitter_x = float(rng.normal(0, 0.005))
                    jitter_y = float(rng.normal(0, 0.005))
                    boxes.append(
                        FaceBox(
                            x=base_cx + jitter_x,
                            y=base_cy + jitter_y,
                            w=0.10 + float(rng.normal(0, 0.002)),
                            h=0.14 + float(rng.normal(0, 0.002)),
                            score=0.95,
                        )
                    )
                # Occasional in-game character face in central gameplay area
                if rng.uniform() > 0.70:
                    boxes.append(
                        FaceBox(
                            x=0.45 + float(rng.uniform(-0.08, 0.08)),
                            y=0.45 + float(rng.uniform(-0.08, 0.08)),
                            w=0.08,
                            h=0.10,
                            score=0.75,
                        )
                    )
                samples.append(FaceSample(t_ms=t * 250, boxes=tuple(boxes)))

            res = classify_streamer_layout(samples, source_width=1920, source_height=1080)
            if res.is_streamer and res.layout == LAYOUT_STREAMER_SPLIT and res.facecam_rect is not None:
                if res.facecam_rect.corner == corner_name:
                    correct += 1
        else:
            # Non-streamer video: centered interview or podcast or single presenter
            solo_cx = float(rng.uniform(0.40, 0.60))
            solo_cy = float(rng.uniform(0.28, 0.45))
            samples = [
                FaceSample(
                    t_ms=t * 250,
                    boxes=(
                        FaceBox(
                            x=solo_cx - 0.05 + float(rng.normal(0, 0.008)),
                            y=solo_cy - 0.08 + float(rng.normal(0, 0.008)),
                            w=0.10,
                            h=0.16,
                            score=0.96,
                        ),
                    ),
                )
                for t in range(32)
            ]
            res = classify_streamer_layout(samples, source_width=1920, source_height=1080)
            if not res.is_streamer and res.layout == LAYOUT_SINGLE_SPEAKER:
                correct += 1

    accuracy = correct / total
    assert accuracy >= 0.97, f"Expected >= 97.0% SLA accuracy, got {accuracy * 100:.1f}%"


def test_computes_exact_crop_geometries_for_streamer_layout() -> None:
    """Verifies Top 35% webcam crop and Bottom 65% gameplay crop calculations."""
    samples = [
        FaceSample(
            t_ms=t * 250,
            boxes=(
                FaceBox(x=0.78, y=0.70, w=0.10, h=0.14, score=0.95),
            ),
        )
        for t in range(20)
    ]

    res = classify_streamer_layout(
        samples,
        source_width=1920,
        source_height=1080,
        canvas_width=1080,
        canvas_height=1920,
    )

    assert res.is_streamer is True
    assert res.layout == LAYOUT_STREAMER_SPLIT
    assert res.top_pane_height == 672  # 35% of 1920 = 672
    assert res.bottom_pane_height == 1248  # 65% of 1920 = 1248
    assert res.divider_color == DEFAULT_STREAMER_DIVIDER_COLOR

    # Gameplay crop check: centered horizontally on 16:9 frame, full height
    # 1080 / 1248 * 1080 = 934 px width
    assert res.gameplay_crop["height"] == 1080
    assert res.gameplay_crop["width"] == 934
    assert res.gameplay_crop["x"] == 492
    assert res.gameplay_crop["y"] == 0

    # Facecam crop check: bounded within source
    cam = res.facecam_crop
    assert cam["x"] >= 0 and (cam["x"] + cam["width"]) <= 1920
    assert cam["y"] >= 0 and (cam["y"] + cam["height"]) <= 1080
    assert cam["width"] > 0 and cam["height"] > 0


def test_supports_manual_facecam_crop_override() -> None:
    """Allows manual creator override of facecam crop bounding box."""
    manual = {"x": 0.05, "y": 0.05, "width": 0.22, "height": 0.26}
    res = classify_streamer_layout(
        samples=None,
        source_width=1920,
        source_height=1080,
        manual_facecam_crop=manual,
        divider_color="#00FFA3",
    )

    assert res.is_streamer is True
    assert res.layout == LAYOUT_STREAMER_SPLIT
    assert res.confidence == 1.0
    assert res.divider_color == "#00FFA3"
    assert res.facecam_rect is not None
    assert res.facecam_rect.corner == "top-left"
    assert res.facecam_crop["x"] == int(0.05 * 1920 // 2 * 2)
    assert res.facecam_crop["y"] == int(0.05 * 1080 // 2 * 2)
