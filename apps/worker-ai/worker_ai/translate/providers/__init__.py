"""Translation provider adapters: Sarvam Mayura, IndicTrans2, LLM (`09 §4`)."""

from __future__ import annotations

from worker_ai.translate.providers.base import (
    TranslatedSegment,
    TranslationProvider,
    TranslationRequest,
    TranslationResult,
    TranslationSegment,
)
from worker_ai.translate.providers.indictrans2 import IndicTrans2Provider
from worker_ai.translate.providers.llm import LLMTranslateProvider
from worker_ai.translate.providers.sarvam_mayura import SarvamMayuraProvider

__all__ = [
    "IndicTrans2Provider",
    "LLMTranslateProvider",
    "SarvamMayuraProvider",
    "TranslatedSegment",
    "TranslationProvider",
    "TranslationRequest",
    "TranslationResult",
    "TranslationSegment",
]
