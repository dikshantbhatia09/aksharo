"""``sfx`` — the D04a pass: cue detection + CLAP retrieval over the licence-
allowed catalogue, producing `PassItem{kind:"sfx"}` candidates (CONTRACTS §2).

Pure and deterministic, in `autocut.py`'s and `zoom.py`'s own style: no
network, no database, no queue. The candidate catalogue (already licence-
filtered by `assetAllowed` on the API side — this module never re-derives a
licence decision) arrives as a plain list of :class:`CatalogueAsset`, each
carrying its own CLAP embedding; ranking is pgvector-equivalent cosine
similarity computed in Python so a worker unit test never needs Postgres.

Pipeline:

1. **Cue detection** — four independent signals over the transcript/audio,
   each producing a :class:`Cue` with a taxonomy tag guess and a text query:
   energy peaks (RMS z-score, reusing `zoom.py`'s threshold shape), emphasis
   words (transcript-flagged), question intonation (a text proxy: the
   segment's sentence ends in "?"), and silence-gap boundaries (a pause
   `>= silence_gap_ms` inside speech, cueing a transition `whoosh`).
2. **Retrieval** — each cue's text query is embedded (the caller's
   `Embedder`) and the allowed catalogue is ranked by cosine similarity
   (ties broken by asset id, matching the SQL `ORDER BY distance ASC, id ASC`
   `AudioAssetsRepository.findRankedByEmbedding` uses, so ranking is
   identical whichever side computes it).
3. **Rate limiting and placement guards** — at most one cue per
   `min_gap_ms` (4 s, the brief's "≤ 1 cue per 4 s"), never inside a
   protected range, never overlapping an accepted `cut` range.
"""

from __future__ import annotations

import itertools
import math
import statistics
from dataclasses import dataclass
from typing import Literal, Protocol

__all__ = [
    "CUE_TAXONOMY",
    "MIN_CUE_GAP_MS",
    "CatalogueAsset",
    "Cue",
    "CueKind",
    "SfxItem",
    "TextEmbedder",
    "build_sfx_items",
    "detect_cues",
    "detect_emphasis_cues",
    "detect_energy_cues",
    "detect_question_cues",
    "detect_silence_gap_cues",
    "rank_assets",
]

#: Functional cue tags only (09-ai-pipeline §6, D44) — never a meme name.
CUE_TAXONOMY: tuple[str, ...] = (
    "impact",
    "whoosh",
    "pop",
    "ding",
    "riser",
    "boom",
    "comedic",
    "notification",
)

MIN_CUE_GAP_MS = 4_000

CueKind = Literal["energy", "emphasis", "question", "silence_gap"]


class TextEmbedder(Protocol):
    """The one method `build_sfx_items` needs — `StubEmbedder`/`ClapEmbedder`
    both satisfy it via their `embed_text` method."""

    def embed_text(self, text: str) -> list[float]: ...


@dataclass(frozen=True, slots=True)
class Cue:
    t_ms: int
    kind: CueKind
    confidence: float
    reason: str
    #: The tag this cue's signal suggests, before retrieval narrows it further.
    tag_hint: str
    text_query: str


@dataclass(frozen=True, slots=True)
class CatalogueAsset:
    """One licence-allowed asset, as handed down by the API (already filtered
    by `assetAllowed` — this module trusts the list it is given)."""

    id: str
    cue_type: str | None
    tags: tuple[str, ...]
    embedding: tuple[float, ...]
    licence_snapshot: dict[str, object]


@dataclass(frozen=True, slots=True)
class SfxItem:
    """Shaped for `PassItem{kind:"sfx", payload:{...}}` (CONTRACTS §2)."""

    start_ms: int
    end_ms: int
    asset_id: str
    tag: str
    gain_db: float
    confidence: float
    reason: str
    licence_snapshot: dict[str, object]


def detect_energy_cues(
    rms_by_ms: list[tuple[int, float]], *, z_threshold: float = 2.0
) -> list[Cue]:
    """RMS energy peaks (laughter/impact proxy) — same z-score shape as
    `zoom.py`'s `detect_energy_cues`, tagged toward `impact`/`boom`."""
    if len(rms_by_ms) < 3:
        return []
    values = [v for _, v in rms_by_ms]
    mean = statistics.fmean(values)
    stdev = statistics.pstdev(values)
    if stdev <= 0:
        return []
    cues: list[Cue] = []
    for t_ms, value in rms_by_ms:
        z = (value - mean) / stdev
        if z > z_threshold:
            tag = "boom" if z > z_threshold * 1.5 else "impact"
            cues.append(
                Cue(
                    t_ms=t_ms,
                    kind="energy",
                    confidence=min(0.95, 0.5 + z / 10),
                    reason="energy-peak",
                    tag_hint=tag,
                    text_query=f"{tag} sound effect",
                )
            )
    return cues


def detect_emphasis_cues(
    emphasis_words: list[tuple[int, str]],  # (t_ms, word text)
) -> list[Cue]:
    """A transcript word already flagged `emphasis` (A11) — a `ding`/`pop`
    accent cue."""
    return [
        Cue(
            t_ms=t_ms,
            kind="emphasis",
            confidence=0.7,
            reason="emphasis-word",
            tag_hint="ding",
            text_query=f"emphasis accent for '{word}'",
        )
        for t_ms, word in emphasis_words
    ]


def detect_question_cues(
    sentences: list[tuple[int, int, str]],  # (start_ms, end_ms, text)
) -> list[Cue]:
    """A sentence ending in "?" — question intonation proxy — cued toward
    `notification` (the "ping, a question was just asked" cue)."""
    cues: list[Cue] = []
    for start_ms, _end_ms, text in sentences:
        if text.strip().endswith("?"):
            cues.append(
                Cue(
                    t_ms=start_ms,
                    kind="question",
                    confidence=0.55,
                    reason="question-intonation",
                    tag_hint="notification",
                    text_query="notification question ping",
                )
            )
    return cues


def detect_silence_gap_cues(
    speech_ranges: list[tuple[int, int]], *, silence_gap_ms: int = 600
) -> list[Cue]:
    """A gap between two speech ranges >= `silence_gap_ms` — a transition
    beat, cued toward `whoosh`/`riser`."""
    ordered = sorted(speech_ranges, key=lambda r: r[0])
    cues: list[Cue] = []
    for previous, current in itertools.pairwise(ordered):
        gap = current[0] - previous[1]
        if gap >= silence_gap_ms:
            cues.append(
                Cue(
                    t_ms=previous[1],
                    kind="silence_gap",
                    confidence=0.5,
                    reason="silence-gap",
                    tag_hint="whoosh",
                    text_query="whoosh transition",
                )
            )
    return cues


def detect_cues(
    *,
    rms_by_ms: list[tuple[int, float]] | None = None,
    emphasis_words: list[tuple[int, str]] | None = None,
    sentences: list[tuple[int, int, str]] | None = None,
    speech_ranges: list[tuple[int, int]] | None = None,
) -> list[Cue]:
    """Every signal, merged and time-ordered (ties by descending confidence)."""
    cues: list[Cue] = []
    cues += detect_energy_cues(rms_by_ms or [])
    cues += detect_emphasis_cues(emphasis_words or [])
    cues += detect_question_cues(sentences or [])
    cues += detect_silence_gap_cues(speech_ranges or [])
    return sorted(cues, key=lambda c: (c.t_ms, -c.confidence))


def _cosine_distance(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    """`1 - cosine_similarity`, matching pgvector's `<=>` operator so ranking
    is identical whichever side computes it (module docstring)."""
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 1.0
    similarity = dot / (norm_a * norm_b)
    return 1.0 - similarity


def rank_assets(
    query_embedding: tuple[float, ...], catalogue: list[CatalogueAsset]
) -> list[tuple[CatalogueAsset, float]]:
    """Catalogue ranked by ascending cosine distance to `query_embedding`, ties
    broken by asset id — deterministic, matching the SQL
    `ORDER BY distance ASC, id ASC` the repository uses."""
    scored = [(asset, _cosine_distance(query_embedding, asset.embedding)) for asset in catalogue]
    return sorted(scored, key=lambda pair: (pair[1], pair[0].id))


def _overlaps_any(start: int, end: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start < r_end and r_start < end for r_start, r_end in ranges)


def build_sfx_items(
    cues: list[Cue],
    catalogue: list[CatalogueAsset],
    embedder: TextEmbedder,
    *,
    protected_ranges: list[tuple[int, int]] | None = None,
    accepted_cut_ranges: list[tuple[int, int]] | None = None,
    min_gap_ms: int = MIN_CUE_GAP_MS,
    cue_duration_ms: int = 600,
    gain_db: float = -6.0,
) -> list[SfxItem]:
    """Cues → retrieval → rate-limited, guard-respecting `SfxItem`s.

    Cues are processed earliest-first, highest-confidence-first on a tie
    (`detect_cues` already orders them that way); a cue whose window falls
    inside a protected range or overlaps an accepted cut is dropped outright,
    never clamped, matching `zoom.py`'s "dropped, not shortened" stance. The
    ≤ 1-cue-per-4 s rate limit keeps a burst of energy cues from spamming the
    timeline.
    """
    protected_ranges = protected_ranges or []
    accepted_cut_ranges = accepted_cut_ranges or []

    if not catalogue:
        return []

    items: list[SfxItem] = []
    last_t_ms: int | None = None

    for cue in cues:
        start_ms = cue.t_ms
        end_ms = start_ms + cue_duration_ms

        if last_t_ms is not None and start_ms - last_t_ms < min_gap_ms:
            continue
        if _overlaps_any(start_ms, end_ms, protected_ranges):
            continue
        if _overlaps_any(start_ms, end_ms, accepted_cut_ranges):
            continue

        query_embedding = tuple(embedder.embed_text(cue.text_query))
        ranked = rank_assets(query_embedding, catalogue)
        if not ranked:
            continue
        best_asset, distance = ranked[0]

        items.append(
            SfxItem(
                start_ms=start_ms,
                end_ms=end_ms,
                asset_id=best_asset.id,
                tag=best_asset.cue_type or cue.tag_hint,
                gain_db=gain_db,
                confidence=round(cue.confidence * (1.0 - min(1.0, distance)), 4),
                reason=f"{cue.reason} → {best_asset.cue_type or cue.tag_hint}",
                licence_snapshot=best_asset.licence_snapshot,
            )
        )
        last_t_ms = start_ms

    return items
