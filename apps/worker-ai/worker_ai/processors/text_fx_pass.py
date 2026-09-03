"""``ai.pass`` (`passType: "textfx"`) — D06's key-phrase title pass.

Same shape as `processors/reframe_zoom_pass.py`: stateless, pure-algorithm
work happens in `worker_ai.passes.text_fx`, this module only calls the LLM
(via `worker_ai.llm.service.generate_insight`, B11's plumbing, reused rather
than duplicated), unwraps the job payload, and reshapes the result for the
completion callback (`apps/api/src/passes/passes-completion.handler.ts`,
which turns it into a `MergePass` op with `kind: "title"` items — CONTRACTS
§2's `ItemKind` has no separate `"text_fx"` kind, so a title produced by this
pass rides the existing `title` kind with its extra classification fields on
`payload`, same as `zoom`/`reframe` ride `payload` fields no other pass uses).

### Payload shape (producer: `apps/api/src/passes/passes.service.ts`)

    {
      "passId": "...", "passType": "textfx",
      "durationMs": 120000, "language": "en",
      "segments": [{"startMs": 0, "endMs": 4000, "text": "...", "speaker": "spk1"}],
      "words": [["0:0", 0, 300, "hi"], ...],
      "cutRanges": [[1000, 1500]],
      "protectedRanges": [[5000, 6000]],
      "region": "in"
    }

`segments` feeds the `keyphrases@1` prompt (B11's PII-minimised transcript
block); `words` is every live transcript word, used only for snapping and
never sent to the LLM.
"""

from __future__ import annotations

from typing import Any

from worker_ai.callbacks import JobUsage
from worker_ai.llm.region import RegionBlockedError
from worker_ai.llm.service import AllProvidersFailedError, InvalidOutputError, generate_insight
from worker_ai.llm.templates import TranscriptInput, TranscriptSegment
from worker_ai.passes.text_fx import Word, build_text_fx_events
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.providers.base import ProviderSubmission

__all__ = ["process_text_fx"]


def _read_segments(payload: dict[str, Any]) -> tuple[TranscriptSegment, ...]:
    raw = payload.get("segments")
    if not isinstance(raw, list):
        return ()
    segments: list[TranscriptSegment] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        segments.append(
            TranscriptSegment(
                start_ms=_int(item.get("startMs"), default=0),
                end_ms=_int(item.get("endMs"), default=0),
                text=str(item.get("text", "")),
                speaker=item.get("speaker") if isinstance(item.get("speaker"), str) else None,
            )
        )
    return tuple(segments)


def _read_words(payload: dict[str, Any]) -> list[Word]:
    raw = payload.get("words")
    if not isinstance(raw, list):
        return []
    words: list[Word] = []
    for item in raw:
        if isinstance(item, list) and len(item) == 4:
            words.append(
                Word(
                    wid=str(item[0]),
                    s=_int(item[1], default=0),
                    e=_int(item[2], default=0),
                    t=str(item[3]),
                )
            )
    return words


def _read_ranges(raw: Any) -> list[tuple[int, int]]:
    if not isinstance(raw, list):
        return []
    ranges: list[tuple[int, int]] = []
    for item in raw:
        if isinstance(item, list) and len(item) == 2:
            ranges.append((_int(item[0], default=0), _int(item[1], default=0)))
    return ranges


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


async def process_text_fx(context: JobContext) -> ProcessorOutcome:
    payload = context.envelope.payload
    pass_id = context.payload_str("passId", required=True)
    language = context.payload_str("language", default="en") or "en"
    region = context.payload_str("region", default="in") or "in"
    duration_ms = _int(payload.get("durationMs"), default=0)

    segments = _read_segments(payload)
    if not segments:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.pass (textfx) needs segments[] in the job payload",
            retryable=False,
        )
    words = _read_words(payload)
    cut_ranges = _read_ranges(payload.get("cutRanges"))
    protected_ranges = _read_ranges(payload.get("protectedRanges"))
    guarded = [*cut_ranges, *protected_ranges]

    transcript = TranscriptInput(
        language=language,
        duration_ms=duration_ms,
        segments=segments,
        max_phrases=min(50, max(1, duration_ms // 20_000 or 1)),
    )

    await context.progress(10, message="extracting key phrases")
    try:
        result = await generate_insight(
            "keyphrases", transcript, context.services.llm_providers, region
        )
    except RegionBlockedError as error:
        raise JobFailureError("worker/region_not_supported", str(error), retryable=False) from error
    except AllProvidersFailedError as error:
        raise JobFailureError("worker/llm_provider_failed", str(error), retryable=True) from error
    except InvalidOutputError as error:
        raise JobFailureError("worker/llm_invalid_output", str(error), retryable=False) from error

    context.record(
        (
            ProviderSubmission(
                provider=result.provider,
                endpoint=result.endpoint,
                artefact="llm_output",
                region=result.region,
                retention_class="zero_retention" if result.provider != "mock" else "vendor_default",
            ),
        )
    )

    await context.progress(60, message="building title events")
    keyphrases = result.output.get("keyphrases", [])
    events = build_text_fx_events(keyphrases, words, guarded_ranges=guarded)
    await context.progress(90, message=f"{len(events)} title events proposed")

    return ProcessorOutcome(
        result={
            "passId": pass_id,
            "passType": "textfx",
            "items": [
                {
                    "text": event.text,
                    "intent": event.intent,
                    "startMs": event.start_ms,
                    "endMs": event.end_ms,
                    "anchorWordIds": list(event.anchor_word_ids),
                    "motionPreset": event.motion_preset,
                    "confidence": event.confidence,
                    "reason": event.reason,
                }
                for event in events
            ],
            "providerSubmissions": context.submissions_wire(),
        },
        usage=JobUsage(media_seconds=duration_ms / 1000 if duration_ms else None),
    )
