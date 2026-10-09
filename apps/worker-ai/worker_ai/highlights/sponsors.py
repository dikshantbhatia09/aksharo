"""Teaser, Intro & Sponsor Read Filtering Engine (Pillar 2 §04).

Automatically identifies and prunes sponsored segments, affiliate pitches, channel
intro sequences, duplicate preview teasers, and outro subscribe calls-to-action.

Core capabilities:
1. Zero-shot NLP / heuristic commercial intent classifier computing commercial_score in [0.0, 1.0].
2. Hard-pruning candidate windows with commercial_score > 0.4.
3. Outro & channel subscribe CTA detector for concluding video segments.
4. Introductory duplicate teaser detector scanning the first 90s against later transcript (>180s).
5. SponsorBlock crowd-sourced API integration for YouTube sources.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from worker_ai.highlights.contracts import ExcludeRange
from worker_ai.highlights.windows import Window, Word

__all__ = [
    "COMMERCIAL_SCORE_THRESHOLD",
    "OUTRO_PATTERNS",
    "SPONSOR_PATTERNS",
    "CommercialClassification",
    "classify_commercial_intent",
    "commercial_score",
    "detect_intro_teasers",
    "fetch_sponsorblock_segments_py",
    "filter_commercial_windows",
    "is_commercial_segment",
]

#: The bar above which a window is considered an advertisement read and strictly pruned.
COMMERCIAL_SCORE_THRESHOLD: Final[float] = 0.40

#: Sponsor and commercial intent patterns (sponsor disclaimers, promo codes, brands, discount phrases).
SPONSOR_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    # Direct sponsorship disclaimers
    re.compile(
        r"\b("
        r"sponsored by|"
        r"brought to you by|"
        r"huge thank you to|"
        r"partner of today's episode|"
        r"a word from our sponsor|"
        r"today's sponsor|"
        r"in partnership with|"
        r"thanks to (?:our )?sponsor|"
        r"thanks to .+ for sponsoring|"
        r"proudly supported by|"
        r"partnered with"
        r")\b",
        re.IGNORECASE,
    ),
    # Promo / coupon codes & affiliate calls-to-action
    re.compile(
        r"\b("
        r"promo code|"
        r"discount code|"
        r"coupon code|"
        r"use code\s+[a-z0-9_-]+|"
        r"use code|"
        r"use my code|"
        r"check out the link in|"
        r"link in the description|"
        r"link down below|"
        r"link in bio|"
        r"head over to|"
        r"go to [a-z0-9_-]+\.(?:com|org|io|co|net)/|"
        r"use the link below|"
        r"use coupon|"
        r"special discount|"
        r"exclusive offer"
        r")\b",
        re.IGNORECASE,
    ),
    # Commercial trial, guarantee, purchase terms
    re.compile(
        r"\b("
        r"free trial|"
        r"money[- ]back guarantee|"
        r"risk[- ]free for 30 days|"
        r"risk[- ]free|"
        r"off your first order|"
        r"off your first month|"
        r"percent off|"
        r"\d+%\s*off|"
        r"free shipping|"
        r"cancel anytime|"
        r"first month free|"
        r"save \d+%"
        r")\b",
        re.IGNORECASE,
    ),
    # Known top podcast / YouTube commercial sponsor brands
    re.compile(
        r"\b("
        r"nordvpn|"
        r"expressvpn|"
        r"surfshark|"
        r"manscaped|"
        r"betterhelp|"
        r"athletic greens|"
        r"ag1|"
        r"factor meals|"
        r"factor 75|"
        r"squarespace|"
        r"ridge wallet|"
        r"raycon|"
        r"babbel|"
        r"skillshare|"
        r"audible|"
        r"hellofresh|"
        r"seatgeek|"
        r"prize\s*picks|"
        r"draft\s*kings|"
        r"rocket money|"
        r"incogni|"
        r"simplisafe|"
        r"mint mobile|"
        r"bluechew|"
        r"stamps\.com|"
        r"shopify"
        r")\b",
        re.IGNORECASE,
    ),
)

#: Outro calls-to-action and subscribe sequences.
OUTRO_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(
        r"\b("
        r"don't forget to like and subscribe|"
        r"hit that subscribe button|"
        r"leave a review|"
        r"leave a comment below|"
        r"ring that notification bell|"
        r"smash that like button|"
        r"turn on notifications|"
        r"like and subscribe|"
        r"subscribe to the channel"
        r")\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b("
        r"see you in the next (?:video|episode)|"
        r"thanks for watching|"
        r"tune in next week|"
        r"until next time|"
        r"check out my other video|"
        r"thank you for listening to today's episode"
        r")\b",
        re.IGNORECASE,
    ),
    # Indic / Hinglish outro CTA
    re.compile(
        r"\b("
        r"channel ko subscribe karein|"
        r"video ko like karein|"
        r"milte hain agli video mein|"
        r"subscribe karna na bhoolein"
        r")\b",
        re.IGNORECASE,
    ),
)


@dataclass(frozen=True, slots=True)
class CommercialClassification:
    """Detailed commercial intent analysis of a window or text segment."""

    commercial_score: float
    is_commercial: bool
    is_outro: bool
    reasons: tuple[str, ...]


def commercial_score(text: str) -> float:
    """Calculates commercial score in [0.0, 1.0].

    A value > 0.40 flags the segment as commercial / sponsor content.
    """
    if not text or not text.strip():
        return 0.0

    score = 0.0
    text_lower = text.lower()

    # 1. Direct sponsor disclaimers ("sponsored by", "brought to you by", etc.)
    if SPONSOR_PATTERNS[0].search(text_lower):
        score += 0.65

    # 2. Promo codes and affiliate links ("promo code", "use code", "link in description")
    if SPONSOR_PATTERNS[1].search(text_lower):
        score += 0.45

    # 3. Free trial, money back guarantee, % discounts
    if SPONSOR_PATTERNS[2].search(text_lower):
        score += 0.35

    # 4. Known commercial sponsor brand mentions
    if SPONSOR_PATTERNS[3].search(text_lower):
        score += 0.50

    # 5. Outro subscribe CTA patterns
    if any(pat.search(text_lower) for pat in OUTRO_PATTERNS):
        score += 0.45

    # Clamp to [0.0, 1.0]
    return min(1.0, score)


def classify_commercial_intent(
    text: str,
    *,
    threshold: float = COMMERCIAL_SCORE_THRESHOLD,
) -> CommercialClassification:
    """Classifies commercial intent, detecting ad reads, sponsor pitches, and outros."""
    score = commercial_score(text)
    reasons: list[str] = []
    text_lower = text.lower()

    if SPONSOR_PATTERNS[0].search(text_lower):
        reasons.append("sponsor_disclaimer")
    if SPONSOR_PATTERNS[1].search(text_lower):
        reasons.append("promo_or_coupon")
    if SPONSOR_PATTERNS[2].search(text_lower):
        reasons.append("commercial_offer")
    if SPONSOR_PATTERNS[3].search(text_lower):
        reasons.append("sponsor_brand")

    is_outro = any(pat.search(text_lower) for pat in OUTRO_PATTERNS)
    if is_outro:
        reasons.append("outro_cta")

    return CommercialClassification(
        commercial_score=score,
        is_commercial=score >= threshold,
        is_outro=is_outro,
        reasons=tuple(reasons),
    )


def is_commercial_segment(text: str, *, threshold: float = COMMERCIAL_SCORE_THRESHOLD) -> bool:
    """True if text exceeds commercial threshold or contains outro subscribe CTAs."""
    return commercial_score(text) >= threshold


# ---------------------------------------------------------------------------
# Intro Teaser De-Duplication Detector
# ---------------------------------------------------------------------------


def _clean_tokens(words: Sequence[Word]) -> list[str]:
    """Extracts lowercased alphanumeric tokens from words."""
    tokens = []
    for w in words:
        cleaned = re.sub(r"[^\w\s]", "", w.text.lower()).strip()
        if cleaned:
            tokens.append(cleaned)
    return tokens


def _jaccard_similarity(set_a: frozenset[str], set_b: frozenset[str]) -> float:
    """Computes Jaccard index between two token sets."""
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0


def _shingles(tokens: Sequence[str], k: int = 3) -> frozenset[str]:
    """Builds k-gram shingles for order-sensitive sequence similarity."""
    if len(tokens) < k:
        return frozenset(tokens)
    return frozenset(" ".join(tokens[i : i + k]) for i in range(len(tokens) - k + 1))


def detect_intro_teasers(
    words: Sequence[Word],
    *,
    intro_cutoff_ms: int = 90_000,
    min_later_ms: int = 180_000,
    min_teaser_duration_ms: int = 14_000,
    max_teaser_duration_ms: int = 35_000,
    jaccard_threshold: float = 0.70,
) -> list[tuple[int, int]]:
    """Identifies introductory duplicate teaser sequences in the first 90 seconds.

    If a 15-30 second speech segment in the first 90 seconds appears later in the
    long-form video (timestamp > 180s) with Jaccard index >= 0.70, it is flagged as
    an introductory duplicate teaser.

    Returns:
        List of millisecond spans `[(start_ms, end_ms), ...]` to be excluded.
    """
    if not words:
        return []

    # Divide words into intro candidates (<= 90s), middle section (90s-180s), and main body (> 180s)
    intro_words = [w for w in words if w.start_ms <= intro_cutoff_ms]
    middle_words = [w for w in words if intro_cutoff_ms < w.start_ms < min_later_ms]
    body_words = [w for w in words if w.start_ms >= min_later_ms]

    if not intro_words or not body_words:
        return []

    middle_tokens = _clean_tokens(middle_words)
    middle_shingle_set = _shingles(middle_tokens, k=3) if len(middle_tokens) >= 5 else frozenset()

    intro_spans: list[tuple[int, int, frozenset[str], frozenset[str]]] = []

    # Slide candidate sequences across intro (15s to 35s)
    n_intro = len(intro_words)
    step = max(1, n_intro // 20)
    for i in range(0, n_intro, step):
        for j in range(i + 5, min(n_intro, i + 60)):
            span_start = intro_words[i].start_ms
            span_end = intro_words[j].end_ms
            duration = span_end - span_start
            if min_teaser_duration_ms <= duration <= max_teaser_duration_ms:
                slice_tokens = _clean_tokens(intro_words[i : j + 1])
                if len(slice_tokens) >= 12:
                    token_set = frozenset(slice_tokens)
                    shingle_set = _shingles(slice_tokens, k=3)
                    # If this phrase is already repeating continuously in the middle (90s-180s),
                    # it is a recurring filler phrase, not an intro teaser plucked from >180s
                    if middle_shingle_set and shingle_set:
                        if len(shingle_set & middle_shingle_set) / len(shingle_set) >= 0.65:
                            continue
                    intro_spans.append((span_start, span_end, token_set, shingle_set))

    if not intro_spans:
        return []

    body_tokens = _clean_tokens(body_words)
    if len(body_tokens) < 10:
        return []

    body_shingle_set = _shingles(body_tokens, k=3)
    body_token_set = frozenset(body_tokens)

    # Pre-build sliding body token windows
    teaser_intervals: list[tuple[int, int]] = []
    n_body = len(body_words)

    for start_ms, end_ms, token_set, shingle_set in intro_spans:
        # Fast $O(1)$ rejection: if intro shingles don't even exist in the body, skip immediately
        if shingle_set:
            shingle_overlap = len(shingle_set & body_shingle_set) / len(shingle_set)
            if shingle_overlap < 0.70:
                continue
        else:
            token_overlap = len(token_set & body_token_set) / len(token_set)
            if token_overlap < 0.70:
                continue

        target_token_count = len(token_set)
        # Detailed localized verification: a genuine teaser preview corresponds to
        # exactly one original scene later in the video (>180s)
        matched_occurrences = 0
        body_step = max(1, n_body // 50)
        last_match_end = -1
        for b_start in range(0, n_body - 5, body_step):
            if b_start < last_match_end:
                continue
            b_end = min(n_body - 1, b_start + target_token_count + 5)
            if b_end <= b_start:
                continue
            slice_body = _clean_tokens(body_words[b_start : b_end + 1])
            if not slice_body:
                continue
            b_token_set = frozenset(slice_body)
            jaccard = _jaccard_similarity(token_set, b_token_set)
            if jaccard >= jaccard_threshold:
                matched_occurrences += 1
                last_match_end = b_end
                continue
            if len(shingle_set) > 0:
                b_shingle_set = _shingles(slice_body, k=3)
                shingle_jaccard = _jaccard_similarity(shingle_set, b_shingle_set)
                if shingle_jaccard >= 0.75:
                    matched_occurrences += 1
                    last_match_end = b_end
                    continue

        # If matched_occurrences == 1, it's a genuine 1-to-1 teaser preview.
        # If > 1, it is a repeating background phrase/chorus/filler across the whole episode.
        if matched_occurrences == 1:
            teaser_intervals.append((start_ms, end_ms))

    if not teaser_intervals:
        return []

    # Merge overlapping teaser intervals
    teaser_intervals.sort()
    merged: list[tuple[int, int]] = []
    for start, end in teaser_intervals:
        if not merged:
            merged.append((start, end))
        else:
            prev_start, prev_end = merged[-1]
            if start <= prev_end:
                merged[-1] = (prev_start, max(prev_end, end))
            else:
                merged.append((start, end))

    return merged


# ---------------------------------------------------------------------------
# Candidate Window Pruning
# ---------------------------------------------------------------------------


def filter_commercial_windows(
    windows: Sequence[Window],
    words: Sequence[Word],
    *,
    threshold: float = COMMERCIAL_SCORE_THRESHOLD,
    exclude_ranges: Sequence[tuple[int, int] | ExcludeRange] | None = None,
) -> list[Window]:
    """Strictly prunes candidate windows with commercial_score > threshold or overlapping exclude ranges."""
    spans: list[tuple[int, int]] = []
    if exclude_ranges:
        for r in exclude_ranges:
            if isinstance(r, ExcludeRange):
                spans.append((r.start_ms, r.end_ms))
            else:
                spans.append((r[0], r[1]))

    clean: list[Window] = []
    for w in windows:
        # Check exclusion ranges (SponsorBlock or Intro Teaser spans)
        if any(w.start_ms < end and start < w.end_ms for start, end in spans):
            continue

        # Check commercial text score
        window_words = words[w.first : w.last + 1]
        text = " ".join(word.text for word in window_words)
        score = commercial_score(text)
        if score >= threshold:
            continue

        clean.append(w)

    return clean


# ---------------------------------------------------------------------------
# SponsorBlock API Query (Python fallback helper)
# ---------------------------------------------------------------------------


def fetch_sponsorblock_segments_py(
    video_id: str,
    *,
    categories: Sequence[str] = ("sponsor", "selfpromo", "intro", "outro"),
    timeout_s: float = 3.0,
) -> list[tuple[int, int]]:
    """Queries SponsorBlock API for crowd-verified sponsor cut points.

    Returns millisecond intervals `[(start_ms, end_ms), ...]`.
    """
    if not video_id or len(video_id.strip()) != 11:
        return []

    cats_json = json.dumps(list(categories))
    query = urllib.parse.urlencode({
        "videoID": video_id.strip(),
        "categories": cats_json,
    })
    url = f"https://sponsor.ajay.app/api/skipSegments?{query}"

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Aksharo-SponsorFilter/1.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as response:
            if response.status != 200:
                return []
            body = response.read().decode("utf-8")
            data = json.loads(body)
            if not isinstance(data, list):
                return []

            intervals: list[tuple[int, int]] = []
            for item in data:
                if isinstance(item, dict) and "segment" in item:
                    seg = item["segment"]
                    if isinstance(seg, list) and len(seg) >= 2:
                        start_ms = round(float(seg[0]) * 1000)
                        end_ms = round(float(seg[1]) * 1000)
                        if end_ms > start_ms:
                            intervals.append((start_ms, end_ms))
            return intervals
    except urllib.error.HTTPError as http_err:
        # 404 indicates video not found in database, which is completely expected
        return []
    except Exception:
        return []
