"""Shape glossary/spelling memory terms into the flat hint tuple providers see.

`processors/transcribe.py::_hints()` already reads `context.envelope.payload["hints"]`
and every provider adapter already forwards that tuple as its own vocabulary
shape — AssemblyAI's ``word_boost`` (`providers/assemblyai.py`), Sarvam's
``vocabulary`` parameter (`providers/sarvam.py`), ElevenLabs Scribe's
``keyterms`` (`providers/elevenlabs.py`), and Whisper's ``initial_prompt``
(`providers/local_whisper.py`) / raw ``hints`` (`providers/serverless_whisper.py`).

That per-vendor shaping is A09's, already built, and this module does not
duplicate it. What was missing is the one step every one of those adapters
needs done *before* it sees the list: the API assembles `hints.glossary` from
however many `memory_entries` a workspace has (B09 caps reads at
`MAX_GLOSSARY_TERMS = 500` in `transcripts/postprocess/glossary.source.ts`),
and a raw 500-term list is a dictionary, not a hotword hint — AssemblyAI's
`word_boost` and a Whisper `initial_prompt` both degrade well past a few dozen
terms, and a duplicate or empty entry is pure waste in either.

``prepare_hints()`` is that one shared shaping step: case-insensitive dedupe,
trims, drops anything empty or implausibly long (a glossary term, not a
sentence), and caps the count. It is a pure function so it can sit ahead of
`_hints()` without depending on the job/provider wiring at all — wiring it in
is a one-line change in `_hints()` this work package does not own the call
site for (see the B09 final report).
"""

from __future__ import annotations

from collections.abc import Iterable

MAX_HINTS_DEFAULT = 100
MAX_HINT_LENGTH = 80


def prepare_hints(raw: Iterable[str], *, cap: int = MAX_HINTS_DEFAULT) -> tuple[str, ...]:
    """Dedupe (case-insensitive), trim, drop empty/over-long terms, cap the count.

    Order is preserved from `raw` (the memory reader's own order — most
    recently created first), so the terms most likely to matter survive the cap.
    """
    seen: set[str] = set()
    out: list[str] = []
    for term in raw:
        text = term.strip()
        if not text or len(text) > MAX_HINT_LENGTH:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= cap:
            break
    return tuple(out)
