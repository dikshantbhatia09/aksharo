"""Word text for highlight discovery: sentence ends, lexicon matching, titles.

Everything here has to be script-agnostic. The product's main lane is Hindi and
Hinglish: Sarvam writes romanized Hinglish that ends its sentences with the
Devanagari danda (``।``), and local Whisper writes Devanagari with no
punctuation at all. The first version of this processor recognised only Latin
full stops, so a Hindi video had one "sentence", and it cleaned titles with an
ASCII-minded regex that turned ``नमस्ते`` into ``नमसत`` (vowel signs and the
virama are combining marks, which ``\\w`` does not match).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from typing import Final

__all__ = [
    "EXCERPT_MAX_CHARS",
    "TITLE_MAX_CHARS",
    "carries_break",
    "clean_word",
    "ends_clause",
    "ends_sentence",
    "ends_sentence_before",
    "is_exclamation",
    "is_latin_capitalised",
    "is_question",
    "is_speech",
    "make_excerpt",
    "make_title",
    "normalise",
]

#: Sentence-final marks: Latin, the ellipsis, the Devanagari danda and double
#: danda, and the Arabic question mark (Urdu speakers share the Hindi lane).
_SENTENCE_END_MARKS: Final = (".", "!", "?", "\u2026", "\u0964", "\u0965", "\u061f")
_QUESTION_MARKS: Final = ("?", "\u061f")
#: Where a speaker takes a breath inside a sentence.
_CLAUSE_MARKS: Final = (",", ";", ":", "\u2014", "\u2013", "\u060c")
#: Closing quotes and brackets that can follow the mark: `he said "no."`.
_CLOSERS: Final = "\"')]}\u201d\u2019\u00bb\u203a"
#: A full stop that is not the end of a sentence. `etc.` is left out on purpose:
#: it ends sentences far more often than it continues them, and so is `no.`,
#: which in speech is the reply; :func:`ends_sentence_before` reads "No. 5".
_ABBREVIATIONS: Final = frozenset(
    {"mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "vs.", "e.g.", "i.e.", "jr.", "sr."}
)
_INITIALS: Final = re.compile(r"^(?:[A-Za-z]\.){2,}$")  # U.S., A.I.

#: Zero-width joiner and non-joiner are format characters, but in Devanagari they
#: choose between a half form and a full one, so they are part of the word.
_JOINERS: Final = frozenset({"\u200c", "\u200d"})
#: Categories a title or excerpt never needs: controls, surrogates, private use,
#: unassigned, and pictographs/modifier symbols (emoji). Letters, combining marks,
#: digits, punctuation, currency and spaces all stay.
_DROPPED_CATEGORIES: Final = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "So", "Sk"})

TITLE_MAX_CHARS: Final[int] = 72
#: A title shorter than this many words keeps reading into the next sentence, so
#: "Yes." does not become a clip's name.
_TITLE_MIN_WORDS: Final[int] = 4
#: The contract allows 2,000; the ellipsis needs one of them.
EXCERPT_MAX_CHARS: Final[int] = 1_999

#: Words a title should not start on. Fillers, and connectives that only make
#: sense after the sentence the clip cut away. Compared after `normalise`.
_TITLE_LEAD_NOISE: Final = frozenset(
    {
        "um",
        "umm",
        "uh",
        "uhh",
        "uhm",
        "er",
        "erm",
        "ah",
        "hmm",
        "so",
        "and",
        "but",
        "okay",
        "ok",
        "well",
        "toh",
        "aur",
        "lekin",
        "तो",
        "और",
        "लेकिन",
    }
)
_TITLE_LEAD_NOISE_MAX: Final[int] = 3
_TITLE_TRAILING_STRIP: Final = " ,;:.\u2014\u2013-\u0964\u0965\u2026\u060c"


def _bare(text: str) -> str:
    """The word with trailing whitespace and closing quotes/brackets removed."""
    return text.rstrip().rstrip(_CLOSERS)


def ends_sentence(text: str) -> bool:
    """True when the word closes a sentence (``.``, ``!``, ``?``, ``…``, ``।``, ``॥``)."""
    bare = _bare(text)
    if not bare.endswith(_SENTENCE_END_MARKS):
        return False
    return not (bare.lower() in _ABBREVIATIONS or _INITIALS.match(bare))


def ends_sentence_before(text: str, following: str | None) -> bool:
    """:func:`ends_sentence`, knowing the next word: "No. 5" is a number, not a reply."""
    if not ends_sentence(text):
        return False
    if following is None or _bare(text).lower() != "no.":
        return True
    return not following.lstrip()[:1].isdigit()


def is_speech(text: str) -> bool:
    """True when the word is something said: it has a letter or a digit, in any script.

    Whisper times the notes it writes over music (``♪``, ``🎵``) and sound labels
    (``[Music]``) like words. Neither is speech, and a window of them is not a
    moment.
    """
    stripped = text.strip()
    if len(stripped) > 1 and stripped[0] == "[" and stripped[-1] == "]":
        return False
    return any(unicodedata.category(char)[0] in "LN" for char in stripped)


def carries_break(text: str) -> bool:
    """True when a token that is not speech still marks a sentence or clause end."""
    return ends_sentence(text) or ends_clause(text)


def ends_clause(text: str) -> bool:
    """True when the word closes a clause (a comma, semicolon, colon or dash)."""
    return _bare(text).endswith(_CLAUSE_MARKS)


def is_question(text: str) -> bool:
    # The last two characters, so "really?!" counts as a question too.
    tail = _bare(text)[-2:]
    return any(mark in tail for mark in _QUESTION_MARKS)


def is_exclamation(text: str) -> bool:
    return "!" in _bare(text)[-2:]


def normalise(text: str) -> str:
    """The comparable form of a word: NFC, lower case, straight apostrophe, no
    punctuation or symbols at either end.

    NFC matters for the Hindi lexicons: ``ज़`` arrives either precomposed or as
    ``ज`` plus a nukta, and only one of them would otherwise match.
    """
    folded = unicodedata.normalize("NFC", text).replace("\u2019", "'").lower()
    start, end = 0, len(folded)
    while start < end and unicodedata.category(folded[start])[0] in "PSZ":
        start += 1
    while end > start and unicodedata.category(folded[end - 1])[0] in "PSZ":
        end -= 1
    return folded[start:end]


def is_latin_capitalised(text: str) -> bool:
    """True when the word starts with an upper-case Latin letter.

    Devanagari has no case, so this is a named-entity hint for the Latin script
    only (English, and the romanized half of Hinglish).
    """
    for char in text:
        if char.isalpha():
            return char.isupper() and "LATIN" in unicodedata.name(char, "")
        if unicodedata.category(char)[0] not in "PS":
            return False
    return False


def clean_word(text: str) -> str:
    """The word as a person should read it: NFC, and nothing invisible or pictographic.

    Unlike the old ``re.sub(r"[^\\w\\s-]", ...)`` this keeps combining marks
    (Devanagari vowel signs, the virama, the nukta), apostrophes and ordinary
    punctuation, so ``करेंगे`` and ``we're`` survive intact.
    """
    kept = "".join(
        char
        for char in unicodedata.normalize("NFC", text)
        if char in _JOINERS or unicodedata.category(char) not in _DROPPED_CATEGORIES
    )
    return " ".join(kept.split())


def _cut_at_word_boundary(words: Sequence[str], limit: int) -> tuple[str, bool]:
    """Join words while they fit in ``limit`` characters; say whether any were left out."""
    kept: list[str] = []
    length = 0
    for word in words:
        added = len(word) + (1 if kept else 0)
        if length + added > limit:
            break
        kept.append(word)
        length += added
    if kept:
        return " ".join(kept), len(kept) < len(words)
    # A single word longer than the limit: cut it, but never between a letter and
    # the combining marks that belong to it.
    first = words[0]
    cut = limit
    while cut > 0 and unicodedata.category(first[cut])[0] == "M":
        cut -= 1
    return first[:cut], True


def make_title(texts: Sequence[str], *, fallback: str) -> str:
    """A title from the window's opening words, in the speaker's own script.

    Reads up to the first sentence end (further if that sentence is under
    four words), trims at a word boundary to :data:`TITLE_MAX_CHARS`, and
    capitalises only a lower-case Latin first letter. No ``str.title()``: it
    turned "AI" into "Ai" and every word of a sentence into a Proper Noun.
    """
    words = [cleaned for text in texts if (cleaned := clean_word(text))]
    lead = 0
    while (
        lead < min(_TITLE_LEAD_NOISE_MAX, len(words) - 1)
        and normalise(words[lead]) in _TITLE_LEAD_NOISE
    ):
        lead += 1
    words = words[lead:]

    picked: list[str] = []
    for index, word in enumerate(words):
        picked.append(word)
        following = words[index + 1] if index + 1 < len(words) else None
        if ends_sentence_before(word, following) and len(picked) >= _TITLE_MIN_WORDS:
            break
        if sum(len(w) + 1 for w in picked) > TITLE_MAX_CHARS:
            break

    if not picked:
        return fallback
    title, trimmed = _cut_at_word_boundary(picked, TITLE_MAX_CHARS - 1)
    # A trailing full stop or comma reads as a fragment in a title; a question
    # mark or exclamation mark is part of what was said, so it stays.
    title = title.rstrip(_TITLE_TRAILING_STRIP)
    if not title:
        return fallback
    if trimmed:
        title += "\u2026"
    first = title[0]
    if first.islower() and "LATIN" in unicodedata.name(first, ""):
        title = first.upper() + title[1:]
    return title


def make_excerpt(texts: Sequence[str]) -> str:
    """The window's words, cleaned, cut at a word boundary to fit the contract."""
    words = [cleaned for text in texts if (cleaned := clean_word(text))]
    if not words:
        return ""
    excerpt, trimmed = _cut_at_word_boundary(words, EXCERPT_MAX_CHARS)
    return excerpt + "\u2026" if trimmed else excerpt
