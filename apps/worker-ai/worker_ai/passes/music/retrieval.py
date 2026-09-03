"""``music`` retrieval (D05, brief §3) — ranks the licence-allowed music
catalogue for one section by CLAP similarity, mood match and BPM proximity.

Same trust boundary as `sfx.py`: the candidate catalogue arrives already
licence-filtered by `assetAllowed` on the API side (`PassesService.
musicCatalogueOf`) — this module never re-derives a licence decision, only
ranks what it is given.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

__all__ = [
    "MusicCatalogueAsset",
    "TextEmbedder",
    "rank_music_assets",
]


class TextEmbedder(Protocol):
    """The one method retrieval needs — `StubEmbedder`/`ClapEmbedder` both
    satisfy it via `embed_text` (same protocol shape as `sfx.py`'s)."""

    def embed_text(self, text: str) -> list[float]: ...


@dataclass(frozen=True, slots=True)
class MusicCatalogueAsset:
    """One licence-allowed `music` asset, as handed down by the API."""

    id: str
    mood: tuple[str, ...]
    bpm: int | None
    embedding: tuple[float, ...]
    licence_snapshot: dict[str, object]
    #: Loop-point metadata (D04a's `AudioAsset.introMs`/`outroMs`), used by
    #: `placement.py` to decide `loopPolicy` — `None` when unmeasured.
    intro_ms: int | None = None
    outro_ms: int | None = None
    duration_ms: int | None = None


def _cosine_distance(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    """`1 - cosine_similarity` — same shape as `sfx.py`'s own helper, kept as
    a small duplicate rather than a cross-module import so `passes.music` has
    no dependency on `passes.sfx`."""
    if not a or not b:
        return 1.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 1.0
    similarity = dot / (norm_a * norm_b)
    return 1.0 - similarity


def _bpm_proximity(asset_bpm: int | None, bpm_target: int) -> float:
    if asset_bpm is None or bpm_target <= 0:
        return 0.0
    return max(0.0, 1.0 - abs(asset_bpm - bpm_target) / bpm_target)


def rank_music_assets(
    query_embedding: tuple[float, ...],
    catalogue: list[MusicCatalogueAsset],
    *,
    mood: str,
    bpm_target: int,
    similarity_weight: float = 0.5,
    mood_weight: float = 0.3,
    bpm_weight: float = 0.2,
) -> list[tuple[MusicCatalogueAsset, float]]:
    """Catalogue ranked by descending combined score (CLAP similarity, exact
    mood-tag match, BPM proximity to `bpm_target`), ties broken by asset id —
    deterministic, same "ties by id" convention `sfx.py`'s `rank_assets` uses.
    """

    def score(asset: MusicCatalogueAsset) -> float:
        similarity = 1.0 - _cosine_distance(query_embedding, asset.embedding)
        mood_match = 1.0 if mood in asset.mood else 0.0
        bpm_proximity = _bpm_proximity(asset.bpm, bpm_target)
        return (
            similarity_weight * similarity + mood_weight * mood_match + bpm_weight * bpm_proximity
        )

    scored = [(asset, score(asset)) for asset in catalogue]
    return sorted(scored, key=lambda pair: (-pair[1], pair[0].id))
