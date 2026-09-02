"""English-word preservation for Hinglish transliteration (`09 §4`).

"Hinglish stays Roman-first with English words preserved": when a Hinglish
segment is transliterated into a native script (Devanagari, say), the Hindi
tokens become Devanagari and the English ones stay exactly as typed, in Latin
letters — "yeh video bahut interesting hai" becomes "यह वीडियो बहुत interesting
है", not a transliteration of "interesting" into Devanagari syllables that no
English speaker (or spellchecker) would recognise.

Two signals decide a token is English, either is enough:

1. **Dictionary.** A short, curated list of English words that show up
   constantly in Indian creator speech — "video", "channel", "subscribe",
   "interesting" — so the common case never depends on morphology guessing.
2. **Morphology.** An English inflectional suffix (`-ing`, `-tion`, `-ed`,
   `-ly`, `-er`, `-ness`) on an otherwise Latin-only token. This is deliberately
   coarse: it will occasionally keep a Hindi word Roman when a suffix happens to
   match (rare — Hindi does not share these suffixes), and that is the safe
   direction to be wrong in, because leaving a word in Roman is always legible;
   mis-transliterating it is not.

A token that is not purely Latin letters (already has Devanagari, digits-only,
punctuation-only) is never "English" by this module's definition — it has
nothing to preserve *from*.
"""

from __future__ import annotations

import re

__all__ = ["ENGLISH_MORPHOLOGY_SUFFIXES", "ENGLISH_WORDS", "is_english_token"]

#: Common English tokens in creator/Hinglish speech. Lower-case; matched
#: case-insensitively. Not exhaustive by design — the morphology check below
#: covers what the dictionary misses.
ENGLISH_WORDS: frozenset[str] = frozenset(
    {
        "video",
        "videos",
        "channel",
        "subscribe",
        "subscribers",
        "like",
        "comment",
        "comments",
        "share",
        "follow",
        "content",
        "creator",
        "creators",
        "interesting",
        "amazing",
        "awesome",
        "perfect",
        "update",
        "updates",
        "story",
        "stories",
        "live",
        "stream",
        "streaming",
        "the",
        "and",
        "for",
        "with",
        "app",
        "internet",
        "online",
        "phone",
        "mobile",
        "camera",
        "editing",
        "download",
        "upload",
        "playlist",
        "reel",
        "reels",
        "podcast",
        "episode",
        "guys",
        "hello",
        "hi",
        "bye",
        "welcome",
        "team",
        "brand",
        "product",
        "review",
    }
)

#: Suffixes strongly associated with English inflection/derivation.
ENGLISH_MORPHOLOGY_SUFFIXES: tuple[str, ...] = (
    "ing",
    "tion",
    "sion",
    "ness",
    "ment",
    "able",
    "ible",
    "ously",
    "edly",
    "ed",
    "ly",
    "er",
    "est",
)

_LATIN_ONLY = re.compile(r"^[A-Za-z][A-Za-z'\-]*$")

#: Below this length a suffix match is too likely to be coincidence
#: ("ho" is not "-o" + morphology; it needs the dictionary or nothing).
_MIN_MORPHOLOGY_LENGTH = 5


def is_english_token(token: str) -> bool:
    """True when `token` should stay in Roman script during transliteration.

    :param token: One word, punctuation and surrounding whitespace already
        stripped by the caller.
    """
    if not _LATIN_ONLY.match(token):
        return False
    lower = token.lower()
    if lower in ENGLISH_WORDS:
        return True
    if len(lower) < _MIN_MORPHOLOGY_LENGTH:
        return False
    return any(lower.endswith(suffix) for suffix in ENGLISH_MORPHOLOGY_SUFFIXES)
