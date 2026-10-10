"""Cross-Lingual Word Timing Allocator & Token Interpolation (Pillar 4 §09).

Given an original sentence clause duration T = end - start and translated sentence
consisting of words w_1, w_2, ..., w_m:
1. Weights each translated word by character count and punctuation pause bonus:
   weight(w_i) = len(w_i_stripped) + bonus(punctuation)
2. Calculates proportional word duration:
   Delta t_i = T * (weight(w_i) / sum(weights))
3. Allocates cumulative timestamps:
   t_start(w_i) = t_start + sum_{k=1}^{i-1} Delta t_k,  t_end(w_i) = t_start(w_i) + Delta t_i
4. Enforces strict boundary clamping so t_end(w_m) == end exactly (zero drift).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

__all__ = [
    "CrossLingualWordTiming",
    "allocate_cross_lingual_timing_ms",
    "allocate_cross_lingual_timing_sec",
    "compute_word_weight",
]

_PUNCT_STRIP_RE = re.compile(r"""[.,\/#!$%\^&\*;:{}=\-_`~()?"'–—«»""'']""")
_SENTENCE_TERMINAL_RE = re.compile(r"""[.?!।॥]$""")
_CLAUSE_PAUSE_RE = re.compile(r"""[,;:—–]$""")


def compute_word_weight(token: str) -> float:
    """Computes phonetic & token duration weight for a word token.

    Base weight is character length of the stripped token (minimum 1.0).
    Adds punctuation pause bonuses:
    - Sentence terminals (. ? ! । ॥): +2.0
    - Clause pauses (, ; : — –): +1.0
    """
    stripped = _PUNCT_STRIP_RE.sub("", token)
    base_len = max(1, len(stripped))
    bonus = 0.0
    if _SENTENCE_TERMINAL_RE.search(token):
        bonus = 2.0
    elif _CLAUSE_PAUSE_RE.search(token):
        bonus = 1.0
    return float(base_len) + bonus


@dataclass(frozen=True, slots=True)
class CrossLingualWordTiming:
    """Aligned word timing token in milliseconds and seconds."""

    text: str
    start_ms: int
    end_ms: int
    confidence: float = 1.0

    @property
    def start_sec(self) -> float:
        return self.start_ms / 1000.0

    @property
    def end_sec(self) -> float:
        return self.end_ms / 1000.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "startSec": round(self.start_sec, 3),
            "endSec": round(self.end_sec, 3),
            "confidence": self.confidence,
        }


def allocate_cross_lingual_timing_ms(
    translated_text: str,
    start_ms: int,
    end_ms: int,
) -> list[CrossLingualWordTiming]:
    """Allocates millisecond word timestamps across translated text tokens."""
    tokens = [t for t in translated_text.strip().split() if t]
    if not tokens:
        return []

    if start_ms > end_ms:
        end_ms = start_ms

    total_duration = end_ms - start_ms
    if total_duration <= 0 or len(tokens) == 0:
        return [
            CrossLingualWordTiming(text=t, start_ms=start_ms, end_ms=start_ms)
            for t in tokens
        ]

    weights = [compute_word_weight(t) for t in tokens]
    total_weight = sum(weights) or 1.0

    result: list[CrossLingualWordTiming] = []
    current_ms = start_ms

    for i, token in enumerate(tokens):
        if i == len(tokens) - 1:
            w_end_ms = end_ms
        else:
            w_duration = int(round(total_duration * (weights[i] / total_weight)))
            w_end_ms = min(end_ms, current_ms + max(1, w_duration))

        w_start_ms = min(current_ms, w_end_ms)
        result.append(CrossLingualWordTiming(text=token, start_ms=w_start_ms, end_ms=w_end_ms))
        current_ms = w_end_ms

    return result


def allocate_cross_lingual_timing_sec(
    translated_text: str,
    start_sec: float,
    end_sec: float,
) -> list[CrossLingualWordTiming]:
    """Allocates second-based timestamps, clamped strictly to [start_sec, end_sec]."""
    start_ms = int(round(start_sec * 1000))
    end_ms = int(round(end_sec * 1000))
    return allocate_cross_lingual_timing_ms(translated_text, start_ms, end_ms)

