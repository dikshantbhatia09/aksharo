"""``music`` placement (D05, brief §3-4) — one bed per section, loop-policy
decided from the bed's own measured length against the section's, guard
against protected ranges.

Because `detect_sections` (`analysis.py`) already returns contiguous,
non-overlapping windows covering the whole edited timeline, one item per
section can never overlap another except exactly at a shared boundary —
the brief's "multiple tracks ... overlapping beds only on section
boundaries" falls out of that construction rather than needing a second
overlap guard here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from worker_ai.passes.music.analysis import Section
from worker_ai.passes.music.retrieval import MusicCatalogueAsset, TextEmbedder, rank_music_assets

__all__ = [
    "DEFAULT_FADE_IN_MS",
    "DEFAULT_FADE_OUT_MS",
    "DEFAULT_GAIN_DB",
    "MusicItem",
    "build_music_items",
]

DEFAULT_GAIN_DB = -18.0
#: Entry/exit fade lengths (brief §3): applied at mix time (D04d), carried
#: here only for the completion handler's own bookkeeping — `MusicPayload`
#: (CONTRACTS §2 amendment) has no fade fields of its own, mirroring how
#: `SfxPayload.duck` alone (not a fade pair) rides the wire for sfx cues.
DEFAULT_FADE_IN_MS = 300
DEFAULT_FADE_OUT_MS = 800

LoopPolicy = Literal["none", "loop", "trim"]


@dataclass(frozen=True, slots=True)
class MusicItem:
    """Shaped for `PassItem{kind:"music", payload: MusicPayload}` (CONTRACTS
    §2 amendment 2026-09-03): `assetId`/`packId`/`startMs`/`durationMs`/
    `gainDb`/`loopPolicy`/`bedDuck`/`licenceSnapshot`/`mood`/`bpm` only —
    fade lengths and the section id are this dataclass's own bookkeeping,
    not part of the frozen payload (see `DEFAULT_FADE_IN_MS`'s note)."""

    start_ms: int
    end_ms: int
    asset_id: str
    gain_db: float
    loop_policy: LoopPolicy
    mood: tuple[str, ...]
    bpm: int | None
    confidence: float
    reason: str
    licence_snapshot: dict[str, object]
    section_id: str


def _overlaps_any(start: int, end: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start < r_end and r_start < end for r_start, r_end in ranges)


def _loop_policy_for(section_len_ms: int, asset_duration_ms: int | None) -> LoopPolicy:
    if asset_duration_ms is None:
        return "none"
    if asset_duration_ms < section_len_ms:
        return "loop"
    if asset_duration_ms > section_len_ms:
        return "trim"
    return "none"


def build_music_items(
    sections: list[Section],
    catalogue: list[MusicCatalogueAsset],
    embedder: TextEmbedder,
    *,
    bpm_target: int,
    protected_ranges: list[tuple[int, int]] | None = None,
    gain_db: float = DEFAULT_GAIN_DB,
) -> list[MusicItem]:
    """One `MusicItem` per section that does not overlap a protected range —
    a section is dropped outright (never clamped), the same "dropped, not
    shortened" stance `sfx.py`'s `build_sfx_items` takes."""
    protected_ranges = protected_ranges or []
    if not catalogue:
        return []

    items: list[MusicItem] = []
    for index, section in enumerate(sections):
        if _overlaps_any(section.s, section.e, protected_ranges):
            continue

        query_embedding = tuple(embedder.embed_text(f"{section.mood} background music"))
        ranked = rank_music_assets(
            query_embedding, catalogue, mood=section.mood, bpm_target=bpm_target
        )
        if not ranked:
            continue
        best_asset, score = ranked[0]
        section_len_ms = section.e - section.s
        loop_policy = _loop_policy_for(section_len_ms, best_asset.duration_ms)

        items.append(
            MusicItem(
                start_ms=section.s,
                end_ms=section.e,
                asset_id=best_asset.id,
                gain_db=gain_db,
                loop_policy=loop_policy,
                mood=best_asset.mood,
                bpm=best_asset.bpm,
                confidence=round(max(0.0, min(1.0, score)), 4),
                reason=f"section:{section.mood} (energy={section.energy:.2f}) -> {best_asset.id}",
                licence_snapshot=best_asset.licence_snapshot,
                section_id=f"section-{index}",
            )
        )
    return items
