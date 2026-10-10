"""Tests for Romanized Hinglish dictionary, normalization, and tech slang preservation.

Verifies:
- Standardized common words ("karna", "hona", "bohot", "achha", "chahiye")
- Tech & creator terms preservation ("fundraise", "fundings", "subscribers", "jugaad", "dhandha")
- Bidirectional mapping between Devanagari and Romanized Hinglish
- Phonetic variant normalization
"""

from __future__ import annotations

import pytest

from worker_ai.transliterate.hinglish import (
    HINGLISH_DEVANAGARI_TO_ROMAN,
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


def test_standardized_common_words_presence() -> None:
    """Verifies the 5 key common words requested in the implementation plan."""
    assert "karna" in STANDARDIZED_COMMON_WORDS
    assert "hona" in STANDARDIZED_COMMON_WORDS
    assert "bohot" in STANDARDIZED_COMMON_WORDS
    assert "achha" in STANDARDIZED_COMMON_WORDS
    assert "chahiye" in STANDARDIZED_COMMON_WORDS

    assert STANDARDIZED_COMMON_WORDS["karna"] == "करना"
    assert STANDARDIZED_COMMON_WORDS["hona"] == "होना"
    assert STANDARDIZED_COMMON_WORDS["bohot"] == "बहुत"
    assert STANDARDIZED_COMMON_WORDS["achha"] == "अच्छा"
    assert STANDARDIZED_COMMON_WORDS["chahiye"] == "चाहिए"


@pytest.mark.parametrize(
    ("variant", "canonical"),
    [
        ("bahut", "bohot"),
        ("bhot", "bohot"),
        ("bht", "bohot"),
        ("accha", "achha"),
        ("acha", "achha"),
        ("krna", "karna"),
        ("honaa", "hona"),
        ("chaahiye", "chahiye"),
        ("chaiye", "chahiye"),
        ("nahin", "nahi"),
        ("nhi", "nahi"),
        ("thik", "theek"),
        ("jugad", "jugaad"),
        ("dhanda", "dhandha"),
        ("subs", "subscribers"),
        ("fund-raise", "fundraise"),
    ],
)
def test_phonetic_variant_normalization(variant: str, canonical: str) -> None:
    assert normalize_hinglish_word(variant) == canonical


@pytest.mark.parametrize(
    "tech_term",
    [
        "fundraise",
        "fundings",
        "subscribers",
        "jugaad",
        "dhandha",
        "architecture",
        "latency",
        "scalable",
        "optimize",
        "startup",
        "algorithm",
        "pipeline",
        "retention",
    ],
)
def test_tech_and_creator_slang_recognized(tech_term: str) -> None:
    assert is_tech_or_creator_term(tech_term) is True


def test_tech_terms_preserved_during_transliteration() -> None:
    """English tech terms must remain in Latin script to avoid phonetic corruption."""
    assert hinglish_to_devanagari("startup") == "startup"
    assert hinglish_to_devanagari("fundraise") == "fundraise"
    assert hinglish_to_devanagari("subscribers") == "subscribers"
    assert hinglish_to_devanagari("latency") == "latency"
    assert hinglish_to_devanagari("optimize") == "optimize"
    assert hinglish_to_devanagari("architecture") == "architecture"


def test_vernacular_words_transliterate_to_devanagari() -> None:
    assert hinglish_to_devanagari("karna") == "करना"
    assert hinglish_to_devanagari("hona") == "होना"
    assert hinglish_to_devanagari("bohot") == "बहुत"
    assert hinglish_to_devanagari("achha") == "अच्छा"
    assert hinglish_to_devanagari("chahiye") == "चाहिए"
    assert hinglish_to_devanagari("dosto") == "दोस्तों"


def test_devanagari_to_hinglish_canonical_mapping() -> None:
    assert devanagari_to_hinglish("करना") == "karna"
    assert devanagari_to_hinglish("होना") == "hona"
    assert devanagari_to_hinglish("बहुत") == "bohot"
    assert devanagari_to_hinglish("अच्छा") == "achha"
    assert devanagari_to_hinglish("चाहिए") == "chahiye"
    assert devanagari_to_hinglish("नमस्ते") == "namaste"


def test_standardize_hinglish_sentence() -> None:
    sentence = "Ye architecture bahut scalable hai, initial latency ko optimize krna chaahiye"
    standardized = standardize_hinglish_text(sentence)
    assert "bohot" in standardized
    assert "karna" in standardized
    assert "chahiye" in standardized
    assert "scalable" in standardized
    assert "latency" in standardized
    assert "optimize" in standardized
