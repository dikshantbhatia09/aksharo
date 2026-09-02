"""``autocut`` — the B18 edit pass: VAD silences, filler words, repeated takes.

Pure and deterministic. This module never touches the network, the database or
the job queue: it takes a transcript's words, VAD speech regions and a handful of
protection facts, and returns cut proposals (`CONTRACTS §2` `PassItem.kind ==
"cut"`). `apps/worker_ai/worker_ai/processors/autocut_pass.py` is the thin queue
adapter that unwraps a job payload into :class:`AutocutInput`, calls
:func:`run_autocut`, and reshapes the result for the completion callback; keeping
this module free of that plumbing is what makes it fast to property-test and
what B19 (reframe/zoom) can lean on for its own pass-item shaping.

Pipeline, in order:

1. **Silence detection** — gaps between VAD speech regions (and the lead-in/
   trail-out of the file) at least ``minSilence`` long, trimmed by ``padding``
   (80 ms) on each side so the cut boundary never eats the first/last phoneme of
   real speech.
2. **Long pause detection** — the same gap test applied *inside* a speech run,
   between two words whose region agrees; tagged ``reason="pause"`` rather than
   ``"silence"`` so the review UI can explain why a mid-sentence gap was flagged.
3. **Filler detection** — a per-language lexicon (`packages/prompts/lexicons/
   fillers/*.json`) matched against each word's lowercased text and script
   variants. ``contextRule: "always"`` fillers ("um", "uh", "अं") are proposed
   wherever they occur; ``contextRule: "isolated_only"`` fillers ("matlab",
   "like", "toh") are proposed only when they sit at a clause start or are
   flanked by a pause >= 120 ms on either side — the guard the brief calls out
   to keep continuous speech (a "like" mid-sentence used as a verb, "toh" used as
   a connector) free of false positives.
4. **Retake detection** — adjacent sentence windows (split on end-of-sentence
   punctuation or a pause >= 400 ms) within 20 s of each other, compared by a
   normalised n-gram similarity; a pair at or above 0.8 keeps the later take and
   proposes cutting the earlier one(s).
5. **Protection and merge** — candidates that touch a protected range or a
   guarded (emphasis/textOverrides) span are dropped; overlapping candidates are
   merged; a kept segment shorter than 350 ms is bridged into its neighbours; the
   pacing preset's removal cap is enforced by dropping the lowest-confidence
   items first.

No candidate ever splits a word: every boundary is either a word's own `s`/`e`
or a gap between two words, so "never cut inside a word" is true by
construction rather than by a check.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from functools import cache, lru_cache
from itertools import pairwise
from pathlib import Path
from typing import Literal

__all__ = [
    "ISOLATED_PAUSE_MS",
    "MIN_KEPT_SEGMENT_MS",
    "PADDING_MS",
    "PRESETS",
    "RETAKE_SIMILARITY_THRESHOLD",
    "RETAKE_WINDOW_MS",
    "SENTENCE_BREAK_PAUSE_MS",
    "AutocutInput",
    "AutocutResult",
    "CutCandidate",
    "Lexicon",
    "LexiconEntry",
    "Preset",
    "SpeechRegion",
    "Word",
    "lexicon_path",
    "load_lexicon",
    "run_autocut",
]

Reason = Literal["silence", "pause", "filler", "retake"]
ContextRule = Literal["always", "isolated_only"]

#: Fixed trim applied to both edges of every silence-family cut (brief §2).
PADDING_MS = 80
#: A cut is never allowed to leave less than this much kept audio between two
#: neighbouring cuts; a shorter remainder is bridged into one larger cut.
MIN_KEPT_SEGMENT_MS = 350
#: Retake candidates are only compared across sentences this close together.
RETAKE_WINDOW_MS = 20_000
RETAKE_SIMILARITY_THRESHOLD = 0.8
#: An `isolated_only` filler needs a pause at least this long on one side (or a
#: clause start) to be proposed.
ISOLATED_PAUSE_MS = 120
#: A gap at least this long between words ends a "sentence" window for retake
#: detection, on top of terminal punctuation.
SENTENCE_BREAK_PAUSE_MS = 400

_SENTENCE_END_RE = re.compile(r"[.!?।॥؟]\s*$")
_WORD_RE = re.compile(r"\w+", re.UNICODE)


@dataclass(frozen=True, slots=True)
class Word:
    """The slice of the frozen `Word` type (CONTRACTS §2) this pass needs."""

    wid: str
    s: int
    e: int
    t: str
    filler: bool | None = None
    scripts: dict[str, str] | None = None


@dataclass(frozen=True, slots=True)
class SpeechRegion:
    """A VAD speech region, source milliseconds."""

    start_ms: int
    end_ms: int


@dataclass(frozen=True, slots=True)
class LexiconEntry:
    token: str
    context_rule: ContextRule
    weight: float
    scripts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Lexicon:
    language: str
    entries: tuple[LexiconEntry, ...]

    def match(self, text: str) -> LexiconEntry | None:
        """The entry whose token (or a script variant) equals `text`, case-folded."""
        key = _normalise(text)
        return self._index().get(key)

    @cache  # noqa: B019 - one Lexicon per language, process-lifetime
    def _index(self) -> dict[str, LexiconEntry]:
        index: dict[str, LexiconEntry] = {}
        for entry in self.entries:
            index.setdefault(_normalise(entry.token), entry)
            for variant in entry.scripts:
                index.setdefault(_normalise(variant), entry)
        return index


@dataclass(frozen=True, slots=True)
class Preset:
    name: str
    min_silence_ms: int
    max_removal_ratio: float


#: Pacing presets (brief §2): silence threshold and the removal cap it pairs with.
PRESETS: dict[str, Preset] = {
    "gentle": Preset(name="gentle", min_silence_ms=1_000, max_removal_ratio=0.15),
    "standard": Preset(name="standard", min_silence_ms=600, max_removal_ratio=0.30),
    "tight": Preset(name="tight", min_silence_ms=400, max_removal_ratio=0.45),
}


@dataclass(frozen=True, slots=True)
class CutCandidate:
    """One proposed cut, before it becomes an `edg_pass_items` row.

    `word_ids` is carried for protection/merge logic inside this module and for
    the processor's own bookkeeping; `CutPayloadSchema` is frozen empty
    (CONTRACTS §2), so the queue adapter does not put it on the wire — see
    `processors/autocut_pass.py`.
    """

    start_ms: int
    end_ms: int
    reason: Reason
    confidence: float
    word_ids: tuple[str, ...] = ()

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


@dataclass(frozen=True, slots=True)
class AutocutInput:
    words: tuple[Word, ...]
    speech_regions: tuple[SpeechRegion, ...]
    duration_ms: int
    preset: str = "standard"
    lexicon: Lexicon | None = None
    #: Overrides. `None` keeps the preset's own value.
    min_silence_ms: int | None = None
    padding_ms: int = PADDING_MS
    max_removal_ratio: float | None = None
    #: Ranges (ms) that must never be touched by any cut (`EdgHot.protected[]` —
    #: see the module docstring's CONTRACTS note).
    protected_ranges: tuple[tuple[int, int], ...] = ()
    #: Word ids that carry emphasis/textOverrides on their segment: a filler
    #: candidate naming one of these is dropped outright.
    guarded_word_ids: frozenset[str] = field(default_factory=frozenset)
    #: Ranges (ms) covered by a segment with emphasis/textOverrides: silence,
    #: pause and retake candidates overlapping one of these are dropped.
    guarded_ranges: tuple[tuple[int, int], ...] = ()

    def preset_config(self) -> Preset:
        base = PRESETS.get(self.preset, PRESETS["standard"])
        min_silence = base.min_silence_ms if self.min_silence_ms is None else self.min_silence_ms
        ratio = base.max_removal_ratio if self.max_removal_ratio is None else self.max_removal_ratio
        return Preset(name=base.name, min_silence_ms=min_silence, max_removal_ratio=ratio)


@dataclass(frozen=True, slots=True)
class AutocutResult:
    items: tuple[CutCandidate, ...]
    counts: dict[str, int]
    total_removed_ms: int
    total_kept_ms: int
    preset: Preset


# ---------------------------------------------------------------------------
# Lexicons
# ---------------------------------------------------------------------------


def lexicon_path(language: str, *, root: Path | None = None) -> Path:
    """Where `{language}.json` lives under `packages/prompts/lexicons/fillers`."""
    base = root if root is not None else _default_lexicon_root()
    return base / f"{_lexicon_filename(language)}.json"


def _default_lexicon_root() -> Path:
    return _repo_root() / "packages" / "prompts" / "lexicons" / "fillers"


def _lexicon_filename(language: str) -> str:
    """`hi-Latn`, `hi_IN`, `HI` all resolve to the `hi` file; `hinglish` is its own file."""
    lowered = language.strip().lower()
    if lowered in ("hinglish", "hi-latn-mixed"):
        return "hinglish"
    return lowered.split("-")[0].split("_")[0] or "en"


@lru_cache(maxsize=32)
def load_lexicon(language: str, *, root: Path | None = None) -> Lexicon:
    """Load and cache a language's filler lexicon; falls back to English."""
    path = lexicon_path(language, root=root)
    if not path.exists():
        path = lexicon_path("en", root=root)
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = tuple(
        LexiconEntry(
            token=item["token"],
            context_rule=item.get("contextRule", "isolated_only"),
            weight=float(item.get("weight", 0.5)),
            scripts=tuple(item.get("scripts", {}).values()),
        )
        for item in data.get("entries", [])
    )
    return Lexicon(language=data.get("language", language), entries=entries)


def _repo_root() -> Path:
    # apps/worker-ai/worker_ai/passes/autocut.py -> repo root is four parents up.
    return Path(__file__).resolve().parents[4]


def _normalise(text: str) -> str:
    return unicodedata.normalize("NFC", text).strip().casefold()


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------


def _detect_silences(
    input_: AutocutInput, min_silence_ms: int, padding_ms: int
) -> list[CutCandidate]:
    """Gaps between VAD speech regions (and the file's lead-in/trail-out)."""
    regions = sorted(input_.speech_regions, key=lambda region: region.start_ms)
    raw: list[CutCandidate | None] = []

    cursor = 0
    for region in regions:
        gap = region.start_ms - cursor
        if gap >= min_silence_ms:
            raw.append(_silence_candidate(cursor, region.start_ms, padding_ms, min_silence_ms))
        cursor = max(cursor, region.end_ms)

    trailing_gap = input_.duration_ms - cursor
    if trailing_gap >= min_silence_ms:
        raw.append(_silence_candidate(cursor, input_.duration_ms, padding_ms, min_silence_ms))

    return [candidate for candidate in raw if candidate is not None]


def _silence_candidate(
    gap_start: int, gap_end: int, padding_ms: int, min_silence_ms: int
) -> CutCandidate | None:
    start = gap_start + padding_ms
    end = gap_end - padding_ms
    if end <= start:
        return None
    gap_ms = gap_end - gap_start
    confidence = _confidence_for_gap(gap_ms, min_silence_ms)
    return CutCandidate(start_ms=start, end_ms=end, reason="silence", confidence=confidence)


def _detect_pauses(
    input_: AutocutInput, min_silence_ms: int, padding_ms: int
) -> list[CutCandidate]:
    """Gaps between consecutive words that sit inside the same VAD speech region."""
    words = sorted(input_.words, key=lambda word: word.s)
    regions = sorted(input_.speech_regions, key=lambda region: region.start_ms)
    candidates: list[CutCandidate] = []

    for previous, current in pairwise(words):
        gap = current.s - previous.e
        if gap < min_silence_ms:
            continue
        if not _same_region(previous.e, current.s, regions):
            continue  # a gap that straddles a region boundary is already "silence"
        start = previous.e + padding_ms
        end = current.s - padding_ms
        if end <= start:
            continue
        confidence = _confidence_for_gap(gap, min_silence_ms)
        candidates.append(
            CutCandidate(start_ms=start, end_ms=end, reason="pause", confidence=confidence)
        )
    return candidates


def _same_region(end_ms: int, start_ms: int, regions: list[SpeechRegion]) -> bool:
    return any(region.start_ms <= end_ms and start_ms <= region.end_ms for region in regions)


def _confidence_for_gap(gap_ms: int, min_silence_ms: int) -> float:
    if min_silence_ms <= 0:
        return 0.99
    ratio = gap_ms / (min_silence_ms * 2)
    return round(min(0.99, max(0.55, ratio)), 4)


def _detect_fillers(
    input_: AutocutInput, lexicon: Lexicon, guarded_word_ids: frozenset[str]
) -> list[CutCandidate]:
    words = sorted(input_.words, key=lambda word: word.s)
    candidates: list[CutCandidate] = []

    for index, word in enumerate(words):
        if word.wid in guarded_word_ids:
            continue
        entry = lexicon.match(word.t) or _match_script(lexicon, word)
        if entry is None:
            continue

        previous = words[index - 1] if index > 0 else None
        following = words[index + 1] if index + 1 < len(words) else None
        gap_before = word.s - previous.e if previous is not None else None
        gap_after = following.s - word.e if following is not None else None
        clause_start = previous is None or bool(_SENTENCE_END_RE.search(previous.t))

        if entry.context_rule == "isolated_only":
            isolated = (
                clause_start
                or (gap_before is not None and gap_before >= ISOLATED_PAUSE_MS)
                or (gap_after is not None and gap_after >= ISOLATED_PAUSE_MS)
            )
            if not isolated:
                continue

        confidence = entry.weight
        candidates.append(
            CutCandidate(
                start_ms=word.s,
                end_ms=word.e,
                reason="filler",
                confidence=round(confidence, 4),
                word_ids=(word.wid,),
            )
        )
    return candidates


def _match_script(lexicon: Lexicon, word: Word) -> LexiconEntry | None:
    if not word.scripts:
        return None
    for variant in word.scripts.values():
        entry = lexicon.match(variant)
        if entry is not None:
            return entry
    return None


@dataclass(frozen=True, slots=True)
class _Sentence:
    start_ms: int
    end_ms: int
    tokens: tuple[str, ...]
    word_ids: tuple[str, ...]


def _sentences(words: list[Word]) -> list[_Sentence]:
    sentences: list[_Sentence] = []
    current: list[Word] = []

    def flush() -> None:
        if not current:
            return
        sentences.append(
            _Sentence(
                start_ms=current[0].s,
                end_ms=current[-1].e,
                tokens=tuple(_normalise(w.t) for w in current if _WORD_RE.search(w.t)),
                word_ids=tuple(w.wid for w in current),
            )
        )
        current.clear()

    previous: Word | None = None
    for word in words:
        if previous is not None:
            gap = word.s - previous.e
            if gap >= SENTENCE_BREAK_PAUSE_MS or _SENTENCE_END_RE.search(previous.t):
                flush()
        current.append(word)
        previous = word
    flush()
    return sentences


def _detect_retakes(input_: AutocutInput) -> list[CutCandidate]:
    words = sorted(input_.words, key=lambda word: word.s)
    sentences = [sentence for sentence in _sentences(words) if sentence.tokens]
    candidates: list[CutCandidate] = []

    index = 0
    while index < len(sentences) - 1:
        current = sentences[index]
        nxt = sentences[index + 1]
        if nxt.start_ms - current.end_ms > RETAKE_WINDOW_MS:
            index += 1
            continue
        similarity = _similarity(current.tokens, nxt.tokens)
        if similarity >= RETAKE_SIMILARITY_THRESHOLD:
            candidates.append(
                CutCandidate(
                    start_ms=current.start_ms,
                    end_ms=current.end_ms,
                    reason="retake",
                    confidence=round(similarity, 4),
                    word_ids=current.word_ids,
                )
            )
        index += 1
    return candidates


def _similarity(a: tuple[str, ...], b: tuple[str, ...]) -> float:
    if not a or not b:
        return 0.0
    set_a, set_b = set(a), set(b)
    jaccard = len(set_a & set_b) / len(set_a | set_b) if (set_a or set_b) else 0.0
    sequence = SequenceMatcher(a=a, b=b).ratio()
    # The average of a set-overlap and an order-sensitive ratio: two takes that
    # reorder a couple of words still count as the same sentence, but a sentence
    # that shares words without following the same shape does not.
    return (jaccard + sequence) / 2


# ---------------------------------------------------------------------------
# Protection, merge, cap
# ---------------------------------------------------------------------------


def _overlaps_any(start: int, end: int, ranges: tuple[tuple[int, int], ...]) -> bool:
    return any(start < range_end and range_start < end for range_start, range_end in ranges)


def _apply_protection(
    candidates: list[CutCandidate], input_: AutocutInput
) -> list[CutCandidate]:
    ranges = tuple(input_.protected_ranges) + tuple(input_.guarded_ranges)
    if not ranges and not input_.guarded_word_ids:
        return candidates
    kept: list[CutCandidate] = []
    for candidate in candidates:
        if candidate.word_ids and any(wid in input_.guarded_word_ids for wid in candidate.word_ids):
            continue
        if _overlaps_any(candidate.start_ms, candidate.end_ms, ranges):
            continue
        kept.append(candidate)
    return kept


#: Priority when two overlapping candidates disagree on `reason` after a merge.
_REASON_PRIORITY: dict[Reason, int] = {"retake": 3, "filler": 2, "pause": 1, "silence": 0}


def _merge_overlaps(candidates: list[CutCandidate]) -> list[CutCandidate]:
    ordered = sorted(candidates, key=lambda item: (item.start_ms, item.end_ms))
    merged: list[CutCandidate] = []
    for candidate in ordered:
        if merged and candidate.start_ms <= merged[-1].end_ms:
            merged[-1] = _combine(merged[-1], candidate)
        else:
            merged.append(candidate)
    return merged


def _combine(a: CutCandidate, b: CutCandidate) -> CutCandidate:
    reason = a.reason if _REASON_PRIORITY[a.reason] >= _REASON_PRIORITY[b.reason] else b.reason
    return CutCandidate(
        start_ms=min(a.start_ms, b.start_ms),
        end_ms=max(a.end_ms, b.end_ms),
        reason=reason,
        confidence=max(a.confidence, b.confidence),
        word_ids=tuple(dict.fromkeys((*a.word_ids, *b.word_ids))),
    )


def _bridge_short_kept_segments(
    candidates: list[CutCandidate], min_kept_ms: int
) -> list[CutCandidate]:
    """Merge two cuts whose kept remainder between them is under `min_kept_ms`."""
    ordered = sorted(candidates, key=lambda item: item.start_ms)
    changed = True
    while changed:
        changed = False
        result: list[CutCandidate] = []
        skip_next = False
        for index, candidate in enumerate(ordered):
            if skip_next:
                skip_next = False
                continue
            if index + 1 < len(ordered):
                nxt = ordered[index + 1]
                kept = nxt.start_ms - candidate.end_ms
                if 0 < kept < min_kept_ms:
                    result.append(_combine(candidate, nxt))
                    skip_next = True
                    changed = True
                    continue
            result.append(candidate)
        ordered = result
    return ordered


def _apply_removal_cap(
    candidates: list[CutCandidate], duration_ms: int, max_removal_ratio: float
) -> list[CutCandidate]:
    if duration_ms <= 0:
        return candidates
    cap_ms = duration_ms * max_removal_ratio
    total = sum(candidate.duration_ms for candidate in candidates)
    if total <= cap_ms:
        return candidates

    # Highest-confidence items fill the budget first; anything that would push
    # the running total past the cap is dropped, however confident it is — a
    # single candidate wider than the whole cap is dropped too, rather than let
    # through "because it was first" (the cap is a hard ceiling, not a quota).
    kept = sorted(candidates, key=lambda item: item.confidence, reverse=True)
    running = 0
    accepted: list[CutCandidate] = []
    for candidate in kept:
        if running + candidate.duration_ms > cap_ms:
            continue
        accepted.append(candidate)
        running += candidate.duration_ms
    return sorted(accepted, key=lambda item: item.start_ms)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run_autocut(input_: AutocutInput) -> AutocutResult:
    """Run the full autocut pipeline and return the merged, capped cut list."""
    preset = input_.preset_config()
    padding_ms = input_.padding_ms
    lexicon = input_.lexicon or load_lexicon("en")

    silences = _detect_silences(input_, preset.min_silence_ms, padding_ms)
    pauses = _detect_pauses(input_, preset.min_silence_ms, padding_ms)
    fillers = _detect_fillers(input_, lexicon, input_.guarded_word_ids)
    retakes = _detect_retakes(input_)

    counts = {
        "silence": len(silences),
        "pause": len(pauses),
        "filler": len(fillers),
        "retake": len(retakes),
    }

    all_candidates = [*silences, *pauses, *fillers, *retakes]
    all_candidates = [
        c for c in all_candidates if 0 <= c.start_ms < c.end_ms <= max(input_.duration_ms, c.end_ms)
    ]
    protected = _apply_protection(all_candidates, input_)
    merged = _merge_overlaps(protected)
    # The cap is applied to the merged (but not yet bridged) candidates, so it
    # ranks genuinely distinct proposals by confidence rather than a
    # bridging-inflated blob; bridging runs last purely to satisfy the minimum
    # kept-segment invariant among whatever the cap let through.
    capped = _apply_removal_cap(merged, input_.duration_ms, preset.max_removal_ratio)
    bridged = _bridge_short_kept_segments(capped, MIN_KEPT_SEGMENT_MS)
    # Bridging can push the total slightly over the cap (it exists to satisfy a
    # different invariant — no sliver of kept audio under 350ms — and the two
    # can conflict on a dense fixture). A second, final cap pass is the safety
    # net: it only ever *drops* an already-bridged item, which can only enlarge
    # a kept segment, never shrink one below the minimum again.
    bridged = _apply_removal_cap(bridged, input_.duration_ms, preset.max_removal_ratio)

    total_removed = sum(item.duration_ms for item in bridged)
    total_kept = max(0, input_.duration_ms - total_removed)

    return AutocutResult(
        items=tuple(sorted(bridged, key=lambda item: item.start_ms)),
        counts=counts,
        total_removed_ms=total_removed,
        total_kept_ms=total_kept,
        preset=preset,
    )
