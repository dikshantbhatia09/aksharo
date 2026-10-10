"""Translation: segment-preserving, length-aware, glossary-safe (`09 §4`, A22).

See ``service.py`` for the orchestration (provider chain, length-aware retry,
glossary masking); ``providers/`` for the Sarvam Mayura, IndicTrans2 and LLM
adapters behind :class:`~worker_ai.translate.providers.base.TranslationProvider`.
"""

from __future__ import annotations

from worker_ai.translate.length import MAX_LENGTH_RATIO
from worker_ai.translate.service import (
    MAX_LENGTH_RETRIES,
    AllProvidersFailedError,
    TranslatedSegmentOut,
    TranslateSegmentsResult,
    translate_segments,
)
from worker_ai.translate.timing import (
    CrossLingualWordTiming,
    allocate_cross_lingual_timing_ms,
    allocate_cross_lingual_timing_sec,
    compute_word_weight,
)

__all__ = [
    "MAX_LENGTH_RATIO",
    "MAX_LENGTH_RETRIES",
    "AllProvidersFailedError",
    "CrossLingualWordTiming",
    "TranslateSegmentsResult",
    "TranslatedSegmentOut",
    "allocate_cross_lingual_timing_ms",
    "allocate_cross_lingual_timing_sec",
    "compute_word_weight",
    "translate_segments",
]

