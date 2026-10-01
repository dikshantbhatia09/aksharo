"""``ai.voiceover`` — a clip's hook line, spoken (2026-10-01).

One job is ONE text-to-speech call (Sarvam's ``bulbul``)::

    an earlier attempt's checkpoint, and its file still stored?
        -> answer from it (``reused: true``), the vendor is not asked
    else
        -> synthesise -> check it is one WAV of a sane length -> store it at the
           payload's one key -> record the checkpoint -> answer

**The vendor is paid once per stored file.** A text-to-speech call has no job
on the vendor's side to resume, so the only way to pay twice is a retry after
the vendor answered. The checkpoint is written on this job's own row the moment
the file is in the store, and every later attempt that finds it - a BullMQ
retry, a stalled job picked up again, a DLQ replay - answers from the stored
file instead of calling again. The one case that can still be paid twice is an
answer lost between the vendor and the store; a hook is at most 300 characters,
well under a rupee.

The worker revalidates everything it is given (``contracts.py``): the one key
it writes must match the voice-over key pattern, so a payload cannot point it
at an original, a face track or another workspace's files. The WAV is measured
from its own header (``wave``), never from what the vendor says about it.
"""

from __future__ import annotations

import asyncio
import io
import wave
from collections.abc import Mapping
from typing import Final

from pydantic import ValidationError

from worker_ai.callbacks import JobUsage
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import (
    JobContext,
    JobFailureError,
    JobSettledError,
    ProcessorOutcome,
)
from worker_ai.storage import StorageError
from worker_ai.voiceover.contracts import (
    MAX_AUDIO_BYTES,
    MAX_DURATION_MS,
    SAMPLE_RATE,
    SCHEMA_VERSION,
    VoiceoverCheckpoint,
    VoiceoverPayload,
    VoiceoverResult,
)
from worker_ai.voiceover.sarvam import SarvamSpeechClient, SpeechVendorError, vendor_paise

__all__ = ["process_voiceover", "wav_duration_ms"]

_log = get_logger(__name__)

PROVIDER: Final[str] = "sarvam"
#: The ack reasons that mean this attempt can no longer record anything.
_SETTLED: Final = frozenset({"already_completed", "stale_attempt"})


async def process_voiceover(context: JobContext) -> ProcessorOutcome:
    """Run one ``ai.voiceover`` job."""
    try:
        payload = VoiceoverPayload.model_validate(context.envelope.payload)
    except ValidationError as error:
        raise JobFailureError(
            "worker/invalid_payload",
            f"ai.voiceover payload does not match ai.voiceover@1 "
            f"({error.error_count()} problem(s))",
            retryable=False,
        ) from error
    store = context.services.derived_store
    if store is None:
        raise JobFailureError(
            "worker/storage_unavailable",
            "This worker has no derived store, so it cannot keep the voice-over.",
            retryable=False,
        )
    log = {**context.envelope.log_fields(), "voiceoverId": payload.voiceover_id}

    kept = await _stored_earlier(context, payload, log)
    if kept is not None:
        return _outcome(payload, kept, reused=True)

    vendor = context.services.speech
    if vendor is None:
        raise JobFailureError(
            "voiceover/not_configured",
            "This worker has no SARVAM_API_KEY, so it cannot make a voice-over.",
            retryable=False,
        )
    audio = await _synthesise(vendor, payload)
    duration_ms = _checked_duration(audio)
    await context.progress(70, message="Saving the voice-over")

    path = context.workdir / "hook.wav"
    await asyncio.to_thread(path.write_bytes, audio)
    try:
        await asyncio.to_thread(store.upload, path, payload.destination.key)
    except StorageError as error:
        raise JobFailureError(
            "worker/storage_unavailable",
            "The voice-over could not be stored; it is made again.",
            retryable=True,
        ) from error

    point = VoiceoverCheckpoint.model_validate(
        {
            "key": payload.destination.key,
            "sizeBytes": len(audio),
            "durationMs": duration_ms,
            "characters": len(payload.text),
        }
    )
    await _record(context, point, log)
    _log.info(
        "voice-over made",
        extra={**log, "durationMs": duration_ms, "characters": point.characters},
    )
    return _outcome(payload, point, reused=False)


async def _stored_earlier(
    context: JobContext, payload: VoiceoverPayload, log: Mapping[str, object]
) -> VoiceoverCheckpoint | None:
    """An earlier attempt's stored file, when its checkpoint names it and it is still there."""
    ack = context.start_ack
    if ack is None or not ack.checkpoint:
        return None
    try:
        point = VoiceoverCheckpoint.model_validate(ack.checkpoint)
    except ValidationError:
        _log.warning("the job's checkpoint is not a voice-over's; ignored", extra=log)
        return None
    if point.key != payload.destination.key:
        return None
    store = context.services.derived_store
    if store is None:
        return None
    try:
        size = await asyncio.to_thread(store.size_bytes, point.key)
    except StorageError:
        # Gone (or unreadable): made again, which is the one safe answer.
        return None
    if size != point.size_bytes:
        return None
    _log.info("voice-over answered from an earlier attempt's file", extra=log)
    return point


async def _synthesise(vendor: SarvamSpeechClient, payload: VoiceoverPayload) -> bytes:
    try:
        speech = await vendor.synthesise(
            text=payload.text,
            language=payload.language,
            speaker=payload.speaker,
            pace=payload.pace,
            model=payload.model,
            sample_rate=SAMPLE_RATE,
        )
    except SpeechVendorError as error:
        raise JobFailureError(error.code, error.message, retryable=error.retryable) from error
    return speech.audio


def _checked_duration(audio: bytes) -> int:
    """The WAV's length from its own header, refusing anything that is not a sane one."""
    if len(audio) == 0 or len(audio) > MAX_AUDIO_BYTES:
        raise JobFailureError(
            "voiceover/unreadable",
            "The voice-over came back empty or far too large; it is made again.",
            retryable=True,
        )
    duration_ms = wav_duration_ms(audio)
    if duration_ms is None:
        raise JobFailureError(
            "voiceover/unreadable",
            "The voice-over came back as something that is not audio; it is made again.",
            retryable=True,
        )
    if duration_ms > MAX_DURATION_MS:
        raise JobFailureError(
            "voiceover/too_long",
            "The voice-over came back longer than 30 seconds. Use a shorter line.",
            retryable=False,
        )
    return duration_ms


def wav_duration_ms(audio: bytes) -> int | None:
    """Milliseconds of audio in a RIFF/WAVE file, or ``None`` when it is not one."""
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return None
    try:
        with wave.open(io.BytesIO(audio), "rb") as reader:
            frames = reader.getnframes()
            rate = reader.getframerate()
    except (wave.Error, EOFError):
        return None
    if rate <= 0 or frames <= 0:
        return None
    return max(1, round(frames * 1000 / rate))


async def _record(
    context: JobContext, point: VoiceoverCheckpoint, log: Mapping[str, object]
) -> None:
    """Write the checkpoint. A failure to write it is logged, not fatal: the file is stored."""
    try:
        ack = await context.save_checkpoint(
            {
                "key": point.key,
                "sizeBytes": point.size_bytes,
                "durationMs": point.duration_ms,
                "characters": point.characters,
            },
            percent=90,
            message="Voice-over made",
        )
    except Exception as error:
        _log.warning(
            "could not record the voice-over's checkpoint",
            extra={**log, "reason": str(error)[:200]},
        )
        return
    if not ack.applied and (ack.reason or "") in _SETTLED:
        raise JobSettledError(ack.reason or "already_completed")


def _outcome(
    payload: VoiceoverPayload, point: VoiceoverCheckpoint, *, reused: bool
) -> ProcessorOutcome:
    result = VoiceoverResult.model_validate(
        {
            "schemaVersion": SCHEMA_VERSION,
            "voiceoverId": payload.voiceover_id,
            "key": point.key,
            "contentType": "audio/wav",
            "sizeBytes": point.size_bytes,
            "durationMs": point.duration_ms,
            "characters": point.characters,
            "reused": reused,
        }
    )
    return ProcessorOutcome(
        result=result.to_wire(),
        usage=JobUsage(
            output_seconds=point.duration_ms / 1000,
            provider=PROVIDER,
            model=payload.model,
            # An answer from a stored file cost nothing this attempt.
            cost_minor=0 if reused else vendor_paise(point.characters),
        ),
    )
