"""Transliteration: Roman <-> native script, per word (`09 §4`, A22).

See ``provider.py`` for the provider interface and the worker-local-vs-model-
server decision; ``tables.py`` for the rule tables; ``service.py`` for the
processor-facing orchestration.
"""

from __future__ import annotations

from worker_ai.transliterate.hinglish import (
    HINGLISH_DEVANAGARI_TO_ROMAN,
    HINGLISH_PHONETIC_VARIANTS,
    HINGLISH_ROMAN_TO_DEVANAGARI,
    STANDARDIZED_COMMON_WORDS,
    TECH_AND_CREATOR_TERMS,
    devanagari_to_hinglish,
    hinglish_to_devanagari,
    is_hinglish_word,
    is_tech_or_creator_term,
    normalize_hinglish_word,
    standardize_hinglish_text,
)
from worker_ai.transliterate.provider import (
    IndicXlitHttpProvider,
    RuleTableTransliterationProvider,
    TargetScript,
    TransliterationProvider,
    TransliterationRequest,
    TransliterationResult,
)
from worker_ai.transliterate.service import (
    TransliteratedWord,
    TransliterateWordsResult,
    transliterate_words,
)

__all__ = [
    "HINGLISH_DEVANAGARI_TO_ROMAN",
    "HINGLISH_PHONETIC_VARIANTS",
    "HINGLISH_ROMAN_TO_DEVANAGARI",
    "IndicXlitHttpProvider",
    "RuleTableTransliterationProvider",
    "STANDARDIZED_COMMON_WORDS",
    "TECH_AND_CREATOR_TERMS",
    "TargetScript",
    "TransliterateWordsResult",
    "TransliteratedWord",
    "TransliterationProvider",
    "TransliterationRequest",
    "TransliterationResult",
    "devanagari_to_hinglish",
    "hinglish_to_devanagari",
    "is_hinglish_word",
    "is_tech_or_creator_term",
    "normalize_hinglish_word",
    "standardize_hinglish_text",
    "transliterate_words",
]

