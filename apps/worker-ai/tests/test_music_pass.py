"""`worker_ai.passes.music` — section detection, mood classification, BPM
targeting, retrieval ranking determinism and placement guards (D05)."""

from __future__ import annotations

import itertools

from worker_ai.audio_embed import StubEmbedder
from worker_ai.passes.music import (
    MusicCatalogueAsset,
    bpm_target_from_cut_cadence,
    build_music_items,
    classify_mood,
    detect_sections,
    rank_music_assets,
)


def _asset(
    asset_id: str,
    mood: tuple[str, ...],
    bpm: int,
    embedding: tuple[float, ...],
    *,
    duration_ms: int | None = None,
) -> MusicCatalogueAsset:
    return MusicCatalogueAsset(
        id=asset_id,
        mood=mood,
        bpm=bpm,
        embedding=embedding,
        licence_snapshot={"provider": "owned", "licenceRef": "fixtures/audio-pack"},
        duration_ms=duration_ms,
    )


def test_classify_mood_rule_table() -> None:
    assert classify_mood(sentiment=0.5, energy=0.8) == "upbeat"
    assert classify_mood(sentiment=-0.5, energy=0.8) == "tense"
    assert classify_mood(sentiment=0.0, energy=0.8) == "dramatic"
    assert classify_mood(sentiment=0.5, energy=0.1) == "playful"
    assert classify_mood(sentiment=0.0, energy=0.1) == "calm"
    assert classify_mood(sentiment=0.0, energy=0.45) == "neutral"


def test_detect_sections_merges_contiguous_same_mood_windows() -> None:
    # Ten seconds of pure talking-head speech (full speech coverage, no
    # cuts) should classify as one calm/neutral-ish section, not ten.
    speech = [(0, 10_000)]
    sections = detect_sections(
        duration_ms=10_000, speech_ranges=speech, cut_times_ms=[], window_ms=1_000
    )
    assert len(sections) == 1
    assert sections[0].s == 0
    assert sections[0].e == 10_000


def test_detect_sections_splits_on_a_montage_stretch() -> None:
    # 0-5s: talking (full speech coverage). 5-10s: no speech, heavy cuts —
    # a montage/B-roll stretch, energy pushes it to a different mood bucket.
    speech = [(0, 5_000)]
    cuts = [5_200, 5_600, 6_000, 6_400, 6_800, 7_200, 7_600, 8_000, 8_400, 8_800, 9_200, 9_600]
    sections = detect_sections(
        duration_ms=10_000, speech_ranges=speech, cut_times_ms=cuts, window_ms=1_000
    )
    assert len(sections) >= 2
    assert sections[0].s == 0
    assert sections[-1].e == 10_000
    # Every ms of the timeline is covered by exactly the merged sections, in order.
    for a, b in itertools.pairwise(sections):
        assert a.e == b.s


def test_detect_sections_empty_duration_is_empty() -> None:
    assert detect_sections(duration_ms=0) == []


def test_bpm_target_from_cut_cadence_fast_vs_slow() -> None:
    # A cut roughly every 500ms is a tight cadence -> fast band.
    fast_cuts = list(range(0, 10_000, 500))
    assert bpm_target_from_cut_cadence(fast_cuts) == 128
    # A cut every 5s is sparse -> slow band.
    slow_cuts = list(range(0, 30_000, 5_000))
    assert bpm_target_from_cut_cadence(slow_cuts) == 92
    # Fewer than two cuts: nothing to measure a gap from -> slow band.
    assert bpm_target_from_cut_cadence([]) == 92
    assert bpm_target_from_cut_cadence([1000]) == 92


def test_rank_music_assets_is_deterministic_and_ties_break_by_id() -> None:
    embedder = StubEmbedder()
    query = tuple(embedder.embed_text("upbeat background music"))
    catalogue = [
        _asset("b", ("upbeat",), 128, tuple(embedder.embed_text("upbeat background music"))),
        _asset("a", ("upbeat",), 128, tuple(embedder.embed_text("upbeat background music"))),
        _asset("c", ("calm",), 92, tuple(embedder.embed_text("calm background music"))),
    ]
    ranked = rank_music_assets(query, catalogue, mood="upbeat", bpm_target=128)
    # "a" and "b" tie on every signal (identical embedding/mood/bpm) -> id order.
    assert [a.id for a, _ in ranked[:2]] == ["a", "b"]
    assert ranked[0][1] >= ranked[2][1]

    # Running it again produces byte-identical ranking (no hidden randomness).
    ranked_again = rank_music_assets(query, catalogue, mood="upbeat", bpm_target=128)
    assert [a.id for a, _ in ranked] == [a.id for a, _ in ranked_again]


def test_rank_music_assets_prefers_bpm_proximity_among_equal_mood_matches() -> None:
    embedder = StubEmbedder()
    query = tuple(embedder.embed_text("upbeat background music"))
    close = _asset("close", ("upbeat",), 128, query)
    far = _asset("far", ("upbeat",), 70, query)
    ranked = rank_music_assets(query, [far, close], mood="upbeat", bpm_target=128)
    assert ranked[0][0].id == "close"


def test_build_music_items_loops_a_shorter_bed_and_trims_a_longer_one() -> None:
    embedder = StubEmbedder()
    sections = detect_sections(duration_ms=20_000, speech_ranges=[(0, 20_000)], window_ms=20_000)
    assert len(sections) == 1
    section_len = sections[0].e - sections[0].s

    short_bed = _asset(
        "short",
        ("calm",),
        92,
        tuple(embedder.embed_text("calm background music")),
        duration_ms=section_len - 5_000,
    )
    items = build_music_items(sections, [short_bed], embedder, bpm_target=92)
    assert len(items) == 1
    assert items[0].loop_policy == "loop"

    long_bed = _asset(
        "long",
        ("calm",),
        92,
        tuple(embedder.embed_text("calm background music")),
        duration_ms=section_len + 5_000,
    )
    items = build_music_items(sections, [long_bed], embedder, bpm_target=92)
    assert items[0].loop_policy == "trim"


def test_build_music_items_drops_sections_overlapping_a_protected_range() -> None:
    embedder = StubEmbedder()
    sections = detect_sections(duration_ms=10_000, speech_ranges=[(0, 10_000)], window_ms=10_000)
    catalogue = [_asset("a", ("calm",), 92, tuple(embedder.embed_text("calm background music")))]

    items = build_music_items(
        sections, catalogue, embedder, bpm_target=92, protected_ranges=[(0, 10_000)]
    )
    assert items == []


def test_build_music_items_needs_a_catalogue() -> None:
    embedder = StubEmbedder()
    sections = detect_sections(duration_ms=10_000, speech_ranges=[(0, 10_000)], window_ms=10_000)
    assert build_music_items(sections, [], embedder, bpm_target=92) == []
