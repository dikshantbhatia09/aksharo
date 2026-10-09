"""Automated Multi-Cam Director Engine & Multi-Speaker Grid Switcher tests (Pillar 3 §03)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from worker_ai.passes.faces import FaceBox, FaceSample
from worker_ai.processors.director import (
    FALSE_SWITCH_MAX_DURATION_SEC,
    LAYOUT_GRID_4,
    LAYOUT_SOLO,
    LAYOUT_SPLIT_2,
    LAYOUT_TRI_PANEL,
    LEAD_IN_PADDING_SEC,
    LEAD_OUT_PADDING_SEC,
    MIN_SHOT_DURATION_SEC,
    DiarizedTurn,
    DirectorStateMachine,
    apply_layout_override,
    apply_lead_padding,
    cluster_multispeaker_faces,
    compute_pane_assignments,
    filter_non_dialogue_vocalizations,
    generate_director_edl,
    normalise_diarization_turns,
    normalise_speaker_boxes,
    process_director,
)


def _four_speaker_boxes() -> dict[str, dict[str, float]]:
    return {
        "SPEAKER_00": {"x": 0.08, "y": 0.22, "width": 0.14, "height": 0.24},
        "SPEAKER_01": {"x": 0.32, "y": 0.22, "width": 0.14, "height": 0.24},
        "SPEAKER_02": {"x": 0.56, "y": 0.22, "width": 0.14, "height": 0.24},
        "SPEAKER_03": {"x": 0.78, "y": 0.22, "width": 0.14, "height": 0.24},
    }


def test_director_state_machine_4_person_discussion_enforces_zero_cuts_shorter_than_2_seconds() -> None:
    """Unit test (Pillar 3 §03 §5 Step 4):
    Director state machine on a 4-person discussion asserting zero cuts shorter than 2.0s.
    """
    turns = [
        # Speaker 00 opens with a 5.5s monologue
        {"speakerId": "SPEAKER_00", "startSec": 0.0, "endSec": 5.5, "text": "Here is our Q4 thesis."},
        # Brief 0.6s affirmative grunt from Speaker 01 ("yeah") during/after Speaker 00
        {"speakerId": "SPEAKER_01", "startSec": 2.4, "endSec": 3.0, "text": "yeah"},
        # Rapid 4-way roundtable debate (< 1.8s per turn)
        {"speakerId": "SPEAKER_01", "startSec": 5.6, "endSec": 7.0, "text": "Hold on, look at margins."},
        {"speakerId": "SPEAKER_02", "startSec": 7.1, "endSec": 8.4, "text": "Exactly what I said!"},
        {"speakerId": "SPEAKER_03", "startSec": 8.5, "endSec": 9.8, "text": "Wait, wait a second."},
        {"speakerId": "SPEAKER_00", "startSec": 9.9, "endSec": 11.2, "text": "Let me finish the numbers."},
        # Speaker 02 delivers a 6.0s monologue
        {"speakerId": "SPEAKER_02", "startSec": 11.4, "endSec": 17.4, "text": "When we break down enterprise retention across cohorts..."},
        # Brief cough (< 1.2s) from Speaker 03 at 14.0s
        {"speakerId": "SPEAKER_03", "startSec": 14.0, "endSec": 14.7, "vocalType": "cough", "text": "[cough]"},
        # Group laughter / reaction at 17.5s .. 20.2s
        {"speakerId": "GROUP", "startSec": 17.5, "endSec": 20.2, "isReaction": True},
        # Speaker 03 closes with a 5.0s monologue, plus a tiny 0.9s tail remark by Speaker 01
        {"speakerId": "SPEAKER_03", "startSec": 20.3, "endSec": 25.1, "text": "That wraps up the entire macro picture for this quarter."},
        {"speakerId": "SPEAKER_01", "startSec": 25.2, "endSec": 26.0, "text": "uh-huh"},
    ]

    director = DirectorStateMachine(min_shot_duration_sec=MIN_SHOT_DURATION_SEC)
    edl = director.plan_edl(turns, _four_speaker_boxes(), clip_start_sec=0.0, clip_duration_sec=26.0)

    assert len(edl) >= 3
    # Contiguous coverage from 0.0s to 26.0s
    assert edl[0].start_sec == pytest.approx(0.0)
    assert edl[-1].end_sec == pytest.approx(26.0)
    for prev_cut, next_cut in zip(edl, edl[1:]):
        assert prev_cut.end_sec == pytest.approx(next_cut.start_sec, abs=1e-3)

    # Assert strictly ZERO cuts shorter than 2.0s (MIN_SHOT_DURATION_SEC)
    for cut in edl:
        duration = cut.end_sec - cut.start_sec
        assert duration >= MIN_SHOT_DURATION_SEC, (
            f"Cut {cut} has duration {duration:.3f}s < {MIN_SHOT_DURATION_SEC}s"
        )
        assert cut.durationSec == pytest.approx(duration, abs=1e-3)
        assert cut.startSec == cut.start_sec
        assert cut.endSec == cut.end_sec
        assert cut.layoutType == cut.layout_type
        assert cut.activeSpeakerId == cut.active_speaker_id
        assert len(cut.paneAssignments) == len(cut.pane_assignments)
        for pane in cut.paneAssignments:
            assert pane.speakerId == pane.speaker_id
            assert pane.cropRect == pane.crop_rect
            assert pane.canvasPosition == pane.canvas_position

    # Verify both SOLO and multi-speaker grid cuts were selected
    layout_types = {cut.layout_type for cut in edl}
    assert LAYOUT_SOLO in layout_types
    assert bool(layout_types & {LAYOUT_TRI_PANEL, LAYOUT_GRID_4})


def test_tri_panel_and_grid_4_canvas_geometry_and_distortion_free_crops() -> None:
    """Verifies Tri-Panel Stack (Active Speaker in Top 60% = 1080x1152, Two Panelists in
    Bottom 40% = 540x768) and 2x2 Grid (4 x 540x960) pane geometry.
    """
    three_speaker_boxes = {
        "SPEAKER_00": {"x": 0.10, "y": 0.25, "width": 0.16, "height": 0.26},
        "SPEAKER_01": {"x": 0.42, "y": 0.25, "width": 0.16, "height": 0.26},
        "SPEAKER_02": {"x": 0.74, "y": 0.25, "width": 0.16, "height": 0.26},
    }
    turns_3 = [
        {"speakerId": "SPEAKER_00", "startSec": 0.0, "endSec": 1.5},
        {"speakerId": "SPEAKER_01", "startSec": 1.5, "endSec": 3.0},
        {"speakerId": "SPEAKER_02", "startSec": 3.0, "endSec": 4.5},
    ]
    edl_tri = generate_director_edl(turns_3, three_speaker_boxes, clip_duration_sec=4.5)
    assert len(edl_tri) == 1
    tri_cut = edl_tri[0]
    assert tri_cut.layout_type == LAYOUT_TRI_PANEL
    assert len(tri_cut.pane_assignments) == 3

    # Top pane is Active Speaker in Top 60% (1080 x 1152)
    top_pane = tri_cut.pane_assignments[0]
    assert top_pane.speaker_id == "SPEAKER_00"
    assert top_pane.canvas_position == {"x": 0, "y": 0, "width": 1080, "height": 1152}

    # Bottom two panes are 540 x 768 at y = 1152 (Bottom 40%)
    bl_pane = tri_cut.pane_assignments[1]
    br_pane = tri_cut.pane_assignments[2]
    assert bl_pane.canvas_position == {"x": 0, "y": 1152, "width": 540, "height": 768}
    assert br_pane.canvas_position == {"x": 540, "y": 1152, "width": 540, "height": 768}

    # 4-speaker rapid reaction produces GRID_4 (four 540 x 960 tiles)
    turns_4 = [
        {"speakerId": "SPEAKER_00", "startSec": 0.0, "endSec": 1.4},
        {"speakerId": "SPEAKER_01", "startSec": 1.4, "endSec": 2.7},
        {"speakerId": "SPEAKER_02", "startSec": 2.7, "endSec": 4.0},
        {"speakerId": "SPEAKER_03", "startSec": 4.0, "endSec": 5.4},
    ]
    edl_grid4 = generate_director_edl(turns_4, _four_speaker_boxes(), clip_duration_sec=5.4)
    assert len(edl_grid4) == 1
    grid_cut = edl_grid4[0]
    assert grid_cut.layout_type == LAYOUT_GRID_4
    assert len(grid_cut.pane_assignments) == 4
    expected_positions = [
        {"x": 0, "y": 0, "width": 540, "height": 960},
        {"x": 540, "y": 0, "width": 540, "height": 960},
        {"x": 0, "y": 960, "width": 540, "height": 960},
        {"x": 540, "y": 960, "width": 540, "height": 960},
    ]
    for pane, expected_pos in zip(grid_cut.pane_assignments, expected_positions):
        assert pane.canvas_position == expected_pos
        crop_ratio = pane.crop_rect["width"] / pane.crop_rect["height"]
        tile_ratio = expected_pos["width"] / expected_pos["height"]
        assert crop_ratio == pytest.approx(tile_ratio, abs=0.02)

    # SPLIT_2 layout produces two 1080 x 960 panes
    norm_boxes = normalise_speaker_boxes(three_speaker_boxes)
    split2_panes = compute_pane_assignments(LAYOUT_SPLIT_2, "SPEAKER_00", norm_boxes)
    assert len(split2_panes) == 2
    assert split2_panes[0].canvas_position == {"x": 0, "y": 0, "width": 1080, "height": 960}
    assert split2_panes[1].canvas_position == {"x": 0, "y": 960, "width": 1080, "height": 960}


def test_false_switch_rejection_exceeds_98_5_percent_sla() -> None:
    """SLA Verification (Pillar 3 §03 §1):
    False switch rejection (ignoring brief non-dialogue vocalizations < 1.2s): >= 98.5%.
    """
    rng = np.random.default_rng(20261010)
    dialogue_turns = [
        {
            "speakerId": f"SPEAKER_{i % 4:02d}",
            "startSec": float(i * 5.0),
            "endSec": float((i + 1) * 5.0 - 0.1),
            "text": "Substantive analysis of the market dynamics.",
        }
        for i in range(100)
    ]

    total_interjections = 200
    interjections = []
    tokens = ["yeah", "uh-huh", "mm-hmm", "[cough]", "right", "yup"]
    for idx in range(total_interjections):
        host_turn_idx = idx % 100
        host_sp = f"SPEAKER_{host_turn_idx % 4:02d}"
        other_sp = f"SPEAKER_{(host_turn_idx + 1 + (idx % 3)) % 4:02d}"
        assert other_sp != host_sp
        dur = float(rng.uniform(0.15, FALSE_SWITCH_MAX_DURATION_SEC - 0.05))
        start = float(host_turn_idx * 5.0 + rng.uniform(0.8, 3.2))
        interjections.append(
            {
                "speakerId": other_sp,
                "startSec": start,
                "endSec": start + dur,
                "text": tokens[idx % len(tokens)],
            }
        )

    normalised = normalise_diarization_turns([*dialogue_turns, *interjections])
    kept, rejected = filter_non_dialogue_vocalizations(normalised)

    rejection_rate = len(rejected) / total_interjections
    assert rejection_rate >= 0.985, (
        f"Expected >= 98.5% false switch rejection rate, got {rejection_rate * 100:.2f}%"
    )
    assert len(kept) == len(dialogue_turns)


def test_speaker_switch_decision_latency_under_50ms_per_cut_point() -> None:
    """SLA Verification (Pillar 3 §03 §1):
    Speaker switch decision latency <= 50 ms per cut point.
    """
    turns = [
        {
            "speakerId": f"SPEAKER_{i % 4:02d}",
            "startSec": float(i * 3.2),
            "endSec": float((i + 1) * 3.2 - 0.15),
        }
        for i in range(40)
    ]
    boxes = _four_speaker_boxes()

    start_t = time.perf_counter()
    edl = generate_director_edl(turns, boxes, clip_duration_sec=40 * 3.2)
    elapsed_ms = (time.perf_counter() - start_t) * 1000.0

    assert len(edl) >= 20
    ms_per_cut = elapsed_ms / len(edl)
    assert ms_per_cut <= 50.0, f"Expected <= 50ms per cut point, measured {ms_per_cut:.2f}ms"


def test_lead_in_and_lead_out_padding_and_manual_override() -> None:
    """Verifies AutoCut 250ms lead-in and 350ms lead-out padding and manual layout override."""
    raw = normalise_diarization_turns(
        [
            {"speakerId": "SPEAKER_00", "startMs": 2000, "endMs": 6000},
            ("SPEAKER_01", 6.2, 10.5),
            (10.6, 15.0, "SPEAKER_02", False),
            DiarizedTurn("SPEAKER_02", 15.2, 16.0, False, False, "continuation"),
        ]
    )
    padded = apply_lead_padding(
        raw,
        lead_in_sec=LEAD_IN_PADDING_SEC,
        lead_out_sec=LEAD_OUT_PADDING_SEC,
        clip_start_sec=0.0,
        clip_end_sec=16.5,
    )
    assert padded[0].start_sec == pytest.approx(1.75)
    assert padded[0].end_sec == pytest.approx(6.35)

    edl = generate_director_edl(
        raw,
        _four_speaker_boxes(),
        clip_duration_sec=16.5,
        overrides=[{"timestampSec": 3.0, "layoutType": LAYOUT_TRI_PANEL}],
    )
    assert edl[0].layout_type == LAYOUT_TRI_PANEL
    assert len(edl[0].pane_assignments) == 3

    # Toggle back to SOLO via apply_layout_override without explicit speaker_boxes
    reverted = apply_layout_override(
        edl,
        timestamp_sec=3.0,
        layout_type=LAYOUT_SOLO,
        active_speaker_id="SPEAKER_00",
    )
    assert reverted[0].layout_type == LAYOUT_SOLO
    assert len(reverted[0].pane_assignments) == 1


def test_clusters_multispeaker_faces_from_face_samples_and_2x2_grid() -> None:
    """Clusters 3 horizontal and 4 2x2 Zoom grid faces into ordered speaker tracks."""
    samples_3 = [
        FaceSample(
            t_ms=i * 250,
            boxes=(
                FaceBox(x=0.72, y=0.28, w=0.12, h=0.20, score=0.95),
                FaceBox(x=0.12, y=0.28, w=0.12, h=0.20, score=0.96),
                FaceBox(x=0.42, y=0.28, w=0.12, h=0.20, score=0.94),
            ),
        )
        for i in range(16)
    ]
    clusters_3 = cluster_multispeaker_faces(samples_3, source_width=1920, source_height=1080)
    assert list(clusters_3.keys()) == ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02"]
    assert clusters_3["SPEAKER_00"].center_x < clusters_3["SPEAKER_01"].center_x < clusters_3["SPEAKER_02"].center_x

    # 2x2 Zoom gallery in raw [t_ms, boxes] format with pixel coordinates
    raw_zoom_samples = [
        [
            i * 250,
            [
                [240, 140, 260, 320],
                [1240, 140, 260, 320],
                [240, 640, 260, 320],
                [1240, 640, 260, 320],
            ],
        ]
        for i in range(12)
    ]
    clusters_4 = cluster_multispeaker_faces(raw_zoom_samples, num_speakers=4, source_width=1920, source_height=1080)
    assert len(clusters_4) == 4

    # Empty turns fallback produces a valid single-cut SOLO EDL
    empty_edl = generate_director_edl([], samples_3, clip_duration_sec=5.0)
    assert len(empty_edl) == 1
    assert empty_edl[0].layout_type == LAYOUT_SOLO


@pytest.mark.asyncio
async def test_process_director_job_processor() -> None:
    """Verifies the async process_director processor outcome shape."""

    class _FakeEnvelope:
        payload: dict[str, Any] = {
            "turns": [
                {"speakerId": "SPEAKER_00", "startSec": 0.0, "endSec": 4.0},
                {"speakerId": "SPEAKER_01", "startSec": 4.0, "endSec": 5.2},
                {"speakerId": "SPEAKER_02", "startSec": 5.2, "endSec": 6.6},
            ],
            "faceBoxes": [
                {"speakerId": "SPEAKER_00", "centerX": 300, "centerY": 400, "size": 240},
                [800, 260, 260, 340],
            ],
            "clipStartSec": 0.0,
            "clipDurationSec": 7.0,
        }

        def log_fields(self) -> dict[str, str]:
            return {"jobId": "test-director-job"}

    class _FakeContext:
        envelope = _FakeEnvelope()
        workdir = Path(".")

        async def progress(self, pct: int, *, message: str = "") -> None:
            assert 0 <= pct <= 100
            assert isinstance(message, str)

    outcome = await process_director(_FakeContext())  # type: ignore[arg-type]
    assert len(outcome.result["cuts"]) == 2
    assert outcome.result["minShotDurationSec"] == MIN_SHOT_DURATION_SEC
    for cut in outcome.result["cuts"]:
        assert cut["endSec"] - cut["startSec"] >= MIN_SHOT_DURATION_SEC
