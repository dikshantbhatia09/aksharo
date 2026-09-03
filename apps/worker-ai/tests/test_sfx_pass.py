"""`worker_ai.passes.sfx` — cue detection, retrieval ranking determinism, rate
limiting and placement guards (D04a)."""

from __future__ import annotations

from worker_ai.audio_embed import StubEmbedder
from worker_ai.passes.sfx import (
    CatalogueAsset,
    Cue,
    build_sfx_items,
    detect_cues,
    detect_emphasis_cues,
    detect_energy_cues,
    detect_question_cues,
    detect_silence_gap_cues,
    rank_assets,
)


def _impact_cue(t_ms: int) -> Cue:
    return Cue(
        t_ms=t_ms,
        kind="energy",
        confidence=0.9,
        reason="e",
        tag_hint="impact",
        text_query="impact sound effect",
    )


def _asset(asset_id: str, cue_type: str, embedding: tuple[float, ...]) -> CatalogueAsset:
    return CatalogueAsset(
        id=asset_id,
        cue_type=cue_type,
        tags=(cue_type,),
        embedding=embedding,
        licence_snapshot={"provider": "owned", "licenceRef": "fixtures/audio-pack"},
    )


def test_detect_energy_cues_flags_zscore_peaks() -> None:
    rms = [(i * 100, 0.1) for i in range(10)] + [(1000, 0.9)]
    cues = detect_energy_cues(rms)
    assert len(cues) == 1
    assert cues[0].t_ms == 1000
    assert cues[0].kind == "energy"


def test_detect_emphasis_cues() -> None:
    cues = detect_emphasis_cues([(500, "wow"), (2000, "really")])
    assert [c.t_ms for c in cues] == [500, 2000]
    assert all(c.kind == "emphasis" for c in cues)


def test_detect_question_cues_only_on_question_marks() -> None:
    sentences = [(0, 500, "This is a statement."), (600, 1200, "Is this a question?")]
    cues = detect_question_cues(sentences)
    assert len(cues) == 1
    assert cues[0].t_ms == 600


def test_detect_silence_gap_cues() -> None:
    cues = detect_silence_gap_cues([(0, 1000), (2000, 3000)], silence_gap_ms=600)
    assert len(cues) == 1
    assert cues[0].t_ms == 1000


def test_detect_cues_merges_and_orders_by_time() -> None:
    cues = detect_cues(
        rms_by_ms=[(i * 100, 0.1) for i in range(10)] + [(5000, 0.9)],
        emphasis_words=[(1000, "wow")],
        sentences=[(2000, 2500, "Really?")],
    )
    assert [c.t_ms for c in cues] == sorted(c.t_ms for c in cues)


def test_rank_assets_is_deterministic_and_ties_break_by_id() -> None:
    query = (1.0, 0.0, 0.0)
    catalogue = [
        _asset("b", "impact", (1.0, 0.0, 0.0)),
        _asset("a", "boom", (1.0, 0.0, 0.0)),
    ]
    ranked_once = rank_assets(query, catalogue)
    ranked_twice = rank_assets(query, catalogue)
    assert [a.id for a, _ in ranked_once] == [a.id for a, _ in ranked_twice]
    # Both are equidistant (identical embeddings); id "a" sorts before "b".
    assert [a.id for a, _ in ranked_once] == ["a", "b"]


def test_rank_assets_orders_by_cosine_similarity() -> None:
    query = (1.0, 0.0)
    catalogue = [
        _asset("far", "boom", (0.0, 1.0)),
        _asset("near", "impact", (0.9, 0.1)),
    ]
    ranked = rank_assets(query, catalogue)
    assert ranked[0][0].id == "near"
    assert ranked[1][0].id == "far"


def test_build_sfx_items_retrieves_with_stub_embedder() -> None:
    embedder = StubEmbedder()
    impact_query = tuple(embedder.embed_text("impact sound effect"))
    catalogue = [
        _asset("impact-1", "impact", impact_query),
        _asset("boom-1", "boom", tuple(embedder.embed_text("boom explosion"))),
    ]
    cues = [
        Cue(
            t_ms=0,
            kind="energy",
            confidence=0.8,
            reason="energy-peak",
            tag_hint="impact",
            text_query="impact sound effect",
        )
    ]
    items = build_sfx_items(cues, catalogue, embedder)
    assert len(items) == 1
    assert items[0].asset_id == "impact-1"
    assert items[0].licence_snapshot["provider"] == "owned"


def test_build_sfx_items_rate_limits_to_one_per_min_gap() -> None:
    embedder = StubEmbedder()
    catalogue = [_asset("a", "impact", tuple(embedder.embed_text("impact sound effect")))]
    cues = [_impact_cue(0), _impact_cue(1000), _impact_cue(5000)]
    items = build_sfx_items(cues, catalogue, embedder, min_gap_ms=4000)
    assert [item.start_ms for item in items] == [0, 5000]


def test_build_sfx_items_never_inside_protected_range() -> None:
    embedder = StubEmbedder()
    catalogue = [_asset("a", "impact", tuple(embedder.embed_text("impact sound effect")))]
    cues = [_impact_cue(1000)]
    items = build_sfx_items(cues, catalogue, embedder, protected_ranges=[(500, 2000)])
    assert items == []


def test_build_sfx_items_never_over_accepted_cuts() -> None:
    embedder = StubEmbedder()
    catalogue = [_asset("a", "impact", tuple(embedder.embed_text("impact sound effect")))]
    cues = [_impact_cue(1000)]
    items = build_sfx_items(cues, catalogue, embedder, accepted_cut_ranges=[(900, 1500)])
    assert items == []


def test_build_sfx_items_is_deterministic() -> None:
    embedder = StubEmbedder()
    catalogue = [
        _asset("a", "impact", tuple(embedder.embed_text("impact sound effect"))),
        _asset("b", "boom", tuple(embedder.embed_text("boom explosion"))),
    ]
    cues = [_impact_cue(0)]
    once = build_sfx_items(cues, catalogue, embedder)
    twice = build_sfx_items(cues, catalogue, embedder)
    assert once == twice


def test_build_sfx_items_empty_catalogue_yields_no_items() -> None:
    embedder = StubEmbedder()
    cues = [_impact_cue(0)]
    assert build_sfx_items(cues, [], embedder) == []
