"""``music`` analysis (D05, brief §2) — section detection over the *edited*
(post-cut) timeline, mood classification, and a BPM target from cut cadence.

Pure and deterministic, in `sfx.py`'s own style: no network, no database, no
queue.

Section detection slides a fixed window (default 5 s) across
``[0, duration_ms)`` and, for each window, computes two signals already
available to the producer without decoding media: **speech ratio** (the
fraction of the window covered by a `speechRanges` region — the same
word-timing-derived approximation `PassesService.speechRangesFromWords`
builds for `sfx`) and **cut density** (how many accepted-cut boundary times
fall in or near the window — a proxy for "this stretch was trimmed hard,
it's probably montage/B-roll", since a heavily cut stretch is rarely a single
uninterrupted talking-head take). A window with high speech ratio and low cut
density is *talking*; everything else is *montage*. Adjacent windows of the
same character are merged into one :class:`Section`.

Mood classification takes a per-window sentiment score — normally B11's LLM
client (mocked in every test here, same as the brief's "mock in tests"
instruction: the real client call is `PassesService`'s to make, this module
only consumes whatever score arrives) — and each section's own energy
(derived from cut density) and maps the pair onto a small, fixed mood
taxonomy via one rule table, never free text.
"""

from __future__ import annotations

import itertools
import statistics
from dataclasses import dataclass

__all__ = [
    "MOOD_TAXONOMY",
    "Section",
    "bpm_target_from_cut_cadence",
    "classify_mood",
    "detect_sections",
]

#: A small, fixed mood taxonomy (never free text) — matches the fixture pack's
#: "4 moods" (brief §1): one per quadrant of (energy, sentiment) plus a
#: neutral fallback for the ambiguous middle.
MOOD_TAXONOMY: tuple[str, ...] = ("upbeat", "tense", "dramatic", "calm", "playful", "neutral")

DEFAULT_WINDOW_MS = 5_000
#: A window's cut density (cuts per second) at or above this is "heavily cut".
CUT_DENSITY_ENERGY_MAX = 0.6
#: A window's speech ratio at or above this, with low cut density, is "talking".
TALKING_SPEECH_RATIO = 0.6

#: The two BPM bands the fixture pack ships (brief §1: "4 moods x 2 BPM
#: bands"): a cut cadence at or below `FAST_CADENCE_THRESHOLD_MS` (a cut at
#: least every 0.8 s, on average) targets the fast band; a sparser cadence
#: (or none at all) targets the slow band.
SLOW_BPM = 92
FAST_BPM = 128
FAST_CADENCE_THRESHOLD_MS = 800


@dataclass(frozen=True, slots=True)
class Section:
    s: int
    e: int
    mood: str
    energy: float


def _speech_ratio(
    window_start: int, window_end: int, speech_ranges: list[tuple[int, int]]
) -> float:
    window_len = window_end - window_start
    if window_len <= 0:
        return 0.0
    covered = 0
    for start, end in speech_ranges:
        overlap = min(window_end, end) - max(window_start, start)
        if overlap > 0:
            covered += overlap
    return min(1.0, covered / window_len)


def _cut_density(window_start: int, window_end: int, cut_times_ms: list[int]) -> float:
    """Cuts per second inside `[window_start, window_end)`."""
    window_len_s = (window_end - window_start) / 1000
    if window_len_s <= 0:
        return 0.0
    count = sum(1 for t in cut_times_ms if window_start <= t < window_end)
    return count / window_len_s


def _sentiment_at(t_ms: int, sentiment_by_ms: list[tuple[int, float]]) -> float:
    """Nearest sentiment sample to `t_ms`, or neutral (0.0) with no samples —
    the producer's own stand-in for B11's LLM client sends one score per
    transcript sentence; this just looks up the closest one in time."""
    if not sentiment_by_ms:
        return 0.0
    return min(sentiment_by_ms, key=lambda pair: abs(pair[0] - t_ms))[1]


def classify_mood(sentiment: float, energy: float) -> str:
    """One rule table over (sentiment in [-1, 1], energy in [0, 1]) — the
    fixed taxonomy above, never a free-text label."""
    if energy >= CUT_DENSITY_ENERGY_MAX:
        if sentiment >= 0.2:
            return "upbeat"
        if sentiment <= -0.2:
            return "tense"
        return "dramatic"
    if energy < 0.3:
        if sentiment >= 0.2:
            return "playful"
        return "calm"
    return "neutral"


def detect_sections(
    *,
    duration_ms: int,
    speech_ranges: list[tuple[int, int]] | None = None,
    cut_times_ms: list[int] | None = None,
    sentiment_by_ms: list[tuple[int, float]] | None = None,
    window_ms: int = DEFAULT_WINDOW_MS,
) -> list[Section]:
    """Slides a `window_ms` window across `[0, duration_ms)`, classifies each
    window's mood and energy, then merges adjacent same-mood windows into
    `Section`s — never crossing gaps, so a talking stretch that briefly turns
    dramatic and back stays three sections, not one averaged-over one."""
    if duration_ms <= 0:
        return []
    speech_ranges = speech_ranges or []
    cut_times_ms = sorted(cut_times_ms or [])
    sentiment_by_ms = sentiment_by_ms or []

    windows: list[tuple[int, int, str, float]] = []
    cursor = 0
    while cursor < duration_ms:
        window_end = min(cursor + window_ms, duration_ms)
        speech_ratio = _speech_ratio(cursor, window_end, speech_ranges)
        cut_density = _cut_density(cursor, window_end, cut_times_ms)
        energy = min(1.0, (cut_density / 2) * 0.6 + (1.0 - speech_ratio) * 0.4)
        mid = (cursor + window_end) // 2
        sentiment = _sentiment_at(mid, sentiment_by_ms)
        mood = classify_mood(sentiment, energy)
        windows.append((cursor, window_end, mood, energy))
        cursor = window_end

    if not windows:
        return []

    sections: list[Section] = []
    group_start, _, group_mood, _ = windows[0]
    group_end = windows[0][1]
    group_energies = [windows[0][3]]
    for start, end, mood, energy in windows[1:]:
        if mood == group_mood:
            group_end = end
            group_energies.append(energy)
            continue
        sections.append(
            Section(
                s=group_start, e=group_end, mood=group_mood, energy=statistics.fmean(group_energies)
            )
        )
        group_start, group_end, group_mood = start, end, mood
        group_energies = [energy]
    sections.append(
        Section(
            s=group_start, e=group_end, mood=group_mood, energy=statistics.fmean(group_energies)
        )
    )
    return sections


def bpm_target_from_cut_cadence(
    cut_times_ms: list[int],
    *,
    slow_bpm: int = SLOW_BPM,
    fast_bpm: int = FAST_BPM,
    fast_threshold_ms: int = FAST_CADENCE_THRESHOLD_MS,
) -> int:
    """The average gap between consecutive accepted-cut boundary times, mapped
    onto the fixture pack's two BPM bands: a tight cadence (frequent cuts)
    targets the fast band, a sparse one (or fewer than two cuts to measure a
    gap from) targets the slow band."""
    ordered = sorted(cut_times_ms)
    if len(ordered) < 2:
        return slow_bpm
    gaps = [b - a for a, b in itertools.pairwise(ordered) if b > a]
    if not gaps:
        return slow_bpm
    average_gap = statistics.fmean(gaps)
    return fast_bpm if average_gap <= fast_threshold_ms else slow_bpm
