"""``ai.diarise`` — speaker turns over the whole file (decision **D13**).

`09 §2` requires whole-file diarisation so speaker ids survive chunk boundaries,
which is why this is its own queue rather than a step inside ``ai.transcribe``:
the transcribe job fans out over chunks, and this one deliberately does not.

A09 ships :class:`~worker_ai.diarisation.noop.NoopDiariser` — one speaker over
every VAD region — and A10 puts pyannote community-1 in front of it. The result
shape is the same either way, so A11's speaker UI can be built against this.
"""

from __future__ import annotations

from worker_ai.callbacks import JobUsage
from worker_ai.diarisation.base import DiarisationUnavailableError
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.processors.media import load_audio, speech_regions
from worker_ai.providers.base import DiarisationRequest

__all__ = ["process_diarise"]

_log = get_logger(__name__)


async def process_diarise(context: JobContext) -> ProcessorOutcome:
    """Label every speech region with a speaker."""
    try:
        diariser = context.services.diarisers.resolve()
    except DiarisationUnavailableError as error:
        raise JobFailureError("worker/no_diariser", str(error), retryable=False) from error

    await context.progress(5, message="fetching audio")
    audio = load_audio(context)

    await context.progress(30, message="detecting speech")
    regions = speech_regions(context, audio)

    await context.progress(60, message=f"diarising with {diariser.name}")
    turns = await diariser.diarise(
        DiarisationRequest(
            audio_uri=str(audio.path),
            num_speakers=_optional_int(context, "numSpeakers"),
            min_speakers=_optional_int(context, "minSpeakers"),
            max_speakers=_optional_int(context, "maxSpeakers"),
            regions=tuple((region.start_ms, region.end_ms) for region in regions),
        )
    )

    speakers = sorted({turn.speaker_id for turn in turns})
    _log.info(
        "diarisation complete",
        extra={
            **context.envelope.log_fields(),
            "diariser": diariser.name,
            "speakers": len(speakers),
            "turns": len(turns),
        },
    )
    return ProcessorOutcome(
        result={
            "mediaId": audio.media_id,
            "diariser": diariser.name,
            "globalLabels": diariser.global_labels,
            "speakers": [{"id": speaker} for speaker in speakers],
            "turns": [turn.to_wire() for turn in turns],
            "providerSubmissions": context.submissions_wire(),
        },
        usage=JobUsage(
            media_seconds=audio.duration_ms / 1000,
            provider=diariser.name,
            cost_minor=0,
            egress_bytes=audio.size_bytes,
        ),
    )


def _optional_int(context: JobContext, key: str) -> int | None:
    """A positive integer from the payload, or ``None``; ``True`` is not a count."""
    value = context.envelope.payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value > 0 else None
