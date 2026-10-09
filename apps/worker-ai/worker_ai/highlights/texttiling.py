"""Semantic discourse segmentation via Hearst's TextTiling algorithm (Pillar 2 §03).

Identifies natural thematic episode boundaries and topic transitions across transcripts:
1. Tokenizes transcript units into content word bags with stop-word filtering.
2. Computes lexical cohesion (cosine similarity) between adjacent pseudosentence blocks.
3. Calculates moving depth scores D(i) = (s_{i-1} - s_i) + (s_{i+1} - s_i) and peak valley depths.
4. Locates peak valleys as natural paragraph / narrative episode cuts.
5. Provides discourse coherence scoring for candidate highlight windows.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

import numpy as np

from worker_ai.highlights.windows import Unit, Word

__all__ = [
    "TextTileBoundary",
    "TextTilingConfig",
    "TextTilingResult",
    "compute_texttiling",
    "discourse_coherence_bonus",
]

#: Standard stop words (English and Indic/Hinglish) that do not indicate topic shifts.
STOP_WORDS: Final[frozenset[str]] = frozenset({
    # English
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any",
    "are", "as", "at", "be", "because", "been", "before", "being", "below", "between",
    "both", "but", "by", "could", "did", "do", "does", "doing", "down", "during", "each",
    "few", "for", "from", "further", "had", "has", "have", "having", "he", "her", "here",
    "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it",
    "its", "itself", "just", "me", "more", "most", "my", "myself", "no", "nor", "not",
    "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves",
    "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
    "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they",
    "this", "those", "through", "to", "too", "under", "until", "up", "very", "was",
    "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
    "will", "with", "would", "you", "your", "yours", "yourself", "yourselves",
    # Hinglish / Indic
    "hai", "hain", "ho", "tha", "the", "thi", "ka", "ki", "ke", "ko", "se", "me", "mein",
    "par", "pe", "bhi", "toh", "to", "ye", "yeh", "wo", "woh", "kya", "kyun", "kaise",
    "aur", "ya", "lekin", "magar", "parantu",
})

WORD_REGEX: Final = re.compile(r"[^\w\s]", re.UNICODE)


@dataclass(frozen=True, slots=True)
class TextTilingConfig:
    """Parameters for TextTiling segmentation."""

    #: Number of consecutive units per comparison block.
    block_units: int = 2
    #: Smoothing radius for adjacent similarity scores.
    smoothing_radius: int = 0
    #: Minimum depth threshold to qualify as a topic boundary.
    min_depth_threshold: float = 0.20


@dataclass(frozen=True, slots=True)
class TextTileBoundary:
    """A candidate discourse boundary between unit `unit_index` and `unit_index + 1`."""

    unit_index: int
    depth_score: float
    similarity: float
    is_peak: bool


@dataclass(frozen=True, slots=True)
class TextTilingResult:
    """Full segmentation result across transcript units."""

    similarities: tuple[float, ...]
    depth_scores: tuple[float, ...]
    peak_valleys: tuple[int, ...]
    boundaries: tuple[TextTileBoundary, ...]

    def is_thematic_boundary(self, unit_index: int) -> bool:
        """True if the boundary immediately following `unit_index` is a peak topic valley."""
        return unit_index in self.peak_valleys


def _extract_content_tokens(text: str) -> Counter[str]:
    """Tokenizes text, strips punctuation, normalizes case, and drops stop words."""
    cleaned = WORD_REGEX.sub(" ", text.lower())
    tokens = [t for t in cleaned.split() if len(t) > 2 and t not in STOP_WORDS]
    return Counter(tokens)


def _cosine_similarity(vec_a: Counter[str], vec_b: Counter[str]) -> float:
    """Cosine similarity between two term-frequency bags."""
    if not vec_a or not vec_b:
        return 0.0
    # Dot product over intersection
    common = set(vec_a.keys()) & set(vec_b.keys())
    if not common:
        return 0.0
    dot = sum(vec_a[t] * vec_b[t] for t in common)
    norm_a = math.sqrt(sum(v * v for v in vec_a.values()))
    norm_b = math.sqrt(sum(v * v for v in vec_b.values()))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def compute_texttiling(
    units: Sequence[Unit],
    words: Sequence[Word],
    config: TextTilingConfig = TextTilingConfig(),
) -> TextTilingResult:
    """Calculates Hearst TextTiling lexical cohesion depth scores across units.

    For N units, computes N-1 boundary similarities s_0..s_{N-2} and their
    corresponding valley depth scores D(i) = (s_{i-1} - s_i) + (s_{i+1} - s_i).
    """
    if len(units) <= 1:
        return TextTilingResult(
            similarities=(),
            depth_scores=(),
            peak_valleys=(),
            boundaries=(),
        )

    # 1. Extract content bags per unit
    unit_bags: list[Counter[str]] = []
    for u in units:
        unit_text = " ".join(words[k].text for k in range(u.first, u.last + 1))
        unit_bags.append(_extract_content_tokens(unit_text))

    n_boundaries = len(units) - 1
    raw_sims: list[float] = []

    # 2. Block-to-block cosine similarity
    radius = max(1, config.block_units)
    for i in range(n_boundaries):
        # Left block: units [max(0, i - radius + 1) .. i]
        left_bag: Counter[str] = Counter()
        for j in range(max(0, i - radius + 1), i + 1):
            left_bag.update(unit_bags[j])

        # Right block: units [i + 1 .. min(len(units) - 1, i + radius)]
        right_bag: Counter[str] = Counter()
        for j in range(i + 1, min(len(units), i + radius + 1)):
            right_bag.update(unit_bags[j])

        sim = _cosine_similarity(left_bag, right_bag)
        raw_sims.append(sim)

    # 3. Optional moving average smoothing
    smoothed_sims: list[float] = []
    if config.smoothing_radius <= 0 or n_boundaries < 5:
        smoothed_sims = list(raw_sims)
    else:
        pad = config.smoothing_radius
        padded = [raw_sims[0]] * pad + raw_sims + [raw_sims[-1]] * pad
        for i in range(n_boundaries):
            smoothed_sims.append(float(np.mean(padded[i : i + 2 * pad + 1])))

    # 4. Depth score calculation: D(i) = (peak_left - s_i) + (peak_right - s_i)
    depth_scores: list[float] = []
    for i in range(n_boundaries):
        cur = smoothed_sims[i]

        # Scan left for peak
        peak_left = cur
        for j in range(i - 1, -1, -1):
            if smoothed_sims[j] >= peak_left:
                peak_left = smoothed_sims[j]
            else:
                break

        # Scan right for peak
        peak_right = cur
        for j in range(i + 1, n_boundaries):
            if smoothed_sims[j] >= peak_right:
                peak_right = smoothed_sims[j]
            else:
                break

        # Local depth + Hearst peak depth
        local_depth = 0.0
        if 0 < i < n_boundaries - 1:
            local_depth = max(0.0, (smoothed_sims[i - 1] - cur) + (smoothed_sims[i + 1] - cur))

        hearst_depth = max(0.0, (peak_left - cur) + (peak_right - cur))
        depth_scores.append(max(local_depth, hearst_depth))

    # 5. Locate peak valleys exceeding threshold
    peak_valleys: list[int] = []
    boundaries: list[TextTileBoundary] = []

    mean_depth = float(np.mean(depth_scores)) if depth_scores else 0.0
    std_depth = float(np.std(depth_scores)) if depth_scores else 0.0
    adaptive_threshold = max(config.min_depth_threshold, mean_depth + 0.3 * std_depth)

    for i in range(n_boundaries):
        depth = depth_scores[i]
        is_valley = True
        if i > 0 and depth_scores[i - 1] > depth:
            is_valley = False
        if i < n_boundaries - 1 and depth_scores[i + 1] > depth:
            is_valley = False

        is_peak = is_valley and (depth >= adaptive_threshold)
        if is_peak:
            peak_valleys.append(i)

        boundaries.append(
            TextTileBoundary(
                unit_index=i,
                depth_score=depth,
                similarity=smoothed_sims[i],
                is_peak=is_peak,
            )
        )

    return TextTilingResult(
        similarities=tuple(smoothed_sims),
        depth_scores=tuple(depth_scores),
        peak_valleys=tuple(peak_valleys),
        boundaries=tuple(boundaries),
    )


def discourse_coherence_bonus(
    start_unit_idx: int,
    end_unit_idx: int,
    total_units: int,
    tiling: TextTilingResult,
) -> float:
    """Calculates thematic cohesion bonus (0.0 to 0.08) for a window span.

    A window spanning a complete thematic episode (starting after a peak valley
    and ending on a peak valley) receives maximum narrative standalone bonus.
    """
    if total_units <= 1 or not tiling.peak_valleys:
        return 0.0

    # Start aligns with discourse boundary if start_unit immediately follows an actual peak valley
    start_aligned = (start_unit_idx - 1) in tiling.peak_valleys

    # End aligns with discourse boundary if end_unit is an actual peak valley
    end_aligned = end_unit_idx in tiling.peak_valleys

    if start_aligned and end_aligned:
        return 0.08
    if start_aligned or end_aligned:
        return 0.04
    return 0.0
