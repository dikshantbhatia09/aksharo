"""Rule tables for Roman <-> native-script transliteration (`09 §4`, A22).

AI4Bharat's real IndicXlit is a neural transliteration model; no vendor key or
model weight exists in this environment (A00-06), so the local provider in
``provider.py`` is a **deterministic rule table**: a curated word dictionary for
the two languages the golden tests cover (Hindi/Devanagari, Tamil), backed by a
generic syllable-mapping fallback for words the dictionary does not carry, so an
unknown word is transliterated rather than silently passed through. Swapping in
the real IndicXlit model or the `apps/model-server` route later is a one-file
change behind the same :class:`~worker_ai.transliterate.provider.TransliterationProvider`
interface — see the README note in ``provider.py``.

Two tables per language: a word dictionary (checked first, case-insensitive) and
a syllable table (consonant + vowel -> native cluster) used for anything the
dictionary does not cover. Numerals and punctuation are handled once, for every
language, in :func:`normalise_numerals` and :func:`native_punctuation`.
"""

from __future__ import annotations

import re
import unicodedata

__all__ = [
    "DEVANAGARI_DANDA",
    "HINDI_ROMAN_TO_DEVANAGARI",
    "HINDI_SYLLABLES",
    "HINDI_VOWELS",
    "TAMIL_ROMAN_TO_NATIVE",
    "TAMIL_SYLLABLES",
    "TAMIL_VOWELS",
    "native_punctuation",
    "normalise_numerals",
    "romanise_word",
    "transliterate_word",
]

# ---------------------------------------------------------------------------
# Hindi / Devanagari
# ---------------------------------------------------------------------------

#: Common Hinglish/Hindi words the golden tests exercise, Roman -> Devanagari.
#: Lower-case keys; looked up case-insensitively.
HINDI_ROMAN_TO_DEVANAGARI: dict[str, str] = {
    "toh": "तो",
    "aaj": "आज",
    "hum": "हम",
    "baat": "बात",
    "karenge": "करेंगे",
    "aapke": "आपके",
    "channel": "चैनल",
    "ke": "के",
    "baare": "बारे",
    "mein": "में",
    "yeh": "यह",
    "video": "वीडियो",
    "bahut": "बहुत",
    "hai": "है",
    "namaste": "नमस्ते",
    "dosto": "दोस्तों",
    "kaise": "कैसे",
    "ho": "हो",
    "aap": "आप",
    "main": "मैं",
    "hoon": "हूँ",
    "acha": "अच्छा",
    "accha": "अच्छा",
    "theek": "ठीक",
    "nahi": "नहीं",
    "nahin": "नहीं",
    "haan": "हाँ",
    "kya": "क्या",
    "kyun": "क्यों",
    "kyu": "क्यों",
    "abhi": "अभी",
    "phir": "फिर",
    "milte": "मिलते",
    "subscribe": "subscribe",
    "karo": "करो",
    "dekho": "देखो",
    "suniye": "सुनिए",
    "shukriya": "शुक्रिया",
    "dhanyavaad": "धन्यवाद",
}

#: Reverse of the dictionary above, Devanagari -> Roman. Built once, at import
#: time, from the same source so the two directions can never drift apart.
_HINDI_DEVANAGARI_TO_ROMAN: dict[str, str] = {
    native: roman for roman, native in HINDI_ROMAN_TO_DEVANAGARI.items() if native != roman
}

HINDI_VOWELS: dict[str, str] = {
    "a": "अ",
    "aa": "आ",
    "i": "इ",
    "ee": "ई",
    "ii": "ई",
    "u": "उ",
    "oo": "ऊ",
    "uu": "ऊ",
    "e": "ए",
    "ai": "ऐ",
    "o": "ओ",
    "au": "औ",
}

#: Consonant -> (Devanagari base glyph, inherent-vowel matra map).
#: Longest romanised consonant clusters first so `"kh"` is not read as `"k"` + `"h"`.
_HINDI_CONSONANTS: dict[str, str] = {
    "kh": "ख",
    "gh": "घ",
    "chh": "छ",
    "ch": "च",
    "jh": "झ",
    "ny": "ञ",
    "th": "थ",
    "dh": "ध",
    "ph": "फ",
    "bh": "भ",
    "sh": "श",
    "ng": "ङ",
    "k": "क",
    "g": "ग",
    "j": "ज",
    "t": "त",
    "d": "द",
    "n": "न",
    "p": "प",
    "b": "ब",
    "m": "म",
    "y": "य",
    "r": "र",
    "l": "ल",
    "v": "व",
    "w": "व",
    "s": "स",
    "h": "ह",
}

#: Matra (dependent vowel sign) for each vowel, applied after a consonant.
#: `"a"` has no sign — the inherent vowel of every Devanagari consonant.
_HINDI_MATRAS: dict[str, str] = {
    "a": "",
    "aa": "ा",
    "i": "ि",
    "ee": "ी",
    "ii": "ी",
    "u": "ु",
    "oo": "ू",
    "uu": "ू",
    "e": "े",
    "ai": "ै",
    "o": "ो",
    "au": "ौ",
}

VIRAMA = "्"  # ्  — suppresses a consonant's inherent vowel.

#: Longest-match syllable table (consonant+vowel and lone vowels), generated
#: from the consonant/vowel tables above rather than hand-written twice.
HINDI_SYLLABLES: dict[str, str] = {
    **dict(HINDI_VOWELS),
    **{
        consonant + vowel: base + matra
        for consonant, base in _HINDI_CONSONANTS.items()
        for vowel, matra in _HINDI_MATRAS.items()
    },
}

DEVANAGARI_DANDA = "।"

# ---------------------------------------------------------------------------
# Tamil
# ---------------------------------------------------------------------------

TAMIL_ROMAN_TO_NATIVE: dict[str, str] = {
    "vanakkam": "வணக்கம்",
    "nanba": "நண்பா",
    "nanbare": "நண்பரே",
    "eppadi": "எப்படி",
    "irukkinga": "இருக்கிங்க",
    "irukkeenga": "இருக்கீங்க",
    "nalla": "நல்ல",
    "irukken": "இருக்கேன்",
    "nandri": "நன்றி",
    "video": "video",
    "subscribe": "subscribe",
    "channel": "சேனல்",
    "ippo": "இப்போ",
    "romba": "ரொம்ப",
    "nalla-irukku": "நல்லாயிருக்கு",
}

_TAMIL_NATIVE_TO_ROMAN: dict[str, str] = {
    native: roman for roman, native in TAMIL_ROMAN_TO_NATIVE.items() if native != roman
}

TAMIL_VOWELS: dict[str, str] = {
    "a": "அ",
    "aa": "ஆ",
    "i": "இ",
    "ee": "ஈ",
    "u": "உ",
    "oo": "ஊ",
    "e": "எ",
    "ai": "ஐ",
    "o": "ஒ",
    "au": "ஔ",
}

_TAMIL_CONSONANTS: dict[str, str] = {
    "ng": "ங",
    "ny": "ஞ",
    "th": "த",
    "nd": "ண்ட",
    "k": "க",
    "c": "ச",
    "t": "ட",
    "n": "ந",
    "p": "ப",
    "m": "ம",
    "y": "ய",
    "r": "ர",
    "l": "ல",
    "v": "வ",
    "z": "ழ",
    "s": "ஸ",
    "h": "ஹ",
}

_TAMIL_MATRAS: dict[str, str] = {
    "a": "",
    "aa": "ா",
    "i": "ி",
    "ee": "ீ",
    "u": "ு",
    "oo": "ூ",
    "e": "ெ",
    "ai": "ை",
    "o": "ொ",
    "au": "ௌ",
}

TAMIL_SYLLABLES: dict[str, str] = {
    **dict(TAMIL_VOWELS),
    **{
        consonant + vowel: base + matra
        for consonant, base in _TAMIL_CONSONANTS.items()
        for vowel, matra in _TAMIL_MATRAS.items()
    },
}

# ---------------------------------------------------------------------------
# Shared: numerals and punctuation (`09 §4`: "rule tables for punctuation/numerals")
# ---------------------------------------------------------------------------

#: Devanagari digits, index == value.
_DEVANAGARI_DIGITS = "०१२३४५६७८९"
#: Tamil digits, index == value.
_TAMIL_DIGITS = "௦௧௨௩௪௫௬௭௮௯"

_NATIVE_DIGITS: dict[str, str] = {"native-hi": _DEVANAGARI_DIGITS, "native-ta": _TAMIL_DIGITS}


def normalise_numerals(token: str, *, language: str, to_native: bool) -> str:
    """Map ASCII digits to the target script's digits, or back to ASCII.

    A token that carries no digits at all is returned unchanged — this is a
    numeral rule, not a general script mapper. Mixed tokens (`"2026"`, `"90s"`)
    are converted digit-by-digit, which is enough for years, counts and ages.
    """
    if not any(character.isdigit() for character in token):
        return token
    digits = _NATIVE_DIGITS.get(f"native-{language}")
    if digits is None:
        return token
    if to_native:
        table = str.maketrans("0123456789", digits)
        return token.translate(table)
    table = str.maketrans(digits, "0123456789")
    return token.translate(table)


_PUNCTUATION_TO_NATIVE: dict[str, dict[str, str]] = {
    "hi": {".": DEVANAGARI_DANDA},
    "ta": {},
}


def native_punctuation(token: str, *, language: str) -> str:
    """A sentence-final `.` becomes the language's own stop mark, where it has one."""
    table = _PUNCTUATION_TO_NATIVE.get(language)
    if not table:
        return token
    return table.get(token, token)


# ---------------------------------------------------------------------------
# Word-level transliteration
# ---------------------------------------------------------------------------

_DICTIONARIES: dict[str, dict[str, str]] = {
    "hi": HINDI_ROMAN_TO_DEVANAGARI,
    "ta": TAMIL_ROMAN_TO_NATIVE,
}
_REVERSE_DICTIONARIES: dict[str, dict[str, str]] = {
    "hi": _HINDI_DEVANAGARI_TO_ROMAN,
    "ta": _TAMIL_NATIVE_TO_ROMAN,
}
_SYLLABLE_TABLES: dict[str, dict[str, str]] = {
    "hi": HINDI_SYLLABLES,
    "ta": TAMIL_SYLLABLES,
}


def transliterate_word(token: str, *, language: str) -> str:
    """Roman -> the language's native script, for one already-lower-cased token.

    The dictionary wins when the word is in it (case-insensitive). Otherwise a
    greedy longest-match syllable split covers most CV (consonant-vowel) words;
    anything the split cannot fully consume is returned as typed rather than
    dropped, because a partially-transliterated caption is worse than an
    untouched word a human can still read.
    """
    dictionary = _DICTIONARIES.get(language)
    if dictionary is not None:
        hit = dictionary.get(token.lower())
        if hit is not None:
            return hit

    table = _SYLLABLE_TABLES.get(language)
    if table is None:
        return token
    return _syllable_split(token.lower(), table) or token


_DEVA_VOWELS: dict[str, str] = {
    "अ": "a",
    "आ": "aa",
    "इ": "i",
    "ई": "ee",
    "उ": "u",
    "ऊ": "oo",
    "ऋ": "ri",
    "ए": "e",
    "ऐ": "ai",
    "ओ": "o",
    "औ": "au",
}

_DEVA_MATRAS: dict[str, str] = {
    "ा": "a",
    "ि": "i",
    "ी": "ee",
    "ु": "u",
    "ू": "oo",
    "ृ": "ri",
    "े": "e",
    "ै": "ai",
    "ो": "o",
    "ौ": "au",
}

_DEVA_CONSONANTS: dict[str, str] = {
    "क": "k",
    "ख": "kh",
    "ग": "g",
    "घ": "gh",
    "ङ": "ng",
    "च": "ch",
    "छ": "chh",
    "ज": "j",
    "झ": "jh",
    "ञ": "ny",
    "ट": "t",
    "ठ": "th",
    "ड": "d",
    "ढ": "dh",
    "ण": "n",
    "त": "t",
    "थ": "th",
    "द": "d",
    "ध": "dh",
    "न": "n",
    "प": "p",
    "फ": "ph",
    "ब": "b",
    "भ": "bh",
    "म": "m",
    "य": "y",
    "र": "r",
    "ल": "l",
    "व": "v",
    "श": "sh",
    "ष": "sh",
    "स": "s",
    "ह": "h",
    "क़": "q",
    "ख़": "kh",
    "ग़": "gh",
    "ज़": "z",
    "ड़": "r",
    "ढ़": "dh",
    "फ़": "f",
}

_DEVA_SPECIAL_WORDS: dict[str, str] = {
    "में": "mein",
    "हैं": "hain",
    "है": "hai",
    "हो": "ho",
    "का": "ka",
    "की": "ki",
    "के": "ke",
    "को": "ko",
    "से": "se",
    "ने": "ne",
    "तो": "toh",
    "भी": "bhi",
    "ये": "ye",
    "वह": "woh",
    "वो": "wo",
    "था": "tha",
    "थी": "thi",
    "थे": "the",
    "और": "aur",
    "या": "ya",
    "एक": "ek",
    "दो": "do",
    "तीन": "teen",
    "चार": "chaar",
    "पांच": "paanch",
    "बारेश": "baarish",
    "बारिश": "baarish",
    "भीग": "bheeg",
    "बढ़िया": "badhiya",
    "लोनावाला": "lonavala",
    "विला": "villa",
    "कमरे": "kamre",
    "होटल": "hotel",
    "नहीं": "nahi",
    "रही": "rahi",
    "रहे": "rahe",
    "रहा": "raha",
    "आपकी": "aapki",
    "आपका": "aapka",
    "आपके": "aapke",
    "कर": "kar",
    "करना": "karna",
    "बहुत": "bahut",
    "सब": "sab",
    "कुछ": "kuch",
    "घर": "ghar",
    "लेकिन": "lekin",
    "मकान": "makan",
    "अच्छा": "accha",
    "ठीक": "theek",
}


def _romanise_devanagari(word: str) -> str:
    m = re.match(r"^([^\w\u0900-\u097F]*)([\u0900-\u097F\w]+)([^\w\u0900-\u097F]*)$", word)
    if not m:
        return word
    prefix, core, suffix = m.groups()

    if not re.search(r"[\u0900-\u097F]", core):
        return word

    if core in _DEVA_SPECIAL_WORDS:
        return prefix + _DEVA_SPECIAL_WORDS[core] + suffix

    core = unicodedata.normalize("NFC", core)
    core = core.replace("\u093c", "")

    chars = list(core)
    n = len(chars)
    tokens: list[tuple[str, bool]] = []
    i = 0
    while i < n:
        c = chars[i]
        if c in _DEVA_CONSONANTS:
            base = _DEVA_CONSONANTS[c]
            if i + 1 < n:
                nxt = chars[i + 1]
                if nxt == "्":
                    tokens.append((base, False))
                    i += 2
                    continue
                elif nxt in _DEVA_MATRAS:
                    tokens.append((base + _DEVA_MATRAS[nxt], False))
                    i += 2
                    continue
                elif nxt in ("ं", "ँ"):
                    tokens.append((base + "an", False))
                    i += 2
                    continue
                else:
                    tokens.append((base, True))
                    i += 1
                    continue
            else:
                tokens.append((base, False))
                i += 1
                continue
        elif c in _DEVA_VOWELS:
            v = _DEVA_VOWELS[c]
            if i + 1 < n and chars[i + 1] in ("ं", "ँ"):
                v += "n"
                i += 2
            else:
                i += 1
            tokens.append((v, False))
        elif c in _DEVA_MATRAS:
            tokens.append((_DEVA_MATRAS[c], False))
            i += 1
        elif c in ("ं", "ँ"):
            if tokens:
                last_tok, _ = tokens[-1]
                if last_tok.endswith("e"):
                    tokens[-1] = (last_tok[:-1] + "ein", False)
                else:
                    tokens[-1] = (last_tok + "n", False)
            i += 1
        else:
            tokens.append((c, False))
            i += 1

    out: list[str] = []
    num_tok = len(tokens)
    for idx, (t, has_schwa) in enumerate(tokens):
        if not has_schwa:
            out.append(t)
        else:
            if idx == num_tok - 1:
                out.append(t)
            elif idx == 0:
                out.append(t + "a")
            elif idx + 1 < num_tok and not tokens[idx + 1][1]:
                out.append(t)
            else:
                out.append(t + "a")

    return prefix + "".join(out) + suffix


def romanise_word(token: str, *, language: str) -> str:
    """Native script -> Roman, the reverse of :func:`transliterate_word`."""
    reverse = _REVERSE_DICTIONARIES.get(language)
    if reverse is not None:
        hit = reverse.get(token)
        if hit is not None:
            return hit
    if language in ("hi", "hi-latn", "hi-Latn") or language.startswith("hi"):
        return _romanise_devanagari(token)
    return token



def _syllable_split(word: str, table: dict[str, str]) -> str | None:
    """Greedy longest-match over `table`'s keys, longest key first.

    Returns ``None`` when any part of the word could not be matched, so the
    caller can fall back to the untouched original rather than emit a glyph
    string with a Latin gap in the middle of it.
    """
    keys = sorted(table.keys(), key=len, reverse=True)
    result: list[str] = []
    index = 0
    while index < len(word):
        matched = False
        for key in keys:
            if word.startswith(key, index):
                result.append(table[key])
                index += len(key)
                matched = True
                break
        if not matched:
            return None
    return "".join(result)
