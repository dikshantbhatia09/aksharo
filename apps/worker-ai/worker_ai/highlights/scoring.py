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

from worker_ai.highlights.text import (
    ends_clause,
    is_exclamation,
    is_latin_capitalised,
    is_question,
    normalise,
)
from worker_ai.highlights.windows import PAUSE_MS, Unit, Word, sentence_ends

__all__ = [
    "PAUSE_MS",
    "ContentGoal",
    "Reason",
    "Score",
    "WindowSignals",
    "WordFeatures",
    "reasons_for",
    "score",
]

ContentGoal = Literal["reach", "education", "authority", "engagement"]

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
        return self._edge_cut if first == 0 else self.cut_after(first - 1)

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

    def opener(self, first: int, last: int) -> str | None:
        """The hook phrase words ``first..last`` open with, if any."""
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

        return WindowSignals(
            words=stop - first,
            duration_ms=end_ms - start_ms,
            speech_ms=self._speech_ms[stop] - self._speech_ms[first],
            opening=self.opening(first),
            closing=self.closing(last),
            pause_before=self.pause_before(first),
            pause_after=self.pause_after(last),
            opener=self.opener(first, last),
            question_up_front=any(self.question[i] for i in opening),
            punch_up_front=any(self.emphatic[i] or self.number[i] for i in opening),
            questions=self._questions[stop] - self._questions[first],
            exclamations=self._exclamations[stop] - self._exclamations[first],
            fillers=self._fillers[stop] - self._fillers[first],
            emphatic=self._emphatic[stop] - self._emphatic[first],
            numbers=self._numbers[stop] - self._numbers[first],
            entities=self._entities[stop] - self._entities[first],
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

    def percent(self) -> int:
        """``potentialScore``: the potential in whole percent."""
        return _percent(self.potential)

    def breakdown(self) -> dict[str, int]:
        """The contract's ``scoreBreakdown``, in whole percent."""
        return {
            "hook": _percent(self.hook),
            "clarity": _percent(self.clarity),
            "emotion": _percent(self.emotion),
            "visualActivity": _UNMEASURED_VISUAL,
            "novelty": _percent(self.novelty),
            "standaloneValue": _percent(self.standalone),
            "safety": _UNMEASURED_SAFETY,
        }


def _percent(value: float) -> int:
    # Half-up rather than Python's banker's rounding, so 0.625 is 63 on both sides
    # of any later re-computation in TypeScript.
    return math.floor(_unit(value) * 100 + 0.5)


def _pause_quality(gap_ms: int) -> float:
    return _unit(gap_ms / PAUSE_MS)


def score(signals: WindowSignals, goal: str) -> Score:
    """Combine a window's signals into its dimensions and its potential (0-1)."""
    words = max(1, signals.words)

    standalone = (
        0.3 * signals.opening
        + 0.3 * signals.closing
        + 0.2 * signals.pause_before
        + 0.2 * signals.pause_after
    )

    opener = 1.0 if signals.opener else 0.6 if signals.question_up_front else 0.0
    hook = 0.7 * opener + 0.3 * float(signals.punch_up_front)

    # Talking for 85% of the window is dense; a third of it is mostly air.
    density = _unit((signals.speech_ms / max(1, signals.duration_ms) - 0.35) / 0.5)
    # One filler in twelve words is as bad as it gets.
    fluency = 1.0 - _unit(signals.fillers / words / 0.08)
    clarity = 0.55 * density + 0.45 * fluency

    # One emphatic word in 25 is a speaker who means it.
    emotion = 0.75 * _unit(signals.emphatic / words / 0.04) + 0.25 * _unit(signals.exclamations / 2)
    novelty = 0.5 * _unit(signals.numbers / 3) + 0.5 * _unit(signals.entities / 3)
    question = _unit(signals.questions / 2)

    weights = _WEIGHTS.get(goal, _WEIGHTS["reach"])
    potential = (
        weights["standalone"] * standalone
        + weights["hook"] * hook
        + weights["clarity"] * clarity
        + weights["emotion"] * emotion
        + weights["novelty"] * novelty
        + weights["question"] * question
    )
    return Score(
        potential=_unit(potential),
        hook=hook,
        clarity=clarity,
        emotion=emotion,
        novelty=novelty,
        standalone=standalone,
        question=question,
        density=density,
        fluency=fluency,
    )


ReasonLabel = Literal["hook", "clear_point", "emotion", "novelty", "standalone"]


@dataclass(frozen=True, slots=True)
class Reason:
    label: ReasonLabel
    explanation: str


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def reasons_for(
    signals: WindowSignals, result: Score, emphatic_words: Sequence[str]
) -> list[Reason]:
    """Why this window was picked, in terms of what was measured. Never empty."""
    reasons: list[Reason] = []
    seconds = round(signals.duration_ms / 1000)

    if signals.opener:
        reasons.append(
            Reason("hook", f"Opens with '{signals.opener}', a hook in the first seconds.")
        )
    elif signals.question_up_front:
        reasons.append(
            Reason("hook", "Opens on a question, which gives a reason to keep watching.")
        )
    elif signals.questions:
        reasons.append(
            Reason("hook", f"Asks {_plural(signals.questions, 'question')} the viewer can answer.")
        )

    if signals.opens_sentence and signals.closes_sentence:
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

    if emphatic_words:
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
