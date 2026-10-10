"""Bidirectional Romanized Hinglish <-> Devanagari Dictionary & Normalizer.

Part of Pillar 4: Multilingual Typography & Kinetic Captions
Functionality 03: Code-Mixed Indic Speech Engine (Hinglish/Tanglish Moat)

Provides:
1. Standardized Romanized Hinglish spellings for common vernacular words
   ("karna", "hona", "bohot", "achha", "chahiye", "jugaad", "dhandha").
2. Bidirectional mapping between Devanagari and standardized Romanized Hinglish.
3. Tech and creator slang dictionary ("fundraise", "fundings", "subscribers",
   "architecture", "latency", "optimize", "scalable", "monetization").
4. Phonetic normalization to map noisy speech/ASR variations to canonical spellings.
"""

from __future__ import annotations

import re
from typing import Final

__all__ = [
    "HINGLISH_DEVANAGARI_TO_ROMAN",
    "HINGLISH_PHONETIC_VARIANTS",
    "HINGLISH_ROMAN_TO_DEVANAGARI",
    "STANDARDIZED_COMMON_WORDS",
    "TECH_AND_CREATOR_TERMS",
    "devanagari_to_hinglish",
    "hinglish_to_devanagari",
    "is_hinglish_word",
    "is_tech_or_creator_term",
    "normalize_hinglish_word",
    "standardize_hinglish_text",
]

#: Standardized canonical Roman spellings for the core common Hindi/Hinglish verbs and adjectives.
STANDARDIZED_COMMON_WORDS: Final[dict[str, str]] = {
    # Standardizing "karna", "hona", "bohot", "achha", "chahiye" as per feature requirements
    "karna": "करना",
    "hona": "होना",
    "bohot": "बहुत",
    "achha": "अच्छा",
    "chahiye": "चाहिए",
    "karo": "करो",
    "karein": "करें",
    "karenge": "करेंगे",
    "karta": "करता",
    "karti": "करती",
    "karte": "करते",
    "hoga": "होगा",
    "hogi": "होगी",
    "honge": "होंगे",
    "hota": "होता",
    "hoti": "होती",
    "hote": "होते",
    "sakte": "सकते",
    "sakta": "सकता",
    "sakti": "सकती",
    "raha": "रहा",
    "rahe": "रहे",
    "rahi": "रही",
    "theek": "ठीक",
    "nahi": "नहीं",
    "haan": "हाँ",
    "kaise": "कैसे",
    "kyun": "क्यों",
    "kya": "क्या",
    "aaj": "आज",
    "hum": "हम",
    "baat": "बात",
    "aapke": "आपके",
    "aapka": "आपका",
    "aapki": "आपकी",
    "baare": "बारे",
    "mein": "में",
    "yeh": "यह",
    "woh": "वह",
    "dosto": "दोस्तों",
    "dost": "दोस्त",
    "bhai": "भाई",
    "yaar": "यार",
    "namaste": "नमस्ते",
    "dhanyavaad": "धन्यवाद",
    "shukriya": "शुक्रिया",
    "lekin": "लेकिन",
    "magar": "मगर",
    "samajh": "समझ",
    "zaroori": "ज़रूरी",
    "shuru": "शुरू",
    "khatam": "खत्म",
    "saath": "साथ",
    "paas": "पास",
    "pehle": "पहले",
    "baad": "बाद",
    "andar": "अंदर",
    "bahar": "बाहर",
    "upar": "ऊपर",
    "neeche": "नीचे",
    "aage": "आगे",
    "peeche": "पीछे",
    "aasan": "आसान",
    "mushkil": "मुश्किल",
    "zyada": "ज़्यादा",
    "kam": "कम",
    "poora": "पूरा",
    "aadha": "आधा",
    "sahi": "सही",
    "galat": "गलत",
    "naya": "नया",
    "purana": "पुराना",
    "bada": "बड़ा",
    "chhota": "छोटा",
    "jugaad": "जुगाड़",
    "dhandha": "धंधा",
    "paisa": "पैसा",
    "paise": "पैसे",
    "crore": "करोड़",
    "lakh": "लाख",
    "rupaye": "रुपये",
}

#: Phonetic variant spellings to canonical Romanized Hinglish spellings.
HINGLISH_PHONETIC_VARIANTS: Final[dict[str, str]] = {
    # bohot variations
    "bahut": "bohot",
    "bhot": "bohot",
    "bht": "bohot",
    "bohut": "bohot",
    # achha variations
    "accha": "achha",
    "acha": "achha",
    "achaa": "achha",
    "achchha": "achha",
    # karna variations
    "krna": "karna",
    "karnaa": "karna",
    # hona variations
    "honaa": "hona",
    # chahiye variations
    "chaahiye": "chahiye",
    "chahie": "chahiye",
    "chaiye": "chahiye",
    "chaie": "chahiye",
    # nahi variations
    "nahin": "nahi",
    "nhi": "nahi",
    "nahee": "nahi",
    # theek variations
    "thik": "theek",
    "thek": "theek",
    # kaise variations
    "kese": "kaise",
    "kayse": "kaise",
    # kyun variations
    "kyu": "kyun",
    "kyo": "kyun",
    "kyoon": "kyun",
    # kya variations
    "kyaa": "kya",
    # dosto variations
    "doston": "dosto",
    # jugaad variations
    "jugad": "jugaad",
    "jugaadh": "jugaad",
    # dhandha variations
    "dhanda": "dhandha",
    # subscribers / tech variants
    "subs": "subscribers",
    "sub": "subscriber",
    "subcriber": "subscriber",
    "subcribers": "subscribers",
    "fund-raise": "fundraise",
    "fund raising": "fundraise",
}

#: Indian Tech, Business & Creator Slang: MUST be preserved in Latin script in Romanized Hinglish
#: and not corrupted into broken phonetics.
TECH_AND_CREATOR_TERMS: Final[frozenset[str]] = frozenset(
    {
        "jugaad",
        "dhandha",
        "fundraise",
        "fundraising",
        "fundings",
        "funding",
        "subscribers",
        "subscriber",
        "startup",
        "startups",
        "views",
        "engagement",
        "reach",
        "algorithm",
        "content",
        "creator",
        "creators",
        "architecture",
        "latency",
        "scalable",
        "scalability",
        "optimize",
        "optimization",
        "pipeline",
        "backend",
        "frontend",
        "database",
        "server",
        "servers",
        "code",
        "coding",
        "developer",
        "developers",
        "production",
        "stack",
        "deploy",
        "deployment",
        "feature",
        "features",
        "bug",
        "bugs",
        "release",
        "releases",
        "commit",
        "framework",
        "performance",
        "founder",
        "founders",
        "co-founder",
        "cofounder",
        "investor",
        "investors",
        "pitch",
        "deck",
        "valuation",
        "equity",
        "revenue",
        "profit",
        "burn",
        "runway",
        "growth",
        "bootstrapped",
        "seed",
        "series",
        "round",
        "saas",
        "b2b",
        "b2c",
        "monetize",
        "monetization",
        "sponsorship",
        "sponsorships",
        "collab",
        "collaboration",
        "hook",
        "hooks",
        "retention",
        "editing",
        "cut",
        "transition",
        "b-roll",
        "broll",
        "audio",
        "mic",
        "vlog",
        "vlogger",
        "streamer",
        "thumbnail",
        "analytics",
        "metrics",
        "impressions",
        "ctr",
        "rpm",
        "cpm",
        "viral",
    }
)

#: Complete bidirectional Romanized Hinglish -> Devanagari dictionary.
HINGLISH_ROMAN_TO_DEVANAGARI: Final[dict[str, str]] = {
    **STANDARDIZED_COMMON_WORDS,
    # Additional conversational terms
    "toh": "तो",
    "bhi": "भी",
    "main": "मैं",
    "hoon": "हूँ",
    "aap": "आप",
    "tum": "तुम",
    "ab": "अब",
    "jab": "जब",
    "tab": "तब",
    "kab": "कब",
    "abhi": "अभी",
    "phir": "फिर",
    "milte": "मिलते",
    "dekho": "देखो",
    "suniye": "सुनिए",
    "bolo": "बोलो",
    "boliye": "बोलिए",
    "chalo": "चलो",
    "kripya": "कृपया",
    "ghar": "घर",
    "makan": "मकान",
    "kamra": "कमरा",
    "video": "वीडियो",
    "channel": "चैनल",
    "subscribe": "subscribe",
}

#: Reverse dictionary: Devanagari -> Standardized Romanized Hinglish.
#: Automatically constructed from HINGLISH_ROMAN_TO_DEVANAGARI, preferring canonical spellings.
HINGLISH_DEVANAGARI_TO_ROMAN: Final[dict[str, str]] = {
    native: roman
    for roman, native in HINGLISH_ROMAN_TO_DEVANAGARI.items()
    if native != roman
}
# Explicit canonical overrides for reverse mapping where multiple roman spellings exist
HINGLISH_DEVANAGARI_TO_ROMAN.update(
    {
        "बहुत": "bohot",
        "अच्छा": "achha",
        "करना": "karna",
        "होना": "hona",
        "चाहिए": "chahiye",
        "नहीं": "nahi",
        "ठीक": "theek",
        "जुगाड़": "jugaad",
        "धंधा": "dhandha",
        "धन्यवाद": "dhanyavaad",
    }
)


def normalize_hinglish_word(word: str) -> str:
    """Normalize a Hinglish token's phonetic spelling to the canonical standardized Roman spelling.

    Example: "bahut" -> "bohot", "accha" -> "achha", "krna" -> "karna"
    """
    clean = word.strip().lower()
    return HINGLISH_PHONETIC_VARIANTS.get(clean, clean)


def is_tech_or_creator_term(word: str) -> bool:
    """Check if a word is recognized as an Indian creator or tech slang term."""
    clean = word.strip().lower()
    return clean in TECH_AND_CREATOR_TERMS


def is_hinglish_word(word: str) -> bool:
    """Check if a word is in the Hinglish dictionary or recognized as creator/tech slang."""
    clean = normalize_hinglish_word(word)
    return (
        clean in HINGLISH_ROMAN_TO_DEVANAGARI
        or clean in TECH_AND_CREATOR_TERMS
        or clean in HINGLISH_DEVANAGARI_TO_ROMAN
    )


def hinglish_to_devanagari(word: str) -> str:
    """Convert a Romanized Hinglish word to Devanagari script.

    Tech terms ("startup", "fundraise", "latency") remain in Roman script to prevent
    phonetic corruption as per the Hinglish moat specification.
    """
    clean = word.strip()
    lower = normalize_hinglish_word(clean)
    if is_tech_or_creator_term(lower):
        return clean
    return HINGLISH_ROMAN_TO_DEVANAGARI.get(lower, clean)


def devanagari_to_hinglish(word: str) -> str:
    """Convert a Devanagari word to standardized Romanized Hinglish script."""
    clean = word.strip()
    return HINGLISH_DEVANAGARI_TO_ROMAN.get(clean, clean)


def standardize_hinglish_text(text: str) -> str:
    """Standardize phonetic variations in a Romanized Hinglish sentence to canonical spellings."""

    def _replace_token(match: re.Match[str]) -> str:
        token = match.group(0)
        norm = normalize_hinglish_word(token)
        if token.istitle():
            return norm.capitalize()
        if token.isupper():
            return norm.upper()
        return norm

    return re.sub(r"\b[A-Za-z]+\b", _replace_token, text)
