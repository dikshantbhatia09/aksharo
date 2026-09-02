"""VAD backends, and the D14 chunk planner including its property."""

from __future__ import annotations

from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

from worker_ai.audio import Pcm, read_pcm
from worker_ai.chunking import (
    BOUNDARY_SEARCH_MS,
    NOMINAL_CHUNK_MS,
    boundary_never_splits_speech,
    plan_chunks,
)
from worker_ai.vad import (
    FRAME_SAMPLES,
    EnergyVad,
    SileroOnnxVad,
    SpeechRegion,
    detect_regions,
    load_vad,
    regions_from_probabilities,
    silence_gaps,
    total_speech_ms,
)

from .conftest import clip

# ---------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------


def test_energy_vad_finds_three_regions_across_two_silences(two_silence_clip: Pcm) -> None:
    """The acceptance fixture: speech · silence · speech · silence · speech."""
    regions = detect_regions(EnergyVad(), two_silence_clip)

    assert len(regions) == 3
    # 1000 / 600 / 1200 / 800 / 900 ms, with 30 ms padding either side.
    expected = [(0, 1_030), (1_570, 2_830), (3_570, 4_500)]
    for region, (start, end) in zip(regions, expected, strict=True):
        assert abs(region.start_ms - start) <= 64, region
        assert abs(region.end_ms - end) <= 64, region
    assert all(region.duration_ms >= 250 for region in regions)


def test_silence_gaps_are_the_complement_of_the_regions(two_silence_clip: Pcm) -> None:
    regions = detect_regions(EnergyVad(), two_silence_clip)
    gaps = silence_gaps(regions, two_silence_clip.duration_ms)

    assert len(gaps) == 2
    assert gaps[0][0] == regions[0].end_ms
    assert gaps[-1][1] == regions[-1].end_ms or gaps[-1][1] <= two_silence_clip.duration_ms
    assert total_speech_ms(regions) + sum(end - start for start, end in gaps) == pytest.approx(
        two_silence_clip.duration_ms, abs=64
    )


def test_a_silent_clip_has_no_speech_regions() -> None:
    quiet = clip(("silence", 3_000))
    assert detect_regions(EnergyVad(), quiet) == ()


def test_an_empty_clip_produces_nothing() -> None:
    empty = Pcm(samples=np.zeros(0, dtype=np.float32), sample_rate=16_000)
    assert EnergyVad().probabilities(empty).shape == (0,)
    assert detect_regions(EnergyVad(), empty) == ()


def test_short_bursts_below_the_minimum_are_discarded() -> None:
    probabilities = np.array([0.0, 0.9, 0.0, 0.0, 0.0], dtype=np.float32)
    assert regions_from_probabilities(probabilities) == ()


def test_hysteresis_keeps_a_dip_inside_one_region() -> None:
    """A frame between the release and the open threshold does not end speech."""
    probabilities = np.array([0.9] * 10 + [0.4] + [0.9] * 10, dtype=np.float32)
    regions = regions_from_probabilities(probabilities)
    assert len(regions) == 1


def test_regions_are_padded_and_clamped_to_the_clip() -> None:
    probabilities = np.array([0.9] * 20, dtype=np.float32)
    regions = regions_from_probabilities(probabilities, duration_ms=500)
    assert regions[0].start_ms == 0
    assert regions[0].end_ms == 500


def test_a_region_cannot_end_before_it_starts() -> None:
    with pytest.raises(ValueError, match="cannot end before"):
        SpeechRegion(start_ms=500, end_ms=400)


# ---------------------------------------------------------------------------
# Silero, through a stubbed ONNX session
# ---------------------------------------------------------------------------


class _FakeSession:
    """Answers with the v5 output shape and remembers what it was fed."""

    def __init__(self, scores: list[float]) -> None:
        self.scores = scores
        self.calls: list[dict[str, Any]] = []

    def run(self, output_names: list[str] | None, input_feed: dict[str, Any]) -> list[Any]:
        self.calls.append(input_feed)
        index = min(len(self.calls) - 1, len(self.scores) - 1)
        state = np.full((2, 1, 128), float(len(self.calls)), dtype=np.float32)
        return [np.array([[self.scores[index]]], dtype=np.float32), state]


def test_silero_feeds_512_sample_frames_and_carries_its_state() -> None:
    pcm = clip(("speech", 200))
    session = _FakeSession([0.9])
    scores = SileroOnnxVad(session).probabilities(pcm)

    expected_frames = -(-len(pcm.samples) // FRAME_SAMPLES)
    assert scores.shape == (expected_frames,)
    assert all(call["input"].shape == (1, FRAME_SAMPLES) for call in session.calls)
    assert session.calls[0]["sr"] == 16_000
    # The state fed to frame n is the state returned by frame n-1.
    assert float(session.calls[0]["state"][0][0][0]) == 0.0
    assert float(session.calls[1]["state"][0][0][0]) == 1.0


def test_silero_scores_become_regions_like_any_other_backend() -> None:
    pcm = clip(("speech", 1_000))
    regions = detect_regions(SileroOnnxVad(_FakeSession([0.95])), pcm)
    assert len(regions) == 1
    assert regions[0].duration_ms >= 900


def test_silero_on_an_empty_clip_never_runs_the_graph() -> None:
    session = _FakeSession([0.9])
    empty = Pcm(samples=np.zeros(0, dtype=np.float32), sample_rate=16_000)
    assert SileroOnnxVad(session).probabilities(empty).shape == (0,)
    assert session.calls == []


def test_load_vad_falls_back_to_energy_without_a_model(tmp_path: Path) -> None:
    assert load_vad("").name == "energy"
    assert load_vad(str(tmp_path / "missing.onnx")).name == "energy"


def test_load_vad_falls_back_when_the_model_file_is_not_a_model(tmp_path: Path) -> None:
    """A corrupt model must degrade the pod, not crash it."""
    broken = tmp_path / "silero_vad.onnx"
    broken.write_bytes(b"not an onnx graph")
    assert load_vad(str(broken)).name == "energy"


# ---------------------------------------------------------------------------
# The chunk planner (D14)
# ---------------------------------------------------------------------------


def test_a_short_file_is_one_chunk() -> None:
    plan = plan_chunks(45_000, (SpeechRegion(start_ms=0, end_ms=45_000),))
    assert [entry.to_wire() for entry in plan] == [{"chunkIdx": 0, "startMs": 0, "endMs": 45_000}]


def test_an_empty_file_has_no_plan() -> None:
    assert plan_chunks(0, ()) == ()


def test_the_boundary_moves_to_the_longest_silence_in_the_window() -> None:
    """Two candidate silences; the planner takes the longer one, not the nearer."""
    duration = 25 * 60_000
    regions = (
        SpeechRegion(start_ms=0, end_ms=NOMINAL_CHUNK_MS - 20_000),
        # 2 s of silence, 20 s early.
        SpeechRegion(start_ms=NOMINAL_CHUNK_MS - 18_000, end_ms=NOMINAL_CHUNK_MS + 10_000),
        # 8 s of silence, 10 s late — longer, so this is the cut.
        SpeechRegion(start_ms=NOMINAL_CHUNK_MS + 18_000, end_ms=duration),
    )
    plan = plan_chunks(duration, regions)

    assert plan[0].end_ms == (NOMINAL_CHUNK_MS + 10_000 + NOMINAL_CHUNK_MS + 18_000) // 2
    assert plan[1].start_ms == plan[0].end_ms


def test_a_tie_between_silences_goes_to_the_nearer_one() -> None:
    duration = 25 * 60_000
    regions = (
        SpeechRegion(start_ms=0, end_ms=NOMINAL_CHUNK_MS - 25_000),
        SpeechRegion(start_ms=NOMINAL_CHUNK_MS - 20_000, end_ms=NOMINAL_CHUNK_MS - 5_000),
        SpeechRegion(start_ms=NOMINAL_CHUNK_MS + 0, end_ms=duration),
    )
    plan = plan_chunks(duration, regions)
    # Both gaps are 5 s; the later one is centred 2.5 s from nominal, the earlier
    # 22.5 s away, so the later wins.
    assert plan[0].end_ms == NOMINAL_CHUNK_MS - 2_500


def test_an_adjacent_region_edge_is_used_when_there_is_no_silence() -> None:
    """Two regions touching exactly: no gap to find, but a safe edge to cut on."""
    duration = NOMINAL_CHUNK_MS + 9 * 60_000
    seam = NOMINAL_CHUNK_MS - 12_000
    regions = (
        SpeechRegion(start_ms=0, end_ms=seam),
        SpeechRegion(start_ms=seam, end_ms=duration),
    )
    plan = plan_chunks(duration, regions)

    assert plan[0].end_ms == seam
    assert boundary_never_splits_speech(plan, regions)


def test_one_unbroken_utterance_cuts_at_the_nominal_boundary_and_says_so() -> None:
    """No silence anywhere: no boundary can avoid speech, so the caller is told."""
    duration = 25 * 60_000
    regions = (SpeechRegion(start_ms=0, end_ms=duration),)
    plan = plan_chunks(duration, regions)

    assert [entry.end_ms for entry in plan[:-1]] == [NOMINAL_CHUNK_MS, 2 * NOMINAL_CHUNK_MS]
    assert plan[-1].end_ms == duration
    assert boundary_never_splits_speech(plan, regions) is False


def test_chunks_are_contiguous_and_cover_the_file() -> None:
    duration = 47 * 60_000
    regions = tuple(
        SpeechRegion(start_ms=index * 90_000, end_ms=index * 90_000 + 60_000)
        for index in range(duration // 90_000)
    )
    plan = plan_chunks(duration, regions)

    assert plan[0].start_ms == 0
    assert plan[-1].end_ms == duration
    assert [entry.chunk_idx for entry in plan] == list(range(len(plan)))
    for previous, following in pairwise(plan):
        assert previous.end_ms == following.start_ms
        assert previous.duration_ms > 0


def test_a_short_tail_is_absorbed_rather_than_left_as_a_stub() -> None:
    duration = NOMINAL_CHUNK_MS + 60_000
    regions = (SpeechRegion(start_ms=0, end_ms=1_000),)
    plan = plan_chunks(duration, regions)
    assert len(plan) == 1
    assert plan[0].end_ms == duration


@hypothesis_settings(max_examples=120, deadline=None)
@given(
    seeds=st.lists(
        st.tuples(
            st.integers(min_value=1_000, max_value=120_000),
            st.integers(min_value=200, max_value=90_000),
        ),
        min_size=1,
        max_size=40,
    )
)
def test_property_a_chunk_boundary_never_falls_inside_speech(
    seeds: list[tuple[int, int]],
) -> None:
    """D14's invariant, over arbitrary speech/silence layouts.

    A boundary may fall inside speech **only** when the region it lands in covers
    the whole ±30 s search window — the "one unbroken utterance" case of the
    module docstring, where no boundary can avoid a word. Anything narrower would
    have offered a silence or a region edge, and the planner would have taken it.
    """
    regions: list[SpeechRegion] = []
    cursor = 0
    for speech_ms, gap_ms in seeds:
        regions.append(SpeechRegion(start_ms=cursor, end_ms=cursor + speech_ms))
        cursor += speech_ms + gap_ms
    duration = cursor + 1_000

    plan = plan_chunks(duration, tuple(regions))

    for entry in plan[1:]:
        edge = entry.start_ms
        containing = [region for region in regions if region.contains(edge)]
        if not containing:
            continue
        region = containing[0]
        assert region.start_ms <= max(0, edge - BOUNDARY_SEARCH_MS)
        assert region.end_ms >= min(duration, edge + BOUNDARY_SEARCH_MS)

    assert plan[0].start_ms == 0
    assert plan[-1].end_ms == duration
    for previous, following in pairwise(plan):
        assert previous.end_ms == following.start_ms


@hypothesis_settings(max_examples=60, deadline=None)
@given(
    duration=st.integers(min_value=1, max_value=6 * 60 * 60_000),
    search=st.integers(min_value=1_000, max_value=BOUNDARY_SEARCH_MS),
)
def test_property_the_plan_always_covers_the_file(duration: int, search: int) -> None:
    plan = plan_chunks(duration, (), search_ms=search)
    assert plan[0].start_ms == 0
    assert plan[-1].end_ms == duration
    assert sum(entry.duration_ms for entry in plan) == duration


def test_read_pcm_round_trips_a_written_wav(wav_file: Path, two_silence_clip: Pcm) -> None:
    decoded = read_pcm(wav_file)
    assert decoded.sample_rate == two_silence_clip.sample_rate
    assert decoded.duration_ms == two_silence_clip.duration_ms
    assert np.allclose(decoded.samples, two_silence_clip.samples, atol=1e-4)
