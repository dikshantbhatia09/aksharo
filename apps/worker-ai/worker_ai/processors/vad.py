"""``ai.vad`` — full-file VAD and the chunk plan (decision **D14**).

The cheap pass that everything else depends on: `09 §1.1` runs it *first*, before
LID and before any ASR, because the chunk boundaries it produces are what make
word ids stable and what keeps a vendor from being handed a sentence cut in half.

Result:

```json
{ "mediaId": "...", "durationMs": 754000, "backend": "silero-v5",
  "speechMs": 690120, "regions": [{ "startMs": 0, "endMs": 4120 }],
  "chunkPlan": [{ "chunkIdx": 0, "startMs": 0, "endMs": 601400 }] }
```

``ai.transcribe`` accepts that ``chunkPlan`` verbatim in its payload, so a caller
that has already paid for a VAD pass never pays for a second one.
"""

from __future__ import annotations

from worker_ai.callbacks import JobUsage
from worker_ai.chunking import boundary_never_splits_speech, plan_chunks
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, ProcessorOutcome
from worker_ai.processors.media import load_audio, speech_regions
from worker_ai.vad import total_speech_ms

__all__ = ["process_vad"]

_log = get_logger(__name__)


async def process_vad(context: JobContext) -> ProcessorOutcome:
    """Detect speech regions and plan chunks for one media asset."""
    await context.progress(5, message="fetching audio")
    audio = load_audio(context)

    await context.progress(35, message="detecting speech")
    regions = speech_regions(context, audio)

    plan = plan_chunks(audio.duration_ms, regions)
    # The invariant the planner exists for. It is cheap to check and a violation
    # would corrupt every word id downstream, so it is checked in production too.
    if not boundary_never_splits_speech(plan, regions):
        _log.warning(
            "a chunk boundary fell inside speech: no silence near a nominal boundary",
            extra={**context.envelope.log_fields(), "mediaId": audio.media_id},
        )

    speech_ms = total_speech_ms(regions)
    _log.info(
        "vad complete",
        extra={
            **context.envelope.log_fields(),
            "mediaId": audio.media_id,
            "regions": len(regions),
            "chunks": len(plan),
            "speechMs": speech_ms,
        },
    )
    return ProcessorOutcome(
        result={
            "mediaId": audio.media_id,
            "durationMs": audio.duration_ms,
            "speechMs": speech_ms,
            "backend": context.services.vad.name,
            "regions": [region.to_wire() for region in regions],
            "chunkPlan": [entry.to_wire() for entry in plan],
        },
        usage=JobUsage(
            media_seconds=audio.duration_ms / 1000,
            provider=context.services.vad.name,
            # CPU-only (`09 §9`), so nothing is charged beyond the reserved hold.
            cost_minor=0,
        ),
    )
