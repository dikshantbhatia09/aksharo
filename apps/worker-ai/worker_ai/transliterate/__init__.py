"""Transliteration: Roman <-> native script, per word (`09 §4`, A22).

See ``provider.py`` for the provider interface and the worker-local-vs-model-
server decision; ``tables.py`` for the rule tables; ``service.py`` for the
processor-facing orchestration.
"""

from __future__ import annotations

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
    "IndicXlitHttpProvider",
    "RuleTableTransliterationProvider",
    "TargetScript",
    "TransliterateWordsResult",
    "TransliteratedWord",
    "TransliterationProvider",
    "TransliterationRequest",
    "TransliterationResult",
    "transliterate_words",
]
