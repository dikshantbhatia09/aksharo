"""Putting speaker labels onto words, and reading RTTM (`09 §2`).

Diarisation produces **turns** — a speaker and a span — while the EDG stores a
speaker on each **word** (``Word.sp``, CONTRACTS §2). Joining the two is an
overlap problem, and the rule is the obvious one stated precisely:

> a word belongs to the turn it overlaps most; ties go to the earlier turn; a
> word that overlaps nothing takes the nearest turn's speaker.

The last clause matters more than it looks. A word can sit outside every turn
because the diariser trimmed a breath or because an aligner nudged an onset by
30 ms, and leaving that word unlabelled makes the editor show a one-word speaker
gap in the middle of a sentence. Assigning it to the nearest turn is wrong far
less often than leaving it blank looks wrong.

:func:`parse_rttm` reads NIST RTTM, which is what every diarisation dataset and
every pyannote example ships, so a synthetic RTTM is what the tests align against
rather than a hand-built list of dataclasses.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from worker_ai.providers.base import DiarisedSpeaker, Word

__all__ = ["SpeakerMapping", "assign_speakers", "parse_rttm", "speaker_ids"]


@dataclass(frozen=True, slots=True)
class SpeakerMapping:
    """The result of a join: the words, and how confident the join was."""

    words: tuple[Word, ...]
    #: Words that overlapped no turn and took the nearest one instead.
    snapped: int = 0
    #: Words left unlabelled because there were no turns at all.
    unlabelled: int = 0

    def to_wire(self) -> dict[str, Any]:
        return {
            "words": len(self.words),
            "snapped": self.snapped,
            "unlabelled": self.unlabelled,
        }


def assign_speakers(
    words: tuple[Word, ...], turns: tuple[DiarisedSpeaker, ...]
) -> SpeakerMapping:
    """Label every word with the speaker of the turn it overlaps most."""
    if not words:
        return SpeakerMapping(words=())
    if not turns:
        return SpeakerMapping(words=words, unlabelled=len(words))

    ordered = sorted(turns, key=lambda turn: (turn.start_ms, turn.end_ms))
    labelled: list[Word] = []
    snapped = 0

    for word in words:
        best_turn: DiarisedSpeaker | None = None
        best_overlap = 0
        for turn in ordered:
            if turn.start_ms >= word.e:
                # Turns are sorted, so nothing after this one can overlap either.
                break
            overlap = min(word.e, turn.end_ms) - max(word.s, turn.start_ms)
            if overlap > best_overlap:
                best_turn, best_overlap = turn, overlap

        if best_turn is None:
            best_turn = min(ordered, key=lambda turn: _distance(turn, word))
            snapped += 1

        labelled.append(
            Word(
                s=word.s,
                e=word.e,
                t=word.t,
                c=word.c,
                sp=best_turn.speaker_id,
                scripts=dict(word.scripts),
                filler=word.filler,
            )
        )

    return SpeakerMapping(words=tuple(labelled), snapped=snapped)


def speaker_ids(turns: tuple[DiarisedSpeaker, ...]) -> tuple[str, ...]:
    """Every distinct speaker, in first-appearance order — the EDG's speaker list."""
    seen: list[str] = []
    for turn in sorted(turns, key=lambda item: (item.start_ms, item.end_ms)):
        if turn.speaker_id not in seen:
            seen.append(turn.speaker_id)
    return tuple(seen)


def parse_rttm(text: str) -> tuple[DiarisedSpeaker, ...]:
    """Parse NIST RTTM ``SPEAKER`` lines into turns, in milliseconds.

    ``SPEAKER file 1 <onset> <duration> <NA> <NA> <speaker> <NA> <NA>``; every
    other record type is ignored, which is what every RTTM reader does.
    """
    turns: list[DiarisedSpeaker] = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 8 or fields[0].upper() != "SPEAKER":
            continue
        try:
            onset = float(fields[3])
            duration = float(fields[4])
        except ValueError:
            continue
        if duration <= 0:
            continue
        turns.append(
            DiarisedSpeaker(
                speaker_id=fields[7],
                start_ms=round(onset * 1000),
                end_ms=round((onset + duration) * 1000),
            )
        )
    return tuple(sorted(turns, key=lambda turn: (turn.start_ms, turn.end_ms)))


def _distance(turn: DiarisedSpeaker, word: Word) -> int:
    """How far a word sits from a turn it does not overlap."""
    if word.e <= turn.start_ms:
        return turn.start_ms - word.e
    if word.s >= turn.end_ms:
        return word.s - turn.end_ms
    return 0
