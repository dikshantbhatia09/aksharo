"""Transcript assembly: stable word ids and the post-processing hook.

`CONTRACTS §2` freezes the shape:

```ts
type WordId = `${number}:${number}`;   // "<chunkIdx>:<n>", never reused
interface TranscriptChunk { chunkIdx; startMs; endMs; words: Word[] }
```

Two rules make those ids *stable*, and both live here rather than in a processor:

* **The chunk owns its numbering.** ``n`` restarts at 0 in every chunk, so
  re-transcribing chunk 3 cannot renumber chunk 4. That is what lets A11 write a
  new revision touching only the chunks that changed (`06 §transcript_chunks`).
* **A word belongs to the chunk it starts in.** A provider whose last word runs
  past the chunk boundary keeps that word in this chunk, clamped, rather than
  duplicating it into the next one — the chunk plan cuts on silence precisely so
  this is rare (D14: no overlap, no text de-duplication).

``post_process`` is the seam for A11 (punctuation, numerals, glossary boosting,
filler tagging). Here it is the identity, called anyway so the call site exists
and is covered.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from worker_ai.chunking import ChunkPlanEntry
from worker_ai.providers.base import Word

__all__ = [
    "PostProcessor",
    "TranscriptChunk",
    "assemble_chunk",
    "identity_post_process",
    "word_id",
]

#: A11 replaces this with the real pass; the signature is the contract between us.
PostProcessor = Callable[[tuple[Word, ...], str], tuple[Word, ...]]


def word_id(chunk_idx: int, index: int) -> str:
    """``"<chunkIdx>:<n>"`` (CONTRACTS section 2)."""
    if chunk_idx < 0 or index < 0:
        raise ValueError("word ids are built from non-negative integers")
    return f"{chunk_idx}:{index}"


def identity_post_process(words: tuple[Word, ...], language: str) -> tuple[Word, ...]:
    """The A09 post-processing pass: none. A11 owns punctuation and fillers."""
    del language
    return words


@dataclass(frozen=True, slots=True)
class TranscriptChunk:
    """One chunk of a transcript, ready for ``transcript_chunks`` (`06`)."""

    chunk_idx: int
    start_ms: int
    end_ms: int
    words: tuple[dict[str, Any], ...]

    @property
    def next_word_seq(self) -> int:
        """The next free ``n`` — ``transcript_chunks.nextWordSeq`` in `06`."""
        return len(self.words)

    def to_wire(self) -> dict[str, Any]:
        return {
            "chunkIdx": self.chunk_idx,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "nextWordSeq": self.next_word_seq,
            "words": list(self.words),
        }


def _word_to_wire(word: Word, wid: str, floor_ms: int, ceiling_ms: int) -> dict[str, Any]:
    """One EDG word, clamped into the chunk and stripped of empty optionals."""
    start = min(max(word.s, floor_ms), ceiling_ms)
    end = min(max(word.e, start), ceiling_ms)
    wire: dict[str, Any] = {"wid": wid, "s": start, "e": end, "t": word.t}
    if word.c is not None:
        wire["c"] = word.c
    if word.sp is not None:
        wire["sp"] = word.sp
    if word.scripts:
        wire["scripts"] = dict(word.scripts)
    if word.filler:
        wire["filler"] = True
    return wire


def assemble_chunk(
    chunk: ChunkPlanEntry,
    words: Iterable[Word],
    *,
    language: str,
    post_process: PostProcessor = identity_post_process,
) -> TranscriptChunk:
    """Turn one chunk's provider words into a :class:`TranscriptChunk`.

    Words arrive in **file time** (the provider was given the chunk's
    ``offset_ms``). They are sorted defensively — a provider that emits a word out
    of order would otherwise poison the ids, which are positional — then numbered
    and clamped to the chunk.
    """
    processed = post_process(tuple(words), language)
    # Empty text is dropped *before* numbering, so `n` is dense: a gap in the ids
    # would look like a deleted word to every consumer of the chunk.
    kept = [word for word in processed if word.t.strip()]
    ordered = sorted(kept, key=lambda word: (word.s, word.e))
    wire = tuple(
        _word_to_wire(word, word_id(chunk.chunk_idx, index), chunk.start_ms, chunk.end_ms)
        for index, word in enumerate(ordered)
    )
    return TranscriptChunk(
        chunk_idx=chunk.chunk_idx,
        start_ms=chunk.start_ms,
        end_ms=chunk.end_ms,
        words=wire,
    )
