"""Language tags: one spelling for a language, whatever a vendor calls it.

Three vendors, three conventions. ElevenLabs answers in ISO-639-3 (``hin``),
Sarvam in BCP-47 with a region (``hi-IN``), AssemblyAI and Whisper in ISO-639-1
(``hi``). The routing table (`09 §1`) is written in BCP-47 base tags with two
exceptions that matter to this product — ``en-IN`` for Indian English and
``hi-en`` for Hinglish — so every tag that crosses an adapter boundary is
normalised here and nowhere else.

The rule is deliberately conservative: **normalisation never invents a region.**
``hin`` becomes ``hi``, not ``hi-IN``; only a vendor that actually said ``IN``
keeps it. Inventing ``hi-IN`` would route Indian English audio into the Hindi
lane the moment a vendor started echoing regions.
"""

from __future__ import annotations

__all__ = [
    "CODE_MIX_TAGS",
    "INDIC_LANGUAGES",
    "base_tag",
    "is_code_mix_tag",
    "normalise_language",
    "same_language",
]

#: ISO-639-3 (and a few vendor spellings) to the ISO-639-1 tag the table uses.
#: Only languages the routing table can name are listed; anything else passes
#: through untouched, because a wrong guess is worse than an unknown tag.
_ALIASES: dict[str, str] = {
    # 22 scheduled languages of the Indian constitution (`09 §1`).
    "asm": "as",
    "ben": "bn",
    "bod": "brx",
    "brx": "brx",
    "doi": "doi",
    "guj": "gu",
    "hin": "hi",
    "kan": "kn",
    "kas": "ks",
    "kok": "kok",
    "mai": "mai",
    "mal": "ml",
    "mar": "mr",
    "mni": "mni",
    "nep": "ne",
    "ori": "or",
    "ory": "or",
    "pan": "pa",
    "san": "sa",
    "sat": "sat",
    "snd": "sd",
    "tam": "ta",
    "tel": "te",
    "urd": "ur",
    # Global languages that show up in the default lane.
    "ara": "ar",
    "deu": "de",
    "ger": "de",
    "eng": "en",
    "spa": "es",
    "fra": "fr",
    "fre": "fr",
    "ind": "id",
    "ita": "it",
    "jpn": "ja",
    "kor": "ko",
    "nld": "nl",
    "por": "pt",
    "rus": "ru",
    "tha": "th",
    "tur": "tr",
    "vie": "vi",
    "zho": "zh",
    "cmn": "zh",
    # Vendor spellings of the code-mix lane.
    "hinglish": "hi-en",
    "hi_en": "hi-en",
    "en-hi": "hi-en",
    "hi-en": "hi-en",
    "code-mixed": "hi-en",
    "codemix": "hi-en",
    # "unknown" is what Sarvam's auto-detect is asked for; it is not a language.
    "unknown": "",
    "und": "",
    "auto": "",
}

#: Every tag that means "Hindi-English code-mix" to some part of the system.
CODE_MIX_TAGS: frozenset[str] = frozenset({"hi-en", "hinglish", "hi_en", "en-hi"})

#: The Indic languages the routing table names, for the aligner registry's
#: coverage checks and for the ≤ 80 ms onset target of `09 §2`.
INDIC_LANGUAGES: frozenset[str] = frozenset(
    {
        "as",
        "bn",
        "brx",
        "doi",
        "gu",
        "hi",
        "kn",
        "kok",
        "ks",
        "mai",
        "ml",
        "mni",
        "mr",
        "ne",
        "or",
        "pa",
        "sa",
        "sat",
        "sd",
        "ta",
        "te",
        "ur",
    }
)


def normalise_language(tag: str | None) -> str:
    """A vendor's language tag as the routing table spells it.

    Returns ``""`` for anything that means "no answer" — an empty tag, ``und``,
    ``unknown`` — so a caller can test truthiness rather than three sentinels.
    """
    if not tag:
        return ""
    cleaned = tag.strip().replace("_", "-")
    if not cleaned:
        return ""
    folded = cleaned.casefold()
    aliased = _ALIASES.get(folded)
    if aliased is not None:
        return aliased
    parts = cleaned.split("-")
    language = _ALIASES.get(parts[0].casefold(), parts[0].casefold())
    if not language:
        return ""
    if len(parts) == 1:
        return language
    # Keep a region the vendor actually sent, upper-cased as BCP-47 wants.
    region = parts[1].upper()
    if len(region) != 2 or not region.isalpha():
        return language
    return language + "-" + region


def base_tag(tag: str | None) -> str:
    """The base subtag: ``ta-IN`` becomes ``ta``, ``hi-en`` stays ``hi-en``.

    The code-mix tag is not a language with a region, it is a lane, so it is the
    one tag that survives the split intact.
    """
    normalised = normalise_language(tag)
    if not normalised or normalised in CODE_MIX_TAGS:
        return normalised
    return normalised.split("-")[0]


def is_code_mix_tag(tag: str | None) -> bool:
    """True when ``tag`` names the Hindi-English code-mix lane."""
    return normalise_language(tag) in CODE_MIX_TAGS


def same_language(left: str | None, right: str | None) -> bool:
    """True when two tags name the same language, ignoring the region.

    This is the agreement test the two-signal LID rule of **D14** is built on, so
    "Whisper said ``hi`` and IndicLID said ``hi-IN``" counts as agreement while
    "``hi`` and ``hi-en``" does not — the code-mix lane has its own rule.
    """
    first, second = base_tag(left), base_tag(right)
    return bool(first) and first == second
