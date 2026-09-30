"""A workspace's track record, as a small lift on the moments like its best clips (2026-10-05).

The API sends ``options.performance`` once a workspace has enough measured
posts (``apps/api/src/repurpose/performance/steering-signal.ts``): the words
of its best clips (title, on-screen hook, a little of what was said), and -
when its numbers show a clear difference - the length band and the kind of
opening that did best. This turns that into a lift on each moment's potential:

- **like a hit** (:data:`HIT_LIFT` at most): the moment shares at least
  :data:`MIN_SHARED` content words with one of the best clips - words that are
  not everywhere in this video, since a word every moment of a finance podcast
  says ("money") tells its moments apart from nothing;
- **the length that did best** (:data:`LENGTH_LIFT`);
- **the opening that did best** (:data:`HOOK_LIFT`): a question, a number, the
  viewer addressed, or a plain statement, classified the way the API
  classifies its clips' hooks.

Bounded on purpose, in three ways. The lift is capped (:data:`MAX_LIFT`, five
points of potential): it breaks near-ties toward what worked, it cannot make a
weak moment beat a strong one. It is applied after every rule the person set -
the topic filter reads the model's topic fit, the bar (``minPotential``) reads
the potential without it, and windows only ever exist inside the person's
length band and outside the parts they skipped - so it changes which of the
moments they allowed come first, never which moments are allowed. And it is
named: a lifted moment carries a ``track_record`` reason saying which clip it
is like, or which length or opening it shares.

The best clips are deliberately NOT put in front of the language model: a
model shown past hits would score every similar moment higher on standing
alone and landing its point, by an amount no one could see or bound.
Deterministic: the same words and signal give the same lifts.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from worker_ai.highlights.contracts import PerformanceHit, PerformanceSignal

__all__ = [
    "HIT_LIFT",
    "HOOK_LIFT",
    "LENGTH_LIFT",
    "MAX_LIFT",
    "MIN_SHARED",
    "NO_LIFT",
    "OPENING_WORDS",
    "Lift",
    "TrackRecord",
    "hook_style",
    "keywords",
    "lift_for",
    "reason_for",
    "word_keyword",
]

#: The most a moment gains for being like one of the best clips.
HIT_LIFT: Final[float] = 0.04
#: What a moment gains for the length band that did best.
LENGTH_LIFT: Final[float] = 0.015
#: What a moment gains for opening the way the best clips opened.
HOOK_LIFT: Final[float] = 0.01
#: The most a moment gains in all: five points of potential.
MAX_LIFT: Final[float] = 0.05
#: Content words a moment must share with a clip to be "like" it.
MIN_SHARED: Final[int] = 2
#: A word in more than this share of the video's sentences is its subject, too
#: common to tell one moment from another. Counted over sentences, which do
#: not overlap - windows do, heavily, so one sentence is in many of them.
COMMON_SHARE: Final[float] = 0.25
#: Fewer sentences than this are too few to say what is common.
COMMON_MIN_SENTENCES: Final[int] = 8
#: How many of a moment's first words its opening is classified on.
OPENING_WORDS: Final[int] = 10
#: A reason, as the contract measures it.
_REASON_CHARS: Final[int] = 240

#: Words too common to say what a clip is about: English, Hinglish in Roman
#: letters and Hindi in Devanagari. Only words of four letters or more (three
#: in Devanagari) are kept at all, so shorter ones need not be listed.
STOPWORDS: Final[frozenset[str]] = frozenset(
    {
        # English
        "about", "actually", "after", "again", "also", "always", "another", "anything",
        "around", "because", "been", "before", "being", "come", "could", "didnt", "does",
        "doing", "done", "dont", "each", "even", "ever", "every", "from", "going", "gonna",
        "good", "have", "here", "into", "just", "kind", "know", "like", "little", "look",
        "lot", "make", "many", "maybe", "more", "most", "much", "need", "never", "okay",
        "only", "other", "over", "people", "really", "right", "said", "same", "say", "should",
        "some", "something", "still", "such", "sure", "take", "talk", "tell", "than", "that",
        "thats", "their", "them", "then", "there", "these", "they", "thing", "think", "this",
        "those", "time", "very", "want", "well", "were", "what", "when", "where", "which",
        "while", "will", "with", "would", "yeah", "your", "youre",
        # Hinglish (Roman)
        "aapka", "aapke", "aapki", "abhi", "agar", "apna", "apne", "apni", "bahut", "bhai",
        "bilkul", "dekho", "dekhiye", "gaya", "gaye", "gayi", "haan", "hain", "hota", "hote",
        "hoti", "iska", "iske", "iski", "jaise", "kaha", "kahan", "kaise", "karein", "karen",
        "karna", "karne", "karo", "karta", "karte", "karti", "kitna", "kitne", "kiya", "kuch",
        "kyun", "kyunki", "lekin",
        "matlab", "mera", "mere", "meri", "nahi", "nahin", "phir", "raha", "rahe", "rahi",
        "sabse", "sirf", "tera", "teri", "unka", "unke", "unki", "uska", "uske", "uski",
        "wahi", "waise", "wala", "wale", "wali", "yaar", "yahi",
        # Hindi (Devanagari)
        "नहीं", "लेकिन", "क्योंकि", "बहुत", "सबसे", "अपना", "अपने", "अपनी", "मेरा", "मेरी",
        "मेरे", "हैं", "रहा", "रही", "रहे", "गया", "गयी", "गए", "वाला", "वाली", "वाले",
        "कैसे", "क्यों", "कौन", "कहाँ", "कितना", "सिर्फ", "बिल्कुल", "फिर", "अभी", "जैसे",
        "अगर", "भाई", "यार", "देखो", "करना", "करते", "करता", "करती", "किया", "होता",
        "होती", "होते", "कुछ", "इसके", "उसके", "उनके", "आपके", "हमारे",
    }
)  # fmt: skip

#: Question words that open a question in English and Hinglish.
_QUESTION_OPENERS: Final[frozenset[str]] = frozenset(
    {
        "what", "why", "how", "who", "when", "where", "which", "is", "are", "do", "does",
        "did", "can", "could", "should", "would", "will", "have", "has",
        "kya", "kyu", "kyun", "kaise", "kab", "kaun", "kahan", "kitna", "kitne", "kitni",
        "क्या", "क्यों", "कैसे", "कब", "कौन", "कहाँ", "कितना",
    }
)  # fmt: skip
#: Words that speak to the viewer.
_YOU_WORDS: Final[frozenset[str]] = frozenset(
    {"you", "your", "youre", "yourself", "aap", "aapka", "aapke", "aapki", "tum", "tumhara",
     "tu", "tera", "आप", "आपका", "आपके", "तुम", "तुम्हारा"}
)  # fmt: skip
_NUMBER_WORDS: Final[frozenset[str]] = frozenset(
    {"one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
     "hundred", "thousand", "million", "lakh", "lakhs", "crore", "crores", "percent"}
)  # fmt: skip

_PLATFORM_LABELS: Final[dict[str, str]] = {
    "youtube": "YouTube",
    "instagram": "Instagram",
    "tiktok": "TikTok",
    "linkedin": "LinkedIn",
    "x": "X",
    "facebook": "Facebook",
    "threads": "Threads",
}
_HOOK_PHRASES: Final[dict[str, str]] = {
    "question": "opens with a question",
    "number": "opens with a number",
    "you": "speaks to the viewer from the start",
    "statement": "opens with a plain statement",
}


def _words(text: str) -> list[str]:
    """Runs of letters, marks and digits, case-folded: words in any script."""
    words: list[str] = []
    current: list[str] = []
    for char in unicodedata.normalize("NFC", text).casefold():
        if unicodedata.category(char)[0] in "LMN":
            current.append(char)
        elif current:
            words.append("".join(current))
            current = []
    if current:
        words.append("".join(current))
    return words


def _fold(word: str) -> str:
    """A plural read as its singular, for Latin words: ``savings`` is ``saving``."""
    if not word.isascii():
        return word
    if len(word) > 5 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def word_keyword(word: str) -> str | None:
    """A word as a content keyword, or ``None`` for one that says nothing on its own."""
    folded = _fold(word)
    if folded.isdigit():
        return None
    minimum = 4 if folded.isascii() else 3
    if len(folded) < minimum or folded in STOPWORDS or word in STOPWORDS:
        return None
    return folded


def keywords(text: str) -> frozenset[str]:
    """The content keywords of a text."""
    return frozenset(key for word in _words(text) if (key := word_keyword(word)) is not None)


def hook_style(text: str) -> str:
    """How a text opens: ``question``, ``number``, ``you`` or ``statement``.

    The same four the API reads its clips' hooks as. A question mark anywhere
    in the opening, or a question word first, is a question; then a figure or
    a number word; then the viewer addressed.
    """
    words = _words(text)[:OPENING_WORDS]
    opening = text.strip()
    if not words:
        return "statement"
    if "?" in opening[:160] or words[0] in _QUESTION_OPENERS:
        return "question"
    if any(word.isdigit() or word in _NUMBER_WORDS for word in words):
        return "number"
    if any(word in _YOU_WORDS for word in words):
        return "you"
    return "statement"


@dataclass(frozen=True, slots=True)
class _Hit:
    index: int
    hit: PerformanceHit
    keywords: frozenset[str]


@dataclass(frozen=True, slots=True)
class TrackRecord:
    """``options.performance``, ready to match moments against."""

    hits: tuple[_Hit, ...]
    length: tuple[int, int] | None
    length_posts: int
    hook: str | None
    hook_posts: int
    #: Words too common in this video to tell its moments apart.
    common: frozenset[str]

    @classmethod
    def of(
        cls, signal: PerformanceSignal, sentence_keywords: Sequence[frozenset[str]]
    ) -> TrackRecord:
        """The signal, and the video's sentences' keywords to find its common words in."""
        hits = tuple(
            _Hit(
                index=index,
                hit=hit,
                keywords=keywords(" ".join(filter(None, (hit.title, hit.hook, hit.excerpt)))),
            )
            for index, hit in enumerate(signal.hits)
        )
        counts: Counter[str] = Counter()
        for keys in sentence_keywords:
            counts.update(keys)
        total = len(sentence_keywords)
        common = (
            frozenset(key for key, count in counts.items() if count / total > COMMON_SHARE)
            if total >= COMMON_MIN_SENTENCES
            else frozenset[str]()
        )
        length = signal.length
        hook = signal.hook
        return cls(
            hits=hits,
            length=None if length is None else (length.min_ms, length.max_ms),
            length_posts=0 if length is None else length.posts,
            hook=None if hook is None else hook.style,
            hook_posts=0 if hook is None else hook.posts,
            common=common,
        )


@dataclass(frozen=True, slots=True)
class Lift:
    """What a moment gains from the track record, and why."""

    value: float
    hit: PerformanceHit | None = None
    shared: tuple[str, ...] = ()
    length: bool = False
    hook: bool = False


NO_LIFT: Final[Lift] = Lift(0.0)


def lift_for(
    record: TrackRecord, moment_keywords: frozenset[str], duration_ms: int, opening: str
) -> Lift:
    """The lift for one moment: its words, its length and how it opens."""
    best: _Hit | None = None
    best_shared: frozenset[str] = frozenset()
    usable = moment_keywords - record.common
    for entry in record.hits:
        shared = usable & entry.keywords
        # The first hit is the best one: a tie keeps it.
        if len(shared) >= MIN_SHARED and len(shared) > len(best_shared):
            best, best_shared = entry, shared
    value = 0.0
    if best is not None:
        # Two words shared are half the lift, four or more all of it.
        value += HIT_LIFT * min(1.0, len(best_shared) / 4)
    in_length = record.length is not None and record.length[0] <= duration_ms < record.length[1]
    if in_length:
        value += LENGTH_LIFT
    same_hook = record.hook is not None and hook_style(opening) == record.hook
    if same_hook:
        value += HOOK_LIFT
    if value <= 0:
        return NO_LIFT
    return Lift(
        value=min(MAX_LIFT, value),
        hit=None if best is None else best.hit,
        shared=tuple(sorted(best_shared))[:4],
        length=in_length,
        hook=same_hook,
    )


def _views(count: int) -> str:
    """``12.4k``, ``1.2M``: a count as a person says it."""
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}".rstrip("0").rstrip(".") + "M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}".rstrip("0").rstrip(".") + "k"
    return str(count)


def _seconds(ms: int) -> str:
    return f"{round(ms / 1000)} s"


def _fit(text: str) -> str:
    if len(text) <= _REASON_CHARS:
        return text
    return text[: _REASON_CHARS - 1].rstrip() + "…"


def reason_for(lift: Lift, record: TrackRecord) -> tuple[str, str] | None:
    """The ``track_record`` reason a lifted moment carries, or ``None``."""
    if lift.value <= 0:
        return None
    if lift.hit is not None:
        title = " ".join(lift.hit.title.split())
        if len(title) > 90:
            title = title[:89].rstrip() + "…"
        platform = _PLATFORM_LABELS.get(lift.hit.platform, lift.hit.platform)
        return (
            "track_record",
            _fit(
                f"Like your clip “{title}” ({_views(lift.hit.views)} views on "
                f"{platform}): {', '.join(lift.shared)}."
            ),
        )
    if lift.length and lift.hook and record.length is not None and record.hook is not None:
        return (
            "track_record",
            _fit(
                f"Your clips of {_seconds(record.length[0])} to {_seconds(record.length[1])} "
                f"that {_HOOK_PHRASES.get(record.hook, 'open this way')} have done best "
                f"({record.length_posts} and {record.hook_posts} posts)."
            ),
        )
    if lift.length and record.length is not None:
        return (
            "track_record",
            _fit(
                f"The length your clips do best at: {_seconds(record.length[0])} to "
                f"{_seconds(record.length[1])} ({record.length_posts} posts)."
            ),
        )
    if lift.hook and record.hook is not None:
        return (
            "track_record",
            _fit(
                f"It {_HOOK_PHRASES.get(record.hook, 'opens this way')}, like your clips "
                f"that did best ({record.hook_posts} posts)."
            ),
        )
    return None
