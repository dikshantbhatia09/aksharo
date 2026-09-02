"""``ai.align`` — force known text onto audio through the registry (decision **D13**).

Payload:

```json
{ "mediaId": "...", "language": "hi",
  "segments": [{ "startMs": 0, "endMs": 4120, "text": "toh aaj hum" }] }
```

or ``{"words": ["toh", "aaj"], "startMs": 0, "endMs": 4120}`` for a single span.

The registry resolves the best available aligner for the language; on `main` that
is always :class:`~worker_ai.alignment.proportional.ProportionalAligner`, refined
by the VAD regions of the file, because the three model-backed rungs land in A10.

The audio is fetched when the payload names media, because a real aligner needs it
and because the VAD regions are what "refined by VAD boundaries" means. A payload
that supplies ``regions`` skips the download, which is how the transcribe path
calls this without paying twice.
"""

from __future__ import annotations

from typing import Any

from worker_ai.alignment.base import AlignmentUnavailableError
from worker_ai.callbacks import JobUsage
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.processors.media import load_audio, speech_regions
from worker_ai.providers.base import AlignmentRequest, Word
from worker_ai.vad import SpeechRegion

__all__ = ["process_align"]

_log = get_logger(__name__)


async def process_align(context: JobContext) -> ProcessorOutcome:
    """Align every segment in the payload."""
    language = context.payload_str("language", default="en")
    segments = _segments(context)
    if not segments:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.align needs segments[] or words[] in the job payload",
            retryable=False,
        )

    try:
        aligner = context.services.aligners.resolve(language)
    except AlignmentUnavailableError as error:
        raise JobFailureError("worker/no_aligner", str(error), retryable=False) from error

    await context.progress(10, message=f"aligning with {aligner.name}")
    regions, duration_ms, audio_uri = _regions(context)

    words: list[Word] = []
    total = len(segments)
    for index, (start_ms, end_ms, tokens) in enumerate(segments):
        aligned = await aligner.align(
            AlignmentRequest(
                audio_uri=audio_uri,
                words=tokens,
                language=language,
                start_ms=start_ms,
                end_ms=end_ms,
            ),
            regions,
        )
        words.extend(aligned)
        await context.progress(10 + 85 * (index + 1) / total)

    _log.info(
        "alignment complete",
        extra={
            **context.envelope.log_fields(),
            "aligner": aligner.name,
            "segments": total,
            "words": len(words),
        },
    )
    return ProcessorOutcome(
        result={
            "mediaId": context.payload_str("mediaId"),
            "language": language,
            "alignerModel": aligner.name,
            "words": [{"s": word.s, "e": word.e, "t": word.t} for word in words],
            "providerSubmissions": context.submissions_wire(),
        },
        usage=JobUsage(
            media_seconds=duration_ms / 1000 if duration_ms else None,
            provider=aligner.name,
            cost_minor=0,
        ),
    )


def _segments(context: JobContext) -> tuple[tuple[int, int, tuple[str, ...]], ...]:
    """Normalise both payload shapes into ``(startMs, endMs, words)`` triples."""
    raw = context.envelope.payload.get("segments")
    if isinstance(raw, list) and raw:
        out: list[tuple[int, int, tuple[str, ...]]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            tokens = _tokens(item)
            if not tokens:
                continue
            out.append((int(item.get("startMs", 0)), int(item.get("endMs", 0)), tokens))
        return tuple(out)

    tokens = _tokens(context.envelope.payload)
    if tokens:
        payload = context.envelope.payload
        return ((int(payload.get("startMs", 0)), int(payload.get("endMs", 0)), tokens),)
    return ()


def _tokens(source: dict[str, Any]) -> tuple[str, ...]:
    words = source.get("words")
    if isinstance(words, list) and words:
        return tuple(str(item) for item in words if str(item).strip())
    text = source.get("text")
    if isinstance(text, str) and text.strip():
        return tuple(text.split())
    return ()


def _regions(context: JobContext) -> tuple[tuple[SpeechRegion, ...], int, str]:
    """VAD regions for the file: from the payload, or by fetching the audio."""
    raw = context.envelope.payload.get("regions")
    if isinstance(raw, list) and raw:
        regions = tuple(
            SpeechRegion(start_ms=int(item["startMs"]), end_ms=int(item["endMs"]))
            for item in raw
            if isinstance(item, dict) and "startMs" in item and "endMs" in item
        )
        return regions, 0, ""

    if not context.payload_str("mediaId"):
        # No media and no regions: proportional alignment across the span alone.
        return (), 0, ""
    audio = load_audio(context)
    return speech_regions(context, audio), audio.duration_ms, str(audio.path)
