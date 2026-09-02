"""Script projection for the aligners: Devanagari to Latin and back.

`09 §2` requires two projections and neither of them is a translation:

* **Roman-script Hinglish aligns on a Devanagari projection.** The IndicWav2Vec
  CTC heads were trained on Devanagari characters, so "matlab" has to reach the
  tokeniser as "मतलब" or every character falls out of the vocabulary and the word
  gets no timing at all.
* **MMS aligns on a romanised projection.** Meta's multilingual head uses a Latin
  vocabulary with a romanisation step in front of it, so Devanagari text has to
  go the other way.

Both directions are **rule tables, not models**. A model — IndicXlit, which A22
owns for the user-visible transliteration of `09 §4` — would be better at proper
nouns and at schwa deletion. It would also be a download, a licence and a second
inference pass inside an aligner whose entire job is to be cheaper than paying a
vendor for word timings. The rules below are wrong at the margins in ways that
cost a *character*, and a character is 20 ms of a CTC lattice that then re-aligns
around it; they are not wrong in ways that lose a word.

Anything with no rule passes through unchanged, so an unknown language degrades
to "the aligner reports itself unavailable and the next rung runs" rather than to
silent nonsense.
"""

from __future__ import annotations

import re

__all__ = [
    "DEVANAGARI_TO_LATIN",
    "LATIN_TO_DEVANAGARI",
    "romanise",
    "to_devanagari",
]

#: Longest-match-first digraphs and trigraphs, then single letters. Order is the
#: algorithm: "chh" must be tried before "ch", and "ch" before "c".
LATIN_TO_DEVANAGARI: tuple[tuple[str, str], ...] = (
    ("chh", "छ"), ("shh", "ष"), ("ksh", "क्ष"), ("gya", "ज्ञ"),
    ("aa", "ा"), ("ai", "ै"), ("au", "ौ"), ("ee", "ी"), ("oo", "ू"),
    ("bh", "भ"), ("ch", "च"), ("dh", "ध"), ("gh", "घ"), ("jh", "झ"),
    ("kh", "ख"), ("ph", "फ"), ("sh", "श"), ("th", "थ"), ("ng", "ङ"),
    ("ny", "ञ"), ("tr", "त्र"),
    ("a", "अ"), ("b", "ब"), ("c", "क"), ("d", "द"), ("e", "े"),
    ("f", "फ"), ("g", "ग"), ("h", "ह"), ("i", "ि"), ("j", "ज"),
    ("k", "क"), ("l", "ल"), ("m", "म"), ("n", "न"), ("o", "ो"),
    ("p", "प"), ("q", "क"), ("r", "र"), ("s", "स"), ("t", "ट"),
    ("u", "ु"), ("v", "व"), ("w", "व"), ("x", "क्स"), ("y", "य"),
    ("z", "ज"),
)

#: The reverse table for MMS. Vowel signs become their independent vowels,
#: because a Latin vocabulary has no notion of a matra.
DEVANAGARI_TO_LATIN: dict[str, str] = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo",
    "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
    "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo",
    "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
    "ं": "n", "ः": "h", "ँ": "n", "्": "", "़": "",  # noqa: RUF001 - Devanagari signs
}

_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_LATIN = re.compile(r"[A-Za-z]")

#: Languages whose romanised form the Latin table is built for. Hinglish and
#: Hindi share it; the other Devanagari languages (Marathi, Nepali) are close
#: enough that the round trip keeps the syllable count, which is what the CTC
#: lattice actually needs.
_DEVANAGARI_LANGUAGES = frozenset({"hi", "hi-en", "mr", "ne", "sa", "kok", "doi", "mai", "brx"})


def _base(language: str) -> str:
    cleaned = language.strip().casefold().replace("_", "-")
    return cleaned if cleaned == "hi-en" else cleaned.split("-")[0]


def to_devanagari(word: str, language: str) -> str:
    """Roman-script ``word`` as Devanagari; already-Devanagari text is untouched.

    Only applied for languages written in Devanagari — projecting a Tamil word
    onto Devanagari would be worse than leaving the aligner to report itself
    unavailable.
    """
    if not word or _base(language) not in _DEVANAGARI_LANGUAGES:
        return word
    if _DEVANAGARI.search(word):
        return word
    if not _LATIN.search(word):
        return word

    lowered = word.casefold()
    out: list[str] = []
    index = 0
    while index < len(lowered):
        for source, target in LATIN_TO_DEVANAGARI:
            if lowered.startswith(source, index):
                out.append(target)
                index += len(source)
                break
        else:
            index += 1
    return "".join(out)


def romanise(word: str) -> str:
    """Devanagari ``word`` as Latin; Latin text is lower-cased and returned.

    The MMS head's vocabulary is Latin, so this runs in front of it for every
    non-Latin script the table covers (`09 §2`).
    """
    if not word:
        return word
    if not _DEVANAGARI.search(word):
        return word.casefold()
    return "".join(DEVANAGARI_TO_LATIN.get(character, character) for character in word)
