"""WER and CER, and the normalisation they are measured after.

`09 §8` lists the metrics the regression harness gates on: WER/CER, code-switch
WER, alignment onset error, DER, filler precision/recall. A09 ships the first two
plus the onset error, which are the ones a transcript-only set can measure.

**Normalisation is part of the metric.** Comparing raw strings would score a
missing comma as a substituted word, so both sides are lower-cased, stripped of
punctuation and collapsed on whitespace before the edit distance is computed —
and Devanagari danda (``।``) counts as punctuation, which is the sort of thing a
Latin-only normaliser silently gets wrong.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

import jiwer

__all__ = [
    "TranscriptScore",
    "cer",
    "median_onset_error_ms",
    "normalise",
    "score",
    "wer",
]

#: Punctuation to drop, including the Devanagari danda and double danda.
_PUNCTUATION = re.compile(r"[^\w\sऀ-ॿ஀-௿]|[।॥]", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")


def normalise(text: str) -> str:
    """Case-folded, punctuation-free, single-spaced, NFC-normalised text."""
    folded = unicodedata.normalize("NFC", text).casefold()
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
