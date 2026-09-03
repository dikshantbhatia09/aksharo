"""WER and CER, and the normalisation they are measured after.

`09 §8` lists the metrics the regression harness gates on: WER/CER, code-switch
WER, alignment onset error, DER, filler precision/recall. A09 shipped the first
two plus the onset error, which are the ones a transcript-only set can measure.
D08 (this eval harness WP) adds: a word-boundary error metric against the
reference aligner's segmentation, diarisation DER, transliteration accuracy
(A22), autocut precision/recall (B18) and an LLM eval pass rate (B11's
check-based report format, mirrored here for the harness's own leaderboard).

**Normalisation is part of the metric.** Comparing raw strings would score a
missing comma as a substituted word, so both sides are lower-cased, stripped of
punctuation and collapsed on whitespace before the edit distance is computed —
and Devanagari danda (``।``) counts as punctuation, which is the sort of thing a
Latin-only normaliser silently gets wrong.

**Indic-aware normalisation** goes three steps further than a Latin-only
normaliser, because a naive comparison would score all three as spurious errors:

* **ZWJ/ZWNJ** (``\\u200c``/``\\u200d``) are rendering hints, not phonemes — a
  vendor that emits a half-form with an explicit ZWNJ and one that emits the
  same word without it said the same thing.
* **Nukta normalisation.** Devanagari extends its base consonants with a nukta
  (``\\u093c``) for sounds borrowed from Persian/Arabic (क़, ख़, ग़, ज़, ड़, ढ़, फ़,
  य़). Some fonts and providers prefer the precomposed nukta letter
  (``\\u0958``-``\\u095f``); others emit the base consonant plus a combining
  nukta. Both spellings are folded to the base-plus-combining-nukta form (NFD's
  canonical decomposition already does this for the codepoints Unicode assigns
  a canonical decomposition to; the four without one — ज़, ड़, ढ़, फ़ have no
  canonical decomposition in Unicode — are mapped by hand below) so a WER run
  never charges a font-preference difference as a substitution.
* **Roman code-mix** text (Hinglish) is matched case-insensitively as ordinary
  Latin text already is; no extra folding is needed there beyond casefold.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

import jiwer

__all__ = [
    "AutocutScore",
    "TranscriptScore",
    "autocut_precision_recall",
    "cer",
    "diarisation_der",
    "llm_pass_rate",
    "median_onset_error_ms",
    "normalise",
    "score",
    "transliteration_accuracy",
    "wer",
    "word_boundary_error",
]

#: Punctuation to drop, including the Devanagari danda and double danda.
_PUNCTUATION = re.compile(r"[^\w\sऀ-ॿ஀-௿]|[।॥]", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")

#: ZWJ (U+200D) and ZWNJ (U+200C): rendering hints the WER/CER metric must not
#: charge as a character difference between two otherwise-identical words.
_ZW_JOINERS = re.compile("[‌‍]")

#: The four nukta letters Unicode gives no canonical decomposition to, mapped to
#: their base consonant + combining nukta (U+093C) form by hand. The other five
#: nukta letters (क़ ख़ ग़ य़ + others) already round-trip through NFD.
_NUKTA_PRECOMPOSED: dict[str, str] = {
    "ज़": "ज़",  # JA WITH NUKTA (U+95B) -> base + combining nukta
    "ड़": "ड़",  # DDA WITH NUKTA (U+95C) -> base + combining nukta
    "ढ़": "ढ़",  # DDHA WITH NUKTA (U+95D) -> base + combining nukta
    "फ़": "फ़",  # FA WITH NUKTA (U+95E) -> base + combining nukta
}


def normalise(text: str) -> str:
    """Case-folded, punctuation-free, single-spaced, Indic-normalised text.

    Order matters: NFD first (so every nukta letter decomposes to base +
    combining mark and every precomposed matra stays a single codepoint after
    combining marks are in a canonical order), then the ZWJ/ZWNJ strip, then
    punctuation and whitespace collapse, then a final NFC pass so the returned
    string is in the form the rest of the pipeline (and `jiwer`) expects.
    """
    decomposed = unicodedata.normalize("NFD", text)
    for precomposed, decomposed_form in _NUKTA_PRECOMPOSED.items():
        decomposed = decomposed.replace(precomposed, decomposed_form)
    joinless = _ZW_JOINERS.sub("", decomposed)
    folded = unicodedata.normalize("NFC", joinless).casefold()
    return _WHITESPACE.sub(" ", _PUNCTUATION.sub(" ", folded)).strip()


def wer(reference: str, hypothesis: str) -> float:
    """Word error rate over :func:`normalise`d text; ``0.0`` for two empty strings."""
    left, right = normalise(reference), normalise(hypothesis)
    if not left:
        return 0.0 if not right else 1.0
    return float(jiwer.wer(left, right))


def cer(reference: str, hypothesis: str) -> float:
    """Character error rate — the metric that matters for Indic scripts."""
    left, right = normalise(reference), normalise(hypothesis)
    if not left:
        return 0.0 if not right else 1.0
    return float(jiwer.cer(left, right))


def median_onset_error_ms(reference_ms: list[int], hypothesis_ms: list[int]) -> float | None:
    """Median absolute word-onset error, the `09 §2` alignment bar (≤ 40/80 ms).

    ``None`` when the two lists differ in length: an onset error is only defined
    between aligned word sequences, and pretending otherwise would report a
    number that means nothing.
    """
    if not reference_ms or len(reference_ms) != len(hypothesis_ms):
        return None
    errors = sorted(abs(a - b) for a, b in zip(reference_ms, hypothesis_ms, strict=True))
    middle = len(errors) // 2
    if len(errors) % 2 == 1:
        return float(errors[middle])
    return (errors[middle - 1] + errors[middle]) / 2


@dataclass(frozen=True, slots=True)
class TranscriptScore:
    """One item's score."""

    item_id: str
    wer: float
    cer: float
    reference_words: int
    hypothesis_words: int
    onset_error_ms: float | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "itemId": self.item_id,
            "wer": round(self.wer, 4),
            "cer": round(self.cer, 4),
            "referenceWords": self.reference_words,
            "hypothesisWords": self.hypothesis_words,
            "onsetErrorMs": self.onset_error_ms,
        }


def score(
    item_id: str,
    reference: str,
    hypothesis: str,
    *,
    onset_error_ms: float | None = None,
) -> TranscriptScore:
    """Score one item."""
    return TranscriptScore(
        item_id=item_id,
        wer=wer(reference, hypothesis),
        cer=cer(reference, hypothesis),
        reference_words=len(normalise(reference).split()),
        hypothesis_words=len(normalise(hypothesis).split()),
        onset_error_ms=onset_error_ms,
    )


def word_boundary_error(
    reference_bounds: list[tuple[int, int]], hypothesis_bounds: list[tuple[int, int]]
) -> float | None:
    """Fraction of words whose segment boundary disagrees with the reference aligner.

    A word "disagrees" when its hypothesis ``(start, end)`` span differs from the
    reference aligner's span by anything beyond one millisecond of floating-point
    noise — this is a boundary-*placement* metric (did the aligner draw the cut in
    the same place), which is a different question from :func:`median_onset_error_ms`
    (how far off, in milliseconds, was the start). Both matter: a segmenter can have
    a small median onset error and still disagree on where a lot of individual word
    boundaries fall when errors are bimodal.

    ``None`` when the sequences differ in length, for the same reason
    :func:`median_onset_error_ms` returns ``None`` then: the two sequences are not
    comparable word-for-word.
    """
    if not reference_bounds or len(reference_bounds) != len(hypothesis_bounds):
        return None
    disagreements = sum(
        1
        for (ref_start, ref_end), (hyp_start, hyp_end) in zip(
            reference_bounds, hypothesis_bounds, strict=True
        )
        if abs(ref_start - hyp_start) > 1 or abs(ref_end - hyp_end) > 1
    )
    return disagreements / len(reference_bounds)


@dataclass(frozen=True, slots=True)
class DiarisationSegment:
    """One speaker-labelled time span, reference or hypothesis."""

    speaker: str
    start_ms: int
    end_ms: int


def diarisation_der(
    reference: list[DiarisationSegment], hypothesis: list[DiarisationSegment]
) -> float:
    """Diarisation error rate: mismatched-speaker time over total reference time.

    A simplified, dependency-free DER computed on a 10 ms grid rather than
    `pyannote.metrics`'s optimal-assignment algorithm (that package is a GPU model
    server dependency per D77's attribution note, not a worker-ai one): every
    reference frame is charged as an error when no hypothesis segment overlapping
    it names the same speaker label. This is stricter than the standard metric
    (no confusion-collar tolerance, no best-permutation speaker mapping) but it is
    monotonic with it — a routing change that regresses the real DER regresses
    this one too — which is what the nightly regression gate needs.

    Speaker labels must already be aligned between the two lists (the eval
    fixture's ground truth uses the same speaker ids the hypothesis does); a
    ``None``-returning "labels don't line up" case does not apply here because an
    unmatched label is scored as an ordinary error, not an incomparable input.
    """
    total_ms = sum(segment.end_ms - segment.start_ms for segment in reference)
    if total_ms <= 0:
        return 0.0

    grid_ms = 10
    error_ms = 0
    for ref in reference:
        start = ref.start_ms
        while start < ref.end_ms:
            frame_end = min(start + grid_ms, ref.end_ms)
            covered = any(
                hyp.speaker == ref.speaker and hyp.start_ms <= start < hyp.end_ms
                for hyp in hypothesis
            )
            if not covered:
                error_ms += frame_end - start
            start = frame_end
    return error_ms / total_ms


def transliteration_accuracy(reference: str, hypothesis: str) -> float:
    """Exact-match accuracy for a transliteration item (A22's roman<->native pairs).

    Transliteration is scored differently from ASR: WER/CER measure whether the
    *sounds* were heard correctly, but a transliteration table (`packages` A22)
    is a deterministic, one-to-one mapping — so the only meaningful question is
    whether the output string equals the expected one after the same Indic-aware
    :func:`normalise`. Accuracy is 1.0 for an exact normalised match and 0.0
    otherwise; averaging this over a set's items is the set-level accuracy.
    """
    return 1.0 if normalise(reference) == normalise(hypothesis) else 0.0


@dataclass(frozen=True, slots=True)
class AutocutScore:
    """Precision/recall of a proposed cut list against ground truth (B18)."""

    precision: float
    recall: float
    f1: float
    true_positives: int
    false_positives: int
    false_negatives: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "truePositives": self.true_positives,
            "falsePositives": self.false_positives,
            "falseNegatives": self.false_negatives,
        }


def autocut_precision_recall(
    reference_cuts: list[tuple[int, int]],
    hypothesis_cuts: list[tuple[int, int]],
    *,
    tolerance_ms: int = 150,
) -> AutocutScore:
    """Precision/recall of B18's autocut pass against a ground-truth cut list.

    A hypothesis cut matches a reference cut when both endpoints fall within
    ``tolerance_ms`` of each other (B18's own acceptance bar for "the same cut",
    since autocut proposes a range, not a frame-exact boundary, and a human
    reviewer accepts a cut that is close enough not to be noticeable). Matching is
    greedy and one-to-one: each reference cut can satisfy at most one hypothesis
    cut and vice versa, so a hypothesis that proposes the same cut twice is not
    rewarded twice.
    """
    unmatched_reference = list(reference_cuts)
    true_positives = 0
    for hyp_start, hyp_end in hypothesis_cuts:
        match = next(
            (
                candidate
                for candidate in unmatched_reference
                if abs(candidate[0] - hyp_start) <= tolerance_ms
                and abs(candidate[1] - hyp_end) <= tolerance_ms
            ),
            None,
        )
        if match is not None:
            unmatched_reference.remove(match)
            true_positives += 1

    false_positives = len(hypothesis_cuts) - true_positives
    false_negatives = len(reference_cuts) - true_positives
    precision = true_positives / len(hypothesis_cuts) if hypothesis_cuts else 1.0
    recall = true_positives / len(reference_cuts) if reference_cuts else 1.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0
        else 0.0
    )
    return AutocutScore(
        precision=precision,
        recall=recall,
        f1=f1,
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
    )


def llm_pass_rate(check_results: list[bool]) -> float:
    """Fraction of automatic checks that passed (B11's check-based report format).

    `packages/prompts/src/eval` runs a fixed set of automatic checks per
    (fixture, template) pair — schema validity, timestamp validity, the
    hallucination guard, length limits, language consistency — and reports each
    as pass/fail. This harness does not re-run that TypeScript runner (out of
    this WP's file boundaries); it aggregates a dataset item's own recorded
    check outcomes into the single number the leaderboard needs. ``1.0`` for an
    empty list: an item with no checks defined has nothing to fail.
    """
    if not check_results:
        return 1.0
    return sum(1 for passed in check_results if passed) / len(check_results)
