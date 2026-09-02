"""``ai.transliterate`` — Roman <-> native script, per word (`09 §4`, A22).

The producer (`POST /projects/{id}/transcript/transliterate`) embeds the words
to transliterate directly in the job payload — `(wid, text)` pairs, already read
from `transcript_chunks` — rather than this worker fetching them itself: the
worker holds no user session and reads no row it was not handed, exactly like
`ai.transcribe` is handed `audioKey` rather than a project id to look one up
from (`transcribe.handler.ts`'s own rule, applied here).

Unlike `ai.transcribe`, the result is **not** carried home on the job
completion payload. It is written directly through
`POST /internal/transcripts/{id}/scripts` (`callbacks.write_transcript_scripts`)
*before* the job completes, because that endpoint is this queue's own signed
surface (`apps/api/src/transcripts/scripts/`) and keeping the transliteration
write separate from job bookkeeping is what lets the endpoint be replayed and
inspected on its own, the same way `PATCH /internal/media/{id}` is separate from
`media.probe`'s own completion.
"""

from __future__ import annotations

from worker_ai.callbacks import JobUsage
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.transliterate import TargetScript, transliterate_words

__all__ = ["process_transliterate"]

_TARGET_SCRIPTS: frozenset[str] = frozenset({"roman", "native"})


async def process_transliterate(context: JobContext) -> ProcessorOutcome:
    """Transliterate every word the payload carries into `targetScript`."""
    transcript_id = context.payload_str("transcriptId", required=True)
    language = context.payload_str("language", required=True)
    target = context.payload_str("targetScript", required=True)
    if target not in _TARGET_SCRIPTS:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.transliterate targetScript must be roman or native, got "
            f"{target!r}",
            retryable=False,
        )
    words = _read_words(context)

    await context.progress(10, message=f"transliterating {len(words)} words to {target}")

    provider = context.services.transliteration
    result = await transliterate_words(
        provider,
        words=words,
        language=language,
        target=_cast_target(target),
    )
    context.record(result.submissions)

    await context.progress(70, message="writing word scripts")
    ack = await context.services.callbacks.write_transcript_scripts(
        transcript_id,
        context.envelope.attempt_id,
        {
            "jobId": context.envelope.job_id,
            "targetScript": target,
            "provider": provider.name,
            "words": [{"wid": word.wid, "text": word.text} for word in result.words],
        },
    )

    await context.progress(100, message="done")
    return ProcessorOutcome(
        result={
            "transcriptId": transcript_id,
            "targetScript": target,
            "wordsUpdated": len(result.words),
            "wordsPreserved": result.unchanged,
            "provider": provider.name,
            "applied": ack.applied,
            "providerSubmissions": context.submissions_wire(),
        },
        usage=JobUsage(provider=provider.name, cost_minor=0),
    )


def _cast_target(target: str) -> TargetScript:
    """Narrow the validated string literal for the type checker."""
    return "roman" if target == "roman" else "native"


def _read_words(context: JobContext) -> tuple[tuple[str, str], ...]:
    """`[{wid, t}, ...]` from the payload, in order.

    Empty text is kept — the transliteration of an empty string is an empty
    string, not an omission.
    """
    raw = context.envelope.payload.get("words")
    if not isinstance(raw, list) or not raw:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.transliterate needs a non-empty words[]",
            retryable=False,
        )
    words: list[tuple[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise JobFailureError(
                "worker/invalid_payload",
                "ai.transliterate words[] entries must be objects",
                retryable=False,
            )
        wid = entry.get("wid")
        text = entry.get("t", entry.get("text"))
        if not isinstance(wid, str) or not isinstance(text, str):
            raise JobFailureError(
                "worker/invalid_payload",
                "ai.transliterate words[] entries need a string wid and t",
                retryable=False,
            )
        words.append((wid, text))
    return tuple(words)
