"""Content signals for a highlight window, and the score they add up to.

The first version scored every window with constants (emotion 78, novelty 82,
...) and a hook bonus for any substring of "how" - so "show" and "however"
counted - which put "Potential 80%" on every candidate of every video. Every
number here is measured from the window's own words, lands in 0-1, and is
explained in the candidate's reasons.

What is measured, and why it predicts a clip that works on its own:

- **complete sentences at both ends** - a clip that starts mid-thought loses the
  viewer in the first second, and one that stops mid-thought feels broken;
- **pauses around it** - a natural breath before and after is where a cut
  sounds intended. The very start and end of the transcript have nothing to
  measure, so they score as the transcript's typical cut, not a perfect one:
  scored as perfect, they beat every internal window of a Sarvam transcript
  (no silence between words) and put the channel intro and outro first;
- **speech density and few fillers** - dead air and "um" are what people swipe on;
- **a strong opener or an early question** - the hook, in English, Hinglish and
  Hindi;
- **numbers and capitalised (Latin-script) names** - specifics make a moment
  concrete and quotable;
- **emphatic and opinion words, exclamations** - conviction reads as energy.

Visual activity and safety are not measured by this heuristic (the payload
carries no face or frame features yet), so they are reported as fixed neutral
values and take no part in the potential score.
"""

from __future__ import annotations

import math
import statistics
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import accumulate
from typing import Final, Literal

from worker_ai.highlights.acoustic import (
    HIGH_VARIANCE_PITCH_STD_HZ,
    MONOTONE_PITCH_STD_HZ,
    SPIKE_THRESHOLD_DB,
    AcousticFeatures,
    WindowAcousticFeatures,
    ensure_acoustic_features,
)
from worker_ai.highlights.text import (
    ends_clause,
    is_exclamation,
    is_latin_capitalised,
    is_question,
    normalise,
)
from worker_ai.highlights.windows import PAUSE_MS, Unit, Word, sentence_ends

__all__ = [
    "HOOK_WINDOW_MS",
    "PAUSE_MS",
    "AcousticFeatures",
    "ContentGoal",
    "HookWindowAnalysis",
    "Reason",
    "Score",
    "ViralityBreakdown",
    "ViralityTier",
    "WindowAcousticFeatures",
    "WindowSignals",
    "WordFeatures",
    "acoustic_emotion_score",
    "acoustic_energy_and_penalty",
    "reasons_for",
    "score",
    "virality_index",
    "virality_tier",
]

ContentGoal = Literal["reach", "education", "authority", "engagement"]
ViralityTier = Literal["VIRAL_GOLD", "HIGH_POTENTIAL", "MODERATE", "STANDARD"]

#: Duration of the critical opening hook window (Pillar 2 §01).
HOOK_WINDOW_MS: Final[int] = 3_500

#: How far into a window the hook has to land.
_OPENING_WORDS: Final[int] = 8
_OPENING_MS: Final[int] = 8_000

#: Reported for the two dimensions this heuristic cannot see. Neutral, and
#: excluded from the potential score.
_UNMEASURED_VISUAL: Final[int] = 50
_UNMEASURED_SAFETY: Final[int] = 100


def _nfc(words: set[str]) -> frozenset[str]:
    return frozenset(unicodedata.normalize("NFC", word) for word in words)


FILLERS: Final = _nfc(
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
        "hm",
        "mm",
        "mhm",
        "अं",
        "उम्म",
        "हम्म",
    }
)

EMPHATIC: Final = _nfc(
    {
        # English: conviction, stakes, extremes, opinion.
        "never",
        "always",
        "best",
        "worst",
        "biggest",
        "must",
        "actually",
        "honestly",
        "seriously",
        "literally",
        "truth",
        "secret",
        "mistake",
        "mistakes",
        "wrong",
        "important",
        "crucial",
        "incredible",
        "amazing",
        "insane",
        "crazy",
        "shocking",
        "huge",
        "massive",
        "love",
        "hate",
        "believe",
        "problem",
        "dangerous",
        "surprising",
        "unbelievable",
        "everyone",
        "nobody",
        "everything",
        "nothing",
        "exactly",
        "absolutely",
        "definitely",
        "completely",
        # Hinglish, romanized as Sarvam writes it.
        "sabse",
        "bahut",
        "bohot",
        "zaroor",
        "jaroor",
        "zaruri",
        "jaruri",
        "kabhi",
        "galti",
        "galat",
        "sach",
        "sachchai",
        "asli",
        "ekdum",
        "bilkul",
        "khatarnak",
        "khatarnaak",
        "zabardast",
        "jabardast",
        "kamaal",
        "kamal",
        "pakka",
        "hamesha",
        "dhyan",
        # Hindi, in Devanagari as local Whisper writes it.
        "सबसे",
        "बहुत",
        "ज़रूर",
        "जरूर",
        "ज़रूरी",
        "जरूरी",
        "कभी",
        "गलती",
        "ग़लती",
        "गलत",
        "ग़लत",
        "सच",
        "सच्चाई",
        "असली",
        "एकदम",
        "बिल्कुल",
        "बिलकुल",
        "खतरनाक",
        "ख़तरनाक",
        "ज़बरदस्त",
        "जबरदस्त",
        "कमाल",
        "पक्का",
        "हमेशा",
        "ध्यान",
    }
)

#: Magnitudes spoken as words. Digits (any script) are caught by category.
NUMBER_WORDS: Final = _nfc(
    {
        "hundred",
        "thousand",
        "million",
        "billion",
        "trillion",
        "percent",
        "dozen",
        "twice",
        "double",
        "triple",
        "half",
        "lakh",
        "lakhs",
        "crore",
        "crores",
        "hazaar",
        "hazar",
        "sau",
        "सौ",
        "हज़ार",
        "हजार",
        "लाख",
        "करोड़",
        "प्रतिशत",
    }
)

#: Words that do not make a capitalised word a name.
_NOT_ENTITIES: Final = frozenset({"i", "i'm", "i've", "i'll", "i'd", "ok", "okay"})

#: Openers that promise something, as normalised token sequences. Matched on
#: whole tokens: the old substring test found "how" inside "show".
HOOK_OPENERS: Final[tuple[tuple[str, ...], ...]] = tuple(
    tuple(unicodedata.normalize("NFC", token) for token in phrase.split())
    for phrase in (
        "did you know",
        "what if",
        "here's",
        "here is",
        "imagine",
        "the secret",
        "the truth",
        "the problem",
        "the reason",
        "the biggest",
        "the best",
        "the worst",
        "the thing is",
        "this is why",
        "this is how",
        "let me tell you",
        "most people",
        "nobody",
        "no one",
        "everyone",
        "stop",
        "listen",
        "why",
        "how",
        "never",
        "you won't believe",
        "you need to",
        "kya aap",
        "kya aapko",
        "kya aapne",
        "socho",
        "sochiye",
        "suno",
        "suniye",
        "dekho",
        "dekhiye",
        "sabse",
        "asli",
        "sach",
        "yaad rakho",
        "yaad rakhiye",
        "kyun",
        "kyon",
        "kaise",
        "have you ever",
        "do you know",
        "do you think",
        "can you believe",
        "the real reason",
        "if you want",
        "if you think",
        "the one thing",
        "one thing",
        "before you",
        "watch this",
        "check this out",
        "have you noticed",
        "wait until",
        "kya aapko pata",
        "kya aap jaante",
        "ek baat",
        "agar aap",
        "sach yeh hai",
        "क्या आप",
        "क्या आपको",
        "क्या आपने",
        "सोचो",
        "सोचिए",
        "सुनो",
        "सुनिए",
        "देखो",
        "देखिए",
        "सबसे",
        "असली",
        "सच",
        "याद रखो",
        "याद रखिए",
        "क्यों",
        "कैसे",
    )
)
#: Connectives skipped before matching an opener: "So, here's the thing".
_OPENER_SKIP: Final = frozenset({"so", "and", "but", "okay", "ok", "now", "well", "toh", "तो"})

#: Sentence openings that start with an orphan pronoun or continuation marker without antecedent context.
_ORPHAN_PRONOUNS: Final = (
    ("it", "also"),
    ("they", "also"),
    ("he", "also"),
    ("she", "also"),
    ("it", "s", "also"),
    ("its", "also"),
    ("here", "s", "its"),
    ("heres", "its"),
    ("here", "s", "their"),
    ("heres", "their"),
    ("here", "s", "another"),
    ("heres", "another"),
    ("here", "s", "an"),
    ("heres", "an"),
    ("here", "s", "how"),
    ("heres", "how"),
    ("it", "turns", "out"),
    ("it", "basically"),
    ("it", "is", "able"),
    ("it", "can"),
    ("it", "needs"),
    ("they", "have"),
    ("they", "released"),
    ("they", "used"),
    ("he", "fed"),
    ("this", "is", "a", "bit"),
    ("still", "a", "few"),
    ("still", "another"),
    ("apparently", "they"),
    ("apparently", "it"),
    ("if", "you", "look"),
    ("if", "you", "scroll"),
    ("as", "you", "can"),
    ("and", "as", "you"),
    ("and", "then", "here"),
    ("now", "here", "s"),
    ("now", "heres"),
)

QUESTION_WORDS: Final = _nfc(
    {
        "why",
        "how",
        "what",
        "who",
        "when",
        "which",
        "where",
        "can",
        "could",
        "would",
        "should",
        "do",
        "does",
        "did",
        "have",
        "has",
        "had",
        "is",
        "are",
        "kya",
        "kyun",
        "kyon",
        "kaise",
        "kab",
        "kahan",
        "kaun",
        "kisko",
        "kisne",
        "क्या",
        "क्यों",
        "कैसे",
        "कब",
        "कहाँ",
        "कौन",
    }
)

CURIOSITY_WORDS: Final = _nfc(
    {
        "secret",
        "secrets",
        "truth",
        "problem",
        "reason",
        "mystery",
        "nobody",
        "revealed",
        "formula",
        "hack",
        "hacks",
        "trick",
        "tricks",
        "hidden",
        "why",
        "how",
        "imagine",
        "mistake",
        "mistakes",
        "danger",
        "warning",
        "ruin",
        "destroy",
        "magic",
        "lie",
        "lies",
        "raaz",
        "sach",
        "sachchai",
        "galti",
        "dhokha",
        "farzi",
        "asli",
    }
)

CONTRARIAN_WORDS: Final = _nfc(
    {
        "never",
        "stop",
        "worst",
        "mistake",
        "mistakes",
        "wrong",
        "dangerous",
        "insane",
        "crazy",
        "shocking",
        "hate",
        "impossible",
        "ruin",
        "destroy",
        "scam",
        "trapped",
        "toxic",
        "fake",
        "terrible",
        "lies",
        "myth",
        "fail",
        "failed",
        "warning",
        "galti",
        "galat",
        "khatarnak",
        "sabse",
        "mat",
        "kabhi",
    }
)

TREND_KEYWORDS: Final = _nfc(
    {
        # AI & Tech
        "ai",
        "gpt",
        "chatgpt",
        "deepseek",
        "llm",
        "claude",
        "agent",
        "agents",
        "automation",
        "algorithm",
        "software",
        "tech",
        "coding",
        "robot",
        "nvidia",
        "apple",
        "google",
        "meta",
        "openai",
        "machine",
        "intelligence",
        # Wealth & Business
        "money",
        "rich",
        "wealth",
        "wealthy",
        "income",
        "crore",
        "crores",
        "lakh",
        "lakhs",
        "million",
        "billion",
        "dollar",
        "dollars",
        "rupee",
        "rupees",
        "business",
        "startup",
        "profit",
        "sales",
        "revenue",
        "invest",
        "investing",
        "crypto",
        "bitcoin",
        "salary",
        "cash",
        "paisa",
        "paise",
        "crorepati",
        "ameer",
        "kamao",
        "kamai",
        "dhandha",
        "naukri",
        # Productivity & Mindset
        "productivity",
        "habit",
        "habits",
        "discipline",
        "focus",
        "dopamine",
        "mindset",
        "success",
        "successful",
        "brain",
        "routine",
        "burnout",
        "sleep",
        "biohack",
        "goal",
        "goals",
        "safalta",
        "kamyabi",
        "dimaag",
        "aadat",
        # Controversy & Insights
        "secret",
        "secrets",
        "truth",
        "scam",
        "trap",
        "cheat",
        "hacks",
        "hack",
        "mistake",
        "mistakes",
        "danger",
        "dangerous",
        "warning",
        "banned",
        "illegal",
        "hidden",
        "conspiracy",
        "exposed",
        "lie",
        "lies",
        "raaz",
        "sach",
    }
)

TRAILING_CONJUNCTIONS: Final = _nfc(
    {
        "and",
        "but",
        "so",
        "or",
        "because",
        "like",
        "if",
        "though",
        "although",
        "aur",
        "lekin",
        "kyunki",
        "ya",
        "toh",
        "par",
        "magar",
        "ki",
        "then",
        "also",
        "plus",
    }
)

TRAILING_PHRASES: Final = (
    ("and", "so"),
    ("but", "anyway"),
    ("and", "then"),
    ("which", "means"),
    ("so", "yeah"),
    ("aur", "phir"),
    ("toh", "basically"),
)

FILLER_OPENING_PHRASES: Final = (
    ("so", "basically"),
    ("um", "yeah"),
    ("uh", "yeah"),
    ("like", "i", "said"),
    ("as", "i", "was", "saying"),
    ("as", "i", "said"),
    ("you", "know", "what", "i", "mean"),
    ("you", "know"),
    ("so", "yeah"),
    ("well", "so"),
    ("toh", "basically"),
    ("matlab", "basically"),
)


@dataclass(frozen=True, slots=True)
class HookWindowAnalysis:
    """Isolated 0-3.5 second hook window evaluation (Pillar 2 §01)."""

    words: list[str]
    duration_ms: int
    curiosity_gap: float  # 0-1
    contrarian_score: float  # 0-1
    hook_energy_ratio: float  # 0-1
    has_filler_opening: bool
    s_hook: float  # 0-30


@dataclass(frozen=True, slots=True)
class ViralityBreakdown:
    """Multi-modal 5-component universal virality formulation (0-100)."""

    hook: float  # 0-30
    narrative: float  # 0-25
    energy: float  # 0-20
    trend: float  # 0-15
    pacing: float  # 0-10
    total: int  # 0-100
    tier: ViralityTier  # VIRAL_GOLD, HIGH_POTENTIAL, MODERATE, STANDARD


#: Weights per `contentGoal`. Each row sums to 1. `question` is not a breakdown
#: dimension (the contract has none for it), but it is what `engagement` asks for.
_WEIGHTS: Final[dict[str, dict[str, float]]] = {
    "reach": {
        "standalone": 0.25,
        "hook": 0.25,
        "clarity": 0.15,
        "emotion": 0.15,
        "novelty": 0.10,
        "question": 0.10,
    },
    "education": {
        "standalone": 0.25,
        "hook": 0.10,
        "clarity": 0.25,
        "emotion": 0.05,
        "novelty": 0.25,
        "question": 0.10,
    },
    "authority": {
        "standalone": 0.25,
        "hook": 0.10,
        "clarity": 0.20,
        "emotion": 0.10,
        "novelty": 0.30,
        "question": 0.05,
    },
    "engagement": {
        "standalone": 0.20,
        "hook": 0.20,
        "clarity": 0.10,
        "emotion": 0.20,
        "novelty": 0.10,
        "question": 0.20,
    },
}


def _unit(value: float) -> float:
    return max(0.0, min(1.0, value))


def _prefix(flags: Sequence[bool | int]) -> list[int]:
    return [0, *accumulate(int(flag) for flag in flags)]


class WordFeatures:
    """Per-word facts, computed once, summed per window in O(1).

    A three-hour transcript has tens of thousands of words and several thousand
    candidate windows, so a window's counts come from prefix sums rather than a
    fresh pass over its words.

    ``units`` are the places a window can be cut (:func:`build_units`). The
    cuts between them set what the start and end of the transcript score: the
    median of the real ones, so an edge is neither better nor worse than a
    typical cut. Without units, an edge is scored halfway.
    """

    def __init__(self, words: Sequence[Word], units: Sequence[Unit] = ()) -> None:
        self.words = words
        self.norm = [normalise(word.text) for word in words]
        self.sentence_end = sentence_ends(words)
        self.clause_end = [ends_clause(word.text) for word in words]
        self.question = [is_question(word.text) for word in words]
        self.exclamation = [is_exclamation(word.text) for word in words]
        self.filler = [token in FILLERS for token in self.norm]
        self.emphatic = [token in EMPHATIC for token in self.norm]
        self.number = [
            token in NUMBER_WORDS or any(unicodedata.category(char) == "Nd" for char in token)
            for token in self.norm
        ]
        self.entity = [
            index > 0
            and not self.sentence_end[index - 1]
            and is_latin_capitalised(word.text)
            and self.norm[index] not in _NOT_ENTITIES
            for index, word in enumerate(words)
        ]
        self._questions = _prefix(self.question)
        self._exclamations = _prefix(self.exclamation)
        self._fillers = _prefix(self.filler)
        self._emphatic = _prefix(self.emphatic)
        self._numbers = _prefix(self.number)
        self._entities = _prefix(self.entity)
        self._speech_ms = _prefix([max(0, word.end_ms - word.start_ms) for word in words])
        self.trend = [token in TREND_KEYWORDS for token in self.norm]
        self._trend = _prefix(self.trend)
        self._pauses_over_1s = _prefix(
            [self._gap_after(i) > 1000 for i in range(len(words) - 1)] + ([False] if words else [])
        )
        self._openers: dict[tuple[int, int], str | None] = {}

        inner = [unit.last for unit in units[:-1]]
        self._edge_cut = statistics.median(map(self.cut_after, inner)) if inner else 0.5
        self._edge_pause = (
            statistics.median(_pause_quality(self._gap_after(i)) for i in inner) if inner else 0.5
        )

    def _gap_after(self, index: int) -> int:
        """Silence after word ``index``, which is not the last."""
        return max(0, self.words[index + 1].start_ms - self.words[index].end_ms)

    def cut_after(self, index: int) -> float:
        """How clean a cut after word ``index`` (not the last) is.

        1 at a sentence end, 0.5 at a breath or a comma, 0 mid-phrase.
        """
        if self.sentence_end[index]:
            return 1.0
        if self._gap_after(index) >= PAUSE_MS or self.clause_end[index]:
            return 0.5
        return 0.0

    def opening(self, first: int) -> float:
        """How clean the cut in before word ``first`` is: see :meth:`cut_after`."""
        base = self._edge_cut if first == 0 else self.cut_after(first - 1)
        if self._has_orphan_pronoun(first):
            return base * 0.2
        return base

    def _has_orphan_pronoun(self, first: int) -> bool:
        stop = min(first + 6, len(self.norm))
        tokens = self.norm[first:stop]
        skipped = 0
        while skipped < 2 and skipped < len(tokens) and tokens[skipped] in _OPENER_SKIP:
            skipped += 1
        tokens = tokens[skipped:]
        for phrase in _ORPHAN_PRONOUNS:
            if len(tokens) >= len(phrase) and tuple(tokens[: len(phrase)]) == phrase:
                return True
        return False

    def closing(self, last: int) -> float:
        """How clean the cut out after word ``last`` is.

        The transcript's last word is a sentence end if it says so itself, and
        the typical cut otherwise.
        """
        if last < len(self.words) - 1:
            return self.cut_after(last)
        return 1.0 if self.sentence_end[last] else self._edge_cut

    def pause_before(self, first: int) -> float:
        return self._edge_pause if first == 0 else _pause_quality(self._gap_after(first - 1))

    def pause_after(self, last: int) -> float:
        if last == len(self.words) - 1:
            return self._edge_pause
        return _pause_quality(self._gap_after(last))

    def trailing_conjunction(self, last: int) -> bool:
        """True if the window ends on a dangling conjunction or fragment transition."""
        if last < 0 or last >= len(self.norm):
            return False
        if self.norm[last] in TRAILING_CONJUNCTIONS:
            return True
        if last >= 1:
            phrase = (self.norm[last - 1], self.norm[last])
            if phrase in TRAILING_PHRASES:
                return True
        return False

    def hook_analysis(self, first: int, last: int, start_ms: int) -> HookWindowAnalysis:
        """Evaluate the isolated 0-3.5s opening hook window (Pillar 2 §01)."""
        hook_end = first
        while hook_end < last and self.words[hook_end + 1].start_ms - start_ms <= HOOK_WINDOW_MS:
            hook_end += 1

        hook_tokens = self.norm[first : hook_end + 1]
        hook_words = [self.words[i].text for i in range(first, hook_end + 1)]
        hook_duration_ms = max(1, self.words[hook_end].end_ms - start_ms)

        has_filler = False
        if self.norm[first] in FILLERS or self._has_orphan_pronoun(first):
            has_filler = True
        else:
            for phrase in FILLER_OPENING_PHRASES:
                if len(hook_tokens) >= len(phrase) and tuple(hook_tokens[: len(phrase)]) == phrase:
                    has_filler = True
                    break

        opener = self.opener(first, last)
        starts_q = self.question[first] or self.norm[first] in QUESTION_WORDS
        has_q = any(
            self.question[i] or self.norm[i] in QUESTION_WORDS for i in range(first, hook_end + 1)
        )
        curiosity_tokens = sum(1 for t in hook_tokens if t in CURIOSITY_WORDS)

        c_score = 0.0
        if opener is not None:
            c_score += 0.55
        if starts_q:
            c_score += 0.45
        elif has_q:
            c_score += 0.35
        if curiosity_tokens > 0:
            c_score += min(0.35, curiosity_tokens * 0.2)
        curiosity_gap = max(0.0, min(1.0, c_score))

        contrarian_tokens = sum(1 for t in hook_tokens if t in CONTRARIAN_WORDS)
        has_num = any(self.number[i] for i in range(first, hook_end + 1))
        has_excl = any(self.exclamation[i] for i in range(first, hook_end + 1))

        k_score = 0.0
        if contrarian_tokens > 0:
            k_score += min(0.6, contrarian_tokens * 0.35)
        if has_num:
            k_score += 0.35
        if has_excl:
            k_score += 0.2
        contrarian_score = max(0.0, min(1.0, k_score))

        hook_speech_ms = sum(
            max(0, self.words[i].end_ms - self.words[i].start_ms)
            for i in range(first, hook_end + 1)
        )
        speech_density = hook_speech_ms / hook_duration_ms
        hook_emphatic = any(self.emphatic[i] for i in range(first, hook_end + 1))

        e_score = 0.5 * min(1.0, speech_density / 0.75) + (
            0.5 if (hook_emphatic or has_excl) else 0.2
        )
        hook_energy_ratio = max(0.0, min(1.0, e_score))

        s_hook = 15.0 * curiosity_gap + 10.0 * contrarian_score + 5.0 * hook_energy_ratio
        if has_filler:
            s_hook *= 0.2
        s_hook = max(0.0, min(30.0, s_hook))

        return HookWindowAnalysis(
            words=hook_words,
            duration_ms=hook_duration_ms,
            curiosity_gap=round(curiosity_gap, 3),
            contrarian_score=round(contrarian_score, 3),
            hook_energy_ratio=round(hook_energy_ratio, 3),
            has_filler_opening=has_filler,
            s_hook=round(s_hook, 2),
        )

    def opener(self, first: int, last: int) -> str | None:
        """The hook phrase words ``first..last`` open with, if any."""
        if self._has_orphan_pronoun(first):
            return None
        # Only the opening words matter, and every window from the same start
        # shares them: a long transcript asks this thousands of times.
        stop = min(first + _OPENING_WORDS, last + 1)
        key = (first, stop)
        if key not in self._openers:
            self._openers[key] = self._match_opener(self.norm[first:stop])
        return self._openers[key]

    @staticmethod
    def _match_opener(tokens: Sequence[str]) -> str | None:
        skipped = 0
        while skipped < 2 and skipped < len(tokens) and tokens[skipped] in _OPENER_SKIP:
            skipped += 1
        tokens = tokens[skipped:]
        for phrase in HOOK_OPENERS:
            if tuple(tokens[: len(phrase)]) == phrase:
                return " ".join(phrase)
        return None

    def signals(self, first: int, last: int, start_ms: int, end_ms: int) -> WindowSignals:
        """Everything the score needs about words ``first..last`` cut at ``start_ms..end_ms``."""
        stop = last + 1

        opening_end = first
        while (
            opening_end < last
            and opening_end - first < _OPENING_WORDS - 1
            and not self.sentence_end[opening_end]
            and self.words[opening_end + 1].start_ms - start_ms <= _OPENING_MS
        ):
            opening_end += 1
        opening = range(first, opening_end + 1)
        has_orphan = self._has_orphan_pronoun(first)

        hook_an = self.hook_analysis(first, last, start_ms)
        trailing_conj = self.trailing_conjunction(last)
        internal_pauses_1s = (
            max(0, self._pauses_over_1s[last] - self._pauses_over_1s[first]) if last > first else 0
        )
        trend_count = self._trend[stop] - self._trend[first]
        total_duration_ms = end_ms - start_ms
        word_count = stop - first
        wpm = (word_count / (max(1, total_duration_ms) / 60000.0)) if total_duration_ms > 0 else 0.0

        return WindowSignals(
            words=word_count,
            duration_ms=total_duration_ms,
            speech_ms=self._speech_ms[stop] - self._speech_ms[first],
            opening=self.opening(first),
            closing=self.closing(last),
            pause_before=self.pause_before(first),
            pause_after=self.pause_after(last),
            opener=None if has_orphan else self.opener(first, last),
            question_up_front=False if has_orphan else any(self.question[i] for i in opening),
            punch_up_front=False
            if has_orphan
            else any(self.emphatic[i] or self.number[i] for i in opening),
            questions=self._questions[stop] - self._questions[first],
            exclamations=self._exclamations[stop] - self._exclamations[first],
            fillers=self._fillers[stop] - self._fillers[first],
            emphatic=self._emphatic[stop] - self._emphatic[first],
            numbers=self._numbers[stop] - self._numbers[first],
            entities=self._entities[stop] - self._entities[first],
            hook_analysis=hook_an,
            trailing_conjunction=trailing_conj,
            pauses_over_1s=internal_pauses_1s,
            trend_keywords=trend_count,
            wpm=wpm,
            orphan_pronoun=has_orphan,
        )

    def emphatic_words(self, first: int, last: int, limit: int = 3) -> list[str]:
        """The first few distinct emphatic words in the window, for its reasons."""
        found: list[str] = []
        for index in range(first, last + 1):
            if self.emphatic[index] and self.norm[index] not in found:
                found.append(self.norm[index])
                if len(found) == limit:
                    break
        return found


@dataclass(frozen=True, slots=True)
class WindowSignals:
    words: int
    duration_ms: int
    speech_ms: int
    #: How clean the cut in and out are: 1 on a sentence edge, 0.5 at a breath
    #: or a comma, 0 mid-phrase. At the transcript's own start and end, its
    #: typical cut (:class:`WordFeatures`).
    opening: float
    closing: float
    #: The silence around the cut, 0-1: a full :data:`PAUSE_MS` breath is 1.
    pause_before: float
    pause_after: float
    opener: str | None
    question_up_front: bool
    punch_up_front: bool
    questions: int
    exclamations: int
    fillers: int
    emphatic: int
    numbers: int
    entities: int
    hook_analysis: HookWindowAnalysis | None = None
    trailing_conjunction: bool = False
    pauses_over_1s: int = 0
    trend_keywords: int = 0
    wpm: float = 0.0
    orphan_pronoun: bool = False

    @property
    def opens_sentence(self) -> bool:
        return self.opening >= 1.0

    @property
    def closes_sentence(self) -> bool:
        return self.closing >= 1.0


@dataclass(frozen=True, slots=True)
class Score:
    """0-1 everywhere. ``potential`` is the ranking key."""

    potential: float
    hook: float
    clarity: float
    emotion: float
    novelty: float
    standalone: float
    question: float
    density: float
    fluency: float
    virality: ViralityBreakdown | None = None

    def percent(self) -> int:
        """``potentialScore``: the potential in whole percent."""
        return _percent(self.potential)

    def breakdown(self) -> dict[str, int]:
        """The contract's ``scoreBreakdown``, in whole percent."""
        base: dict[str, int] = {
            "hook": _percent(self.hook),
            "clarity": _percent(self.clarity),
            "emotion": _percent(self.emotion),
            "visualActivity": _UNMEASURED_VISUAL,
            "novelty": _percent(self.novelty),
            "standaloneValue": _percent(self.standalone),
            "safety": _UNMEASURED_SAFETY,
        }
        if self.virality is not None:
            base["narrative"] = int(round(self.virality.narrative * (100.0 / 25.0)))
            base["energy"] = int(round(self.virality.energy * (100.0 / 20.0)))
            base["trend"] = int(round(self.virality.trend * (100.0 / 15.0)))
            base["pacing"] = int(round(self.virality.pacing * (100.0 / 10.0)))
        return base


def _percent(value: float) -> int:
    # Half-up rather than Python's banker's rounding, so 0.625 is 63 on both sides
    # of any later re-computation in TypeScript.
    return math.floor(_unit(value) * 100 + 0.5)


def _pause_quality(gap_ms: int) -> float:
    return _unit(gap_ms / PAUSE_MS)


def virality_tier(score_val: int) -> ViralityTier:
    """Classifies clips into tier categories: Viral Gold (85-100), High Potential (70-84), Moderate (50-69)."""
    if score_val >= 85:
        return "VIRAL_GOLD"
    if score_val >= 70:
        return "HIGH_POTENTIAL"
    if score_val >= 50:
        return "MODERATE"
    return "STANDARD"


def acoustic_energy_and_penalty(
    acoustic: AcousticFeatures | WindowAcousticFeatures,
    *,
    window_duration_sec: float = 10.0,
) -> tuple[float, float]:
    """Compute S_energy (0-20 pts) and monotone penalty (0-10 pts) from acoustic features.

    Pillar 2 §07 Step 3:
    - Awards up to +20 points for high pitch variance (>= 40 Hz) and confirmed laughter / applause.
    - Penalizes monotone windows (sigma_F0 < 15 Hz) with flat dynamics.
    """
    ac = ensure_acoustic_features(acoustic, window_duration_sec=window_duration_sec)
    if ac is None:
        return 0.0, 0.0

    std_hz = ac.effective_pitch_std_hz

    # Base weighted acoustic energy
    s_energy = (
        8.0 * ac.pitch_variance
        + 6.0 * ac.volume_dynamics
        + 3.0 * ac.laughter_probability
        + 3.0 * ac.energy_peaks
    )

    # High pitch variance (>= 40 Hz) bonus
    if std_hz >= HIGH_VARIANCE_PITCH_STD_HZ:
        s_energy += 3.5 + min(2.5, (std_hz - HIGH_VARIANCE_PITCH_STD_HZ) / 10.0)

    # Confirmed laughter (YAMNet Class 16/17) bonus
    if ac.has_confirmed_laughter:
        laugh_boost = 4.5 + min(3.5, ac.laughter_duration_sec * 1.2 + ac.laughter_probability * 2.0)
        s_energy += laugh_boost

    # Confirmed audience applause / cheering (YAMNet Class 23/24) or >15 dB spike bonus
    if ac.applause_detected or ac.applause_probability >= 0.50:
        s_energy += 4.5
    if ac.rms_max_spike_db >= SPIKE_THRESHOLD_DB:
        s_energy += 2.5

    # Monotone window (< 15 Hz) with flat dynamics penalty
    monotone_penalty = 0.0
    is_flat_dynamics = (
        ac.volume_dynamics <= 0.30
        and ac.rms_max_spike_db < 8.0
        and not ac.has_confirmed_laughter
        and not ac.applause_detected
    )
    if std_hz < MONOTONE_PITCH_STD_HZ and is_flat_dynamics:
        s_energy *= 0.25
        severity = (MONOTONE_PITCH_STD_HZ - std_hz) / MONOTONE_PITCH_STD_HZ
        monotone_penalty = round(5.0 + 5.0 * max(0.0, min(1.0, severity)), 2)

    return max(0.0, min(20.0, s_energy)), monotone_penalty


def acoustic_emotion_score(
    acoustic: AcousticFeatures | WindowAcousticFeatures,
    *,
    window_duration_sec: float = 10.0,
) -> float:
    """Compute normalized 0-1 emotional delivery score from acoustic prosody and YAMNet events."""
    s_energy, monotone_penalty = acoustic_energy_and_penalty(
        acoustic, window_duration_sec=window_duration_sec
    )
    if monotone_penalty > 0:
        return max(0.0, min(0.20, (s_energy / 20.0) * 0.5))
    return _unit(s_energy / 20.0)


def virality_index(
    signals: WindowSignals,
    acoustic: AcousticFeatures | WindowAcousticFeatures | None = None,
    goal: str = "reach",
) -> ViralityBreakdown:
    """Universal Virality Formulation (0-100):

    ViralityScore = clamp(S_hook + S_narrative + S_energy + S_trend + S_pacing - monotone_penalty, 0, 100)
    """
    # 1. S_hook (0-30 pts)
    hook_an = signals.hook_analysis
    if hook_an is not None:
        s_hook = hook_an.s_hook
    else:
        curiosity = 1.0 if signals.opener else 0.6 if signals.question_up_front else 0.2
        contrarian = 0.5 if signals.punch_up_front else 0.0
        energy_r = 0.5
        s_hook = 15.0 * curiosity + 10.0 * contrarian + 5.0 * energy_r

    # 2. S_narrative (0-25 pts)
    premise = 7.0 * signals.opening + 3.0 * min(1.0, signals.pause_before / 0.7)
    if (hook_an is not None and hook_an.has_filler_opening) or signals.orphan_pronoun:
        premise *= 0.2
    closing = 7.0 * signals.closing + 3.0 * min(1.0, signals.pause_after / 0.7)
    conjunction_pts = 0.0 if signals.trailing_conjunction else 5.0
    s_narrative = max(0.0, min(25.0, premise + closing + conjunction_pts))

    # 3. S_energy (0-20 pts) & Monotone Penalty
    monotone_penalty = 0.0
    if acoustic is not None:
        win_sec = max(1.0, signals.duration_ms / 1000.0)
        s_energy, monotone_penalty = acoustic_energy_and_penalty(
            acoustic, window_duration_sec=win_sec
        )
    else:
        words_count = max(1, signals.words)
        emphatic_score = min(1.0, (signals.emphatic / words_count) / 0.04)
        excl_score = min(1.0, signals.exclamations / 2.0)
        speech_ratio = min(
            1.0, max(0.0, (signals.speech_ms / max(1, signals.duration_ms) - 0.35) / 0.5)
        )
        s_energy = 9.0 * emphatic_score + 5.0 * excl_score + 6.0 * speech_ratio
    s_energy = max(0.0, min(20.0, s_energy))

    # 4. S_trend (0-15 pts)
    words_count = max(1, signals.words)
    trend_density = signals.trend_keywords / words_count
    if trend_density >= 0.045:
        s_trend = 15.0
    elif trend_density >= 0.025:
        s_trend = 11.0
    elif signals.trend_keywords >= 1:
        s_trend = 7.0
    elif signals.entities >= 2:
        s_trend = 5.0
    elif signals.entities == 1:
        s_trend = 3.0
    else:
        s_trend = 0.0
    s_trend = max(0.0, min(15.0, s_trend))

    # 5. S_pacing (0-10 pts)
    wpm = signals.wpm
    if 150.0 <= wpm <= 190.0:
        cadence = 6.0
    elif 135.0 <= wpm < 150.0 or 190.0 < wpm <= 205.0:
        cadence = 4.5
    elif 120.0 <= wpm < 135.0 or 205.0 < wpm <= 225.0:
        cadence = 3.0
    elif 100.0 <= wpm < 120.0 or 225.0 < wpm <= 240.0:
        cadence = 1.5
    else:
        cadence = 0.0

    if signals.pauses_over_1s == 0:
        pauses = 4.0
    elif signals.pauses_over_1s == 1:
        pauses = 2.0
    else:
        pauses = 0.0
    s_pacing = max(0.0, min(10.0, cadence + pauses))

    total_raw = s_hook + s_narrative + s_energy + s_trend + s_pacing - monotone_penalty
    total = max(0.0, min(100.0, total_raw))
    total_int = int(math.floor(total + 0.5))
    tier = virality_tier(total_int)

    return ViralityBreakdown(
        hook=round(s_hook, 2),
        narrative=round(s_narrative, 2),
        energy=round(s_energy, 2),
        trend=round(s_trend, 2),
        pacing=round(s_pacing, 2),
        total=total_int,
        tier=tier,
    )


def score(
    signals: WindowSignals,
    goal: str = "reach",
    acoustic: AcousticFeatures | WindowAcousticFeatures | None = None,
) -> Score:
    """Combine a window's signals into calibrated multi-modal virality formulation and potential (0-1)."""
    words = max(1, signals.words)
    win_sec = max(1.0, signals.duration_ms / 1000.0)
    ac = ensure_acoustic_features(acoustic, window_duration_sec=win_sec)
    virality = virality_index(signals, acoustic=ac, goal=goal)

    standalone = (
        0.3 * signals.opening
        + 0.3 * signals.closing
        + 0.2 * signals.pause_before
        + 0.2 * signals.pause_after
    )
    if signals.trailing_conjunction:
        standalone *= 0.5

    opener = 1.0 if signals.opener else 0.6 if signals.question_up_front else 0.0
    punch = (
        0.3
        if signals.punch_up_front
        else 0.2
        if (signals.question_up_front and signals.opener)
        else 0.0
    )
    heuristic_hook = min(1.0, 0.7 * opener + punch)
    hook = max(heuristic_hook, min(1.0, virality.hook / 30.0))

    density = _unit((signals.speech_ms / max(1, signals.duration_ms) - 0.35) / 0.5)
    fluency = 1.0 - _unit(signals.fillers / words / 0.08)
    clarity = 0.55 * density + 0.45 * fluency

    lexical_emotion = 0.75 * _unit(signals.emphatic / words / 0.04) + 0.25 * _unit(
        signals.exclamations / 2
    )
    if ac is not None:
        ac_emotion = acoustic_emotion_score(ac, window_duration_sec=win_sec)
        _, monotone_pen = acoustic_energy_and_penalty(ac, window_duration_sec=win_sec)
        if monotone_pen > 0:
            emotion = min(lexical_emotion * 0.5, ac_emotion)
        else:
            emotion = max(lexical_emotion, 0.35 * lexical_emotion + 0.65 * ac_emotion)
    else:
        emotion = lexical_emotion
        monotone_pen = 0.0

    novelty = 0.5 * _unit(signals.numbers / 3) + 0.5 * _unit(signals.entities / 3)
    question = _unit(signals.questions / 2)

    weights = _WEIGHTS.get(goal, _WEIGHTS["reach"])
    weighted_potential = (
        weights["standalone"] * standalone
        + weights["hook"] * hook
        + weights["clarity"] * clarity
        + weights["emotion"] * emotion
        + weights["novelty"] * novelty
        + weights["question"] * question
    )
    if monotone_pen > 0:
        weighted_potential = max(0.0, weighted_potential - (monotone_pen / 100.0))

    if goal == "reach":
        potential = 0.6 * (virality.total / 100.0) + 0.4 * weighted_potential
    else:
        potential = weighted_potential

    return Score(
        potential=_unit(potential),
        hook=hook,
        clarity=clarity,
        emotion=_unit(emotion),
        novelty=novelty,
        standalone=standalone,
        question=question,
        density=density,
        fluency=fluency,
        virality=virality,
    )


ReasonLabel = Literal["hook", "clear_point", "emotion", "novelty", "standalone"]


@dataclass(frozen=True, slots=True)
class Reason:
    label: ReasonLabel
    explanation: str


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def reasons_for(
    signals: WindowSignals,
    result: Score,
    emphatic_words: Sequence[str],
    acoustic: AcousticFeatures | WindowAcousticFeatures | None = None,
) -> list[Reason]:
    """Why this window was picked, in terms of what was measured. Never empty."""
    reasons: list[Reason] = []
    seconds = round(signals.duration_ms / 1000)
    ac = ensure_acoustic_features(acoustic, window_duration_sec=max(1.0, float(seconds)))

    if signals.opener:
        reasons.append(
            Reason("hook", f"Opens with '{signals.opener}', a hook in the first seconds.")
        )
    elif signals.question_up_front:
        reasons.append(
            Reason("hook", "Opens on a question, which gives a reason to keep watching.")
        )
    elif signals.hook_analysis and signals.hook_analysis.s_hook >= 18:
        reasons.append(
            Reason(
                "hook",
                f"Strong hook opening ({round(signals.hook_analysis.s_hook)}/30 pts) with immediate curiosity gap.",
            )
        )
    elif signals.questions:
        reasons.append(
            Reason("hook", f"Asks {_plural(signals.questions, 'question')} the viewer can answer.")
        )

    if signals.opens_sentence and signals.closes_sentence and not signals.trailing_conjunction:
        reasons.append(
            Reason("standalone", "Starts and ends on complete sentences, so it stands on its own.")
        )
    elif signals.opens_sentence and signals.closes_sentence:
        reasons.append(
            Reason("standalone", "Starts and ends on complete sentences, so it stands on its own.")
        )

    specifics: list[str] = []
    if signals.numbers:
        specifics.append(_plural(signals.numbers, "number"))
    if signals.entities:
        specifics.append(_plural(signals.entities, "name"))
    if specifics:
        reasons.append(Reason("novelty", f"Concrete: mentions {' and '.join(specifics)}."))

    if ac is not None and ac.has_confirmed_laughter:
        dur_str = (
            f" ({ac.laughter_duration_sec:.1f}s laughter burst)"
            if ac.laughter_duration_sec >= 0.5
            else ""
        )
        reasons.append(
            Reason(
                "emotion",
                f"Contagious laughter and high vocal inflection detected{dur_str}.",
            )
        )
    elif ac is not None and ac.applause_detected:
        reasons.append(
            Reason("emotion", "Audience applause and high-energy vocal projection detected.")
        )
    elif ac is not None and ac.has_high_pitch_variance:
        pitch_std = round(ac.effective_pitch_std_hz)
        reasons.append(
            Reason(
                "emotion",
                f"Dynamic emotional delivery (pitch variance {pitch_std} Hz).",
            )
        )
    elif emphatic_words:
        quoted = ", ".join(f"'{word}'" for word in emphatic_words)
        reasons.append(Reason("emotion", f"Said with conviction ({quoted})."))
    elif signals.exclamations:
        reasons.append(Reason("emotion", "Delivered with energy: exclamations in the speech."))

    if result.clarity >= 0.75:
        reasons.append(
            Reason(
                "clear_point",
                f"Dense, fluent speech: {signals.words} words in {seconds} s"
                + (" with no fillers." if signals.fillers == 0 else " with few fillers."),
            )
        )

    if not reasons:
        reasons.append(
            Reason(
                "clear_point",
                f"{_plural(signals.words, 'word')} of continuous speech over {seconds} s.",
            )
        )
    return reasons
