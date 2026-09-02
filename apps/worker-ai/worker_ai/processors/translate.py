"""``ai.translate`` — segment-preserving translation (`09 §4`, A22).

Like `ai.transliterate`, this worker never reads a row: the producer
(`POST /projects/{id}/transcript/translate`) hands it the segment texts to
translate and the EDG revision it read them at. The result is written through
the **existing** signed EDG surface (`POST /internal/projects/{id}/edg/ops`,
`callbacks.apply_edg_ops`) as one `SetSegmentText` op per segment, `script:
"translated"` — the same op an interactive editor submits, just authored by the
worker (the guard hard-codes `source: "worker"`; nothing in this payload claims
it). That is what makes the result **revisioned and undoable**: it goes through
the ordinary rebase/conflict machinery in `@montaj/edg`, so a translation job
that lands after the user edited the same segment's `translated` text comes back
as a 409 the same way two human editors would collide — not a silent overwrite.
"""

from __future__ import annotations

from worker_ai.callbacks import CallbackError, JobUsage
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.translate import AllProvidersFailedError, translate_segments
from worker_ai.ulid import new_ulid

__all__ = ["process_translate"]

_TRANSLATED_SCRIPT = "translated"


async def process_translate(context: JobContext) -> ProcessorOutcome:
    """Translate every segment the payload carries into `targetLanguage`."""
    source_language = context.payload_str("sourceLanguage", required=True)
    target_language = context.payload_str("targetLanguage", required=True)
    base_revision = _read_base_revision(context)
    glossary = _read_glossary(context)
    segments = _read_segments(context)

    if context.envelope.project_id is None:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.translate needs a project to write ops to",
            retryable=False,
        )
    project_id = context.envelope.project_id

    await context.progress(
        10, message=f"translating {len(segments)} segments to {target_language}"
    )

    try:
        result = await translate_segments(
            context.services.translation_providers,
            segments=segments,
            source_language=source_language,
            target_language=target_language,
            glossary=glossary,
        )
    except AllProvidersFailedError as error:
        raise JobFailureError(
            "worker/translation_failed", str(error), retryable=error.retryable
        ) from error
    context.record(result.submissions)

    await context.progress(70, message="writing segment overrides")
    ops = [
        {
            "opId": new_ulid(),
            "type": "SetSegmentText",
            "segmentId": segment.segment_id,
            "script": _TRANSLATED_SCRIPT,
            "text": segment.text,
        }
        for segment in result.segments
    ]

    try:
        ack = await context.services.callbacks.apply_edg_ops(
            project_id,
            context.envelope.attempt_id,
            {
                "baseRevision": base_revision,
                "ops": ops,
                "clientOpIds": [op["opId"] for op in ops],
            },
        )
    except CallbackError as error:
        if error.status_code == 409:
            raise JobFailureError(
                "worker/translation_conflict",
                "the target segments changed after this translation started; "
                "regenerate to retry",
                retryable=False,
            ) from error
        raise

    await context.progress(100, message="done")
    return ProcessorOutcome(
        result={
            "targetLanguage": target_language,
            "segmentsTranslated": len(result.segments),
            "provider": result.provider,
            "lengthRetries": result.length_retries,
            "truncated": result.truncated,
            "applied": ack.applied,
            "providerSubmissions": context.submissions_wire(),
        },
        usage=JobUsage(provider=result.provider, cost_minor=0),
    )


def _read_base_revision(context: JobContext) -> int:
    value = context.envelope.payload.get("baseRevision")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.translate needs a non-negative baseRevision",
            retryable=False,
        )
    return value


def _read_glossary(context: JobContext) -> tuple[str, ...]:
    raw = context.envelope.payload.get("glossary")
    if not isinstance(raw, list):
        return ()
    return tuple(term for term in raw if isinstance(term, str) and term.strip())


def _read_segments(context: JobContext) -> tuple[tuple[str, str], ...]:
    raw = context.envelope.payload.get("segments")
    if not isinstance(raw, list) or not raw:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.translate needs a non-empty segments[]",
            retryable=False,
        )
    segments: list[tuple[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise JobFailureError(
                "worker/invalid_payload",
                "ai.translate segments[] entries must be objects",
                retryable=False,
            )
        segment_id = entry.get("segmentId")
        text = entry.get("text")
        if not isinstance(segment_id, str) or not isinstance(text, str):
            raise JobFailureError(
                "worker/invalid_payload",
                "ai.translate segments[] entries need a string segmentId and text",
                retryable=False,
            )
        segments.append((segment_id, text))
    return tuple(segments)
