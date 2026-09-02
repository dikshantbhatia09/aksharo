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

__all__ = [
    "MAX_LENGTH_RATIO",
    "MAX_LENGTH_RETRIES",
    "AllProvidersFailedError",
    "TranslateSegmentsResult",
    "TranslatedSegmentOut",
    "translate_segments",
]
