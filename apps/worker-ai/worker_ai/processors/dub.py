"""``ai.dub`` — a clip in other languages, in the speaker's own voice (2026-10-04).

One job is ONE vendor job (Sarvam's Dubbing API) for every language of one
request::

    resume a vendor job an earlier attempt recorded, or
    create -> record its id (checkpoint) -> upload the clip -> start
    -> poll live-status (every poll a heartbeat) -> export-status
    -> download each language's audio and SRT -> derived store

**What it costs is the vendor's minutes, so the order is the whole design.**
The vendor's job id is recorded on this job's own row (the progress callback's
checkpoint) BEFORE the job is started, and the API has to answer that it
landed; a checkpoint that did not land stops the attempt with the vendor job
cancelled and never started. Every later attempt - a BullMQ retry, a stalled
job picked up again, a DLQ replay, a person's Retry (``resumeVendorJobId``) -
reads the id back and resumes THAT job: a second vendor job is started only
when the first definitively failed, and never within one attempt.

What resuming finds, and does:

    no such job, failed, deleted  started: the dub failed (``dub/vendor_failed``)
                                  never started: start afresh (nothing was spent)
    not_started                   uploaded: start it; only created: start afresh
    queued, in_progress           poll it
    completed, partial_failure    collect its files

A person's cancel settles the row; the next heartbeat's answer says so, and the
worker cancels the vendor job before it stops. A row a newer attempt owns
(``stale_attempt``) is left to that attempt, which resumes the same vendor job.

Files land under the dub's folder only (the payload's pattern-checked prefix):
``{prefix}/{language}/audio.{ext}`` - the extension read from the file's own
first bytes - and ``{prefix}/{language}/captions.srt``. Download URLs are fetched
fresh from export-status on every attempt, never kept (they expire in a day).
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Literal
from urllib.parse import urlsplit

from pydantic import ValidationError

from worker_ai.callbacks import CallbackAck, JobUsage
from worker_ai.dubbing.contracts import (
    MAX_AUDIO_BYTES,
    MAX_CAPTIONS_BYTES,
    SCHEMA_VERSION,
    DubCancelPayload,
    DubCancelResult,
    DubCheckpoint,
    DubRunPayload,
    DubRunResult,
    DubTrack,
    parse_dub_payload,
)
from worker_ai.dubbing.sarvam import (
    DUBBING_FAILED,
    DUBBING_FINISHED,
    DubbingVendorError,
    DubExport,
    DubLiveStatus,
    SarvamDubbingClient,
)
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import (
    JobContext,
    JobFailureError,
    JobSettledError,
    ProcessorOutcome,
)
from worker_ai.storage import StorageError

__all__ = [
    "VENDOR_PAISE_PER_MINUTE",
    "ExportPlan",
    "plan_exports",
    "process_dub",
    "sniff_audio_extension",
    "vendor_paise",
]

_log = get_logger(__name__)

#: ₹40 per minute of source per target language (Sarvam, 2026-09-29), in paise.
VENDOR_PAISE_PER_MINUTE: Final[int] = 4_000
PROVIDER: Final[str] = "sarvam"
MODEL: Final[str] = "sarvam-dubbing"

#: The ack reasons that mean nothing this attempt does can be recorded
#: (``staleReason`` in ``jobs.service.ts``; the same set the runtime reads).
_SETTLED: Final = frozenset({"already_completed", "stale_attempt"})
#: The person stopped it (or it was otherwise settled): the vendor stops too.
_CANCELLED: Final[str] = "already_completed"


def vendor_paise(duration_ms: int, languages: int) -> int:
    """What the vendor charges for ``languages`` of a clip this long, rounded up."""
    return -(-duration_ms * languages * VENDOR_PAISE_PER_MINUTE // 60_000)


async def process_dub(context: JobContext) -> ProcessorOutcome:
    """Run one ``ai.dub`` job: a dub, or the cancel of a dub's vendor job."""
    try:
        payload = parse_dub_payload(context.envelope.payload)
    except ValidationError as error:
        raise JobFailureError(
            "worker/invalid_payload",
            f"ai.dub payload does not match ai.dub@1 ({error.error_count()} problem(s))",
            retryable=False,
        ) from error
    vendor = context.services.dubbing
    if vendor is None:
        raise JobFailureError(
            "dub/not_configured",
            "This worker has no SARVAM_API_KEY, so it cannot dub.",
            retryable=False,
        )
    if isinstance(payload, DubCancelPayload):
        return await _cancel(vendor, payload)
    return await _DubJob(context, vendor, payload).run()


async def _cancel(vendor: SarvamDubbingClient, payload: DubCancelPayload) -> ProcessorOutcome:
    try:
        cancelled = await vendor.cancel(payload.vendor_job_id)
    except DubbingVendorError as error:
        raise _failure(error) from error
    _log.info(
        "cancelled a dub's vendor job",
        extra={
            "dubId": payload.dub_id,
            "vendorJobId": payload.vendor_job_id,
            "cancelled": cancelled,
        },
    )
    result = DubCancelResult.model_validate(
        {
            "schemaVersion": SCHEMA_VERSION,
            "action": "cancel",
            "dubId": payload.dub_id,
            "vendorJobId": payload.vendor_job_id,
            "cancelled": cancelled,
        }
    )
    return ProcessorOutcome(result=result.to_wire())


class _CheckpointUnsavedError(Exception):
    """The API did not confirm the vendor job's id: it must not be started."""


class _DubJob:
    def __init__(
        self, context: JobContext, vendor: SarvamDubbingClient, payload: DubRunPayload
    ) -> None:
        self.context = context
        self.vendor = vendor
        self.payload = payload
        self.log = {**context.envelope.log_fields(), "dubId": payload.dub_id}

    async def run(self) -> ProcessorOutcome:
        job_id = await self._resume_or_start()
        final = await self._await_vendor(job_id)
        tracks = await self._collect(job_id, final)
        ready = [track for track in tracks if track.status == "ready"]
        if not ready:
            raise JobFailureError(
                "dub/vendor_failed",
                "The dubbing service finished without dubbed audio for any language.",
                retryable=False,
            )
        result = DubRunResult.model_validate(
            {
                "schemaVersion": SCHEMA_VERSION,
                "action": "dub",
                "dubId": self.payload.dub_id,
                "vendorJobId": job_id,
                "vendorStatus": "completed" if final.status == "completed" else "partial_failure",
                "tracks": tracks,
            }
        )
        _log.info(
            "dub ready",
            extra={**self.log, "vendorJobId": job_id, "languages": len(ready), "of": len(tracks)},
        )
        return ProcessorOutcome(
            result=result.to_wire(),
            usage=JobUsage(
                media_seconds=self.payload.duration_ms / 1000,
                provider=PROVIDER,
                model=MODEL,
                cost_minor=vendor_paise(self.payload.duration_ms, len(ready)),
            ),
        )

    # -- resume, or create -> record -> upload -> start ---------------------

    async def _resume_or_start(self) -> str:
        point = self._resume_point()
        if point is not None:
            kept = await self._resume(*point)
            if kept is not None:
                return kept
        return await self._create_and_start()

    def _resume_point(self) -> tuple[str, str] | None:
        """The vendor job this attempt continues: this row's checkpoint, or the API's word."""
        ack = self.context.start_ack
        if ack is not None and ack.checkpoint:
            try:
                point = DubCheckpoint.model_validate(ack.checkpoint)
            except ValidationError:
                _log.warning("the job's checkpoint is not a dub's; ignored", extra=self.log)
            else:
                return point.vendor_job_id, point.vendor_phase
        if self.payload.resume_vendor_job_id is not None:
            return self.payload.resume_vendor_job_id, "started"
        return None

    async def _resume(self, job_id: str, phase: str) -> str | None:
        """The resumed job's id, or ``None`` to start afresh (it was never started)."""
        status = await self._status(job_id)
        _log.info(
            "resuming a dub's vendor job",
            extra={**self.log, "vendorJobId": job_id, "phase": phase, "status": _name(status)},
        )
        if status is None or status.status in DUBBING_FAILED:
            if phase == "started":
                raise JobFailureError(
                    "dub/vendor_failed",
                    (status.error_message if status is not None else None)
                    or "The dubbing service no longer has this dub, or could not finish it.",
                    retryable=False,
                )
            return None
        if status.status == "not_started":
            if phase == "created":
                # Whether the video ever reached it is unknown, and nothing was
                # spent on a job never started: a clean one is cheaper than a guess.
                await self._quietly_cancel(job_id)
                return None
            await self._start(job_id)
            return job_id
        if (
            phase != "started"
            or self.context.start_ack is None
            or not self.context.start_ack.checkpoint
        ):
            # Say it is running on THIS row (a resume from the payload, or a
            # start whose record was lost), so a cancel finds it here.
            await self._record(job_id, "started", percent=10, message="Dubbing", required=False)
        return job_id

    async def _create_and_start(self) -> str:
        try:
            created = await self.vendor.create_job(
                source_language=self.payload.source_language,
                target_languages=list(self.payload.target_languages),
                speakers=self.payload.speakers,
                job_name=f"aksharo-dub-{self.payload.dub_id}",
            )
        except DubbingVendorError as error:
            raise _failure(error) from error
        job_id = created.job_id
        _log.info("created a dub's vendor job", extra={**self.log, "vendorJobId": job_id})
        try:
            await self._record(
                job_id, "created", percent=2, message="Sending the clip to be dubbed", required=True
            )
        except _CheckpointUnsavedError as error:
            await self._quietly_cancel(job_id)
            raise JobFailureError(
                "dub/checkpoint_unsaved",
                "The dub could not be recorded before it started, so it was not started; "
                "it is tried again.",
                retryable=True,
            ) from error

        source = await self._fetch_source()
        try:
            await self.vendor.upload(created.upload_url, source, content_type="video/mp4")
        except DubbingVendorError as error:
            # Never started, so nothing is owed; the next attempt finds it
            # `created` and starts clean.
            await self._quietly_cancel(job_id)
            raise _failure(error) from error
        await self._record(
            job_id, "uploaded", percent=8, message="The clip has been sent", required=False
        )
        await self._start(job_id)
        return job_id

    async def _start(self, job_id: str) -> None:
        try:
            await self.vendor.start(job_id)
        except DubbingVendorError as error:
            # A start whose answer was lost, or a job the vendor started itself:
            # ask before calling it a failure.
            status = await self._status_quietly(job_id)
            if status is None or status.status == "not_started" or status.status in DUBBING_FAILED:
                if not error.retryable:
                    await self._quietly_cancel(job_id)
                raise _failure(error) from error
        await self._record(job_id, "started", percent=10, message="Dubbing", required=False)

    async def _record(
        self, job_id: str, phase: str, *, percent: float, message: str, required: bool
    ) -> None:
        """Write the resume point on this job's row; ``required`` waits for the API to say so."""
        try:
            ack = await self.context.save_checkpoint(
                {"vendorJobId": job_id, "vendorPhase": phase}, percent=percent, message=message
            )
        except Exception as error:
            _log.warning(
                "could not record the dub's vendor job",
                extra={
                    **self.log,
                    "vendorJobId": job_id,
                    "phase": phase,
                    "reason": str(error)[:200],
                },
            )
            if required:
                raise _CheckpointUnsavedError(str(error)) from error
            return
        if ack.applied:
            return
        reason = ack.reason or "not_applied"
        if reason in _SETTLED:
            # A cancel stops the vendor job; so does a newer attempt owning the
            # row before this one's job was ever recorded as started - that
            # attempt cannot know about it, and will make its own.
            if reason == _CANCELLED or phase != "started":
                await self._quietly_cancel(job_id)
            raise JobSettledError(reason)
        if required:
            raise _CheckpointUnsavedError(reason)

    async def _fetch_source(self) -> Path:
        store = self.context.services.derived_store
        if store is None:
            raise JobFailureError(
                "worker/storage_unavailable",
                "This worker has no derived store, so it cannot read the clip.",
                retryable=False,
            )
        path = self.context.workdir / "source.mp4"
        try:
            await asyncio.to_thread(store.download, self.payload.source.key, path)
        except StorageError as error:
            raise JobFailureError(
                "dub/source_unavailable",
                "The clip's video could not be read.",
                retryable=True,
            ) from error
        return path

    # -- the vendor at work ---------------------------------------------------

    async def _await_vendor(self, job_id: str) -> DubLiveStatus:
        waited = 0.0
        while True:
            status = await self._status(job_id)
            if status is None:
                raise JobFailureError(
                    "dub/vendor_failed",
                    "The dubbing service no longer has this dub.",
                    retryable=False,
                )
            if status.status in DUBBING_FINISHED:
                return status
            if status.status in DUBBING_FAILED:
                raise JobFailureError(
                    "dub/vendor_failed",
                    status.error_message or "The dubbing service could not dub this clip.",
                    retryable=False,
                )
            vendor_progress = min(max(status.progress or 0.0, 0.0), 100.0)
            ack = await self.context.beat(
                round(10 + 75 * vendor_progress / 100, 1), message=status.step
            )
            await self._stop_if_settled(ack, job_id)
            if waited >= self.vendor.poll_timeout_s:
                raise JobFailureError(
                    "dub/vendor_timeout",
                    "Sarvam is still dubbing; the dub is picked up again where it is.",
                    retryable=True,
                )
            await self.vendor.sleep(self.vendor.poll_interval_s)
            waited += self.vendor.poll_interval_s

    async def _collect(self, job_id: str, final: DubLiveStatus) -> list[DubTrack]:
        targets = list(self.payload.target_languages)
        limit = min(100, max(5, len(targets) * 4))
        waited = 0.0
        while True:
            try:
                exports = await self.vendor.export_status(job_id, limit=limit)
            except DubbingVendorError as error:
                raise _failure(error) from error
            plan = plan_exports(exports, targets, final_status=final.status)
            if not plan.pending:
                break
            if waited >= self.vendor.export_timeout_s:
                raise JobFailureError(
                    "dub/exports_pending",
                    "Sarvam finished the dub but its files are not ready yet; "
                    "they are fetched again shortly.",
                    retryable=True,
                )
            ack = await self.context.beat(88, message="Waiting for the dubbed files")
            await self._stop_if_settled(ack, job_id)
            await self.vendor.sleep(self.vendor.export_interval_s)
            waited += self.vendor.export_interval_s

        tracks: list[DubTrack] = []
        for index, language in enumerate(targets):
            chosen = plan.ready.get(language)
            if chosen is None:
                tracks.append(
                    DubTrack.model_validate(
                        {
                            "language": language,
                            "status": "failed",
                            "reason": plan.failed.get(
                                language, "The dubbing service returned no files for it."
                            ),
                        }
                    )
                )
                continue
            await self.context.progress(
                90 + 8 * index / len(targets), message="Saving the dubbed files"
            )
            tracks.append(await self._store_language(language, *chosen))
        return tracks

    async def _store_language(self, language: str, audio: DubExport, srt: DubExport) -> DubTrack:
        store = self.context.services.derived_store
        if store is None:
            raise JobFailureError(
                "worker/storage_unavailable",
                "This worker has no derived store, so it cannot keep the dub.",
                retryable=False,
            )
        folder = self.context.workdir / language
        await asyncio.to_thread(folder.mkdir, parents=True, exist_ok=True)
        audio_file = folder / "audio.download"
        captions_file = folder / "captions.srt"
        try:
            got_audio = await self.vendor.download(
                audio.download_url or "", audio_file, max_bytes=MAX_AUDIO_BYTES
            )
            got_captions = await self.vendor.download(
                srt.download_url or "", captions_file, max_bytes=MAX_CAPTIONS_BYTES
            )
        except DubbingVendorError as error:
            raise _failure(error) from error

        head = await asyncio.to_thread(_head, audio_file)
        extension = sniff_audio_extension(head, got_audio.content_type, audio.download_url or "")
        if got_audio.size_bytes == 0 or extension is None:
            raise JobFailureError(
                "dub/download_unreadable",
                f"Sarvam's {language} audio is not an audio file; it is fetched again.",
                retryable=True,
            )
        if not await asyncio.to_thread(_readable_captions, captions_file):
            raise JobFailureError(
                "dub/download_unreadable",
                f"Sarvam's {language} captions are not text; they are fetched again.",
                retryable=True,
            )

        prefix = self.payload.destination_prefix
        audio_key = f"{prefix}/{language}/audio.{extension}"
        captions_key = f"{prefix}/{language}/captions.srt"
        try:
            await asyncio.to_thread(store.upload, audio_file, audio_key)
            await asyncio.to_thread(store.upload, captions_file, captions_key)
        except StorageError as error:
            raise JobFailureError(
                "worker/storage_unavailable",
                "The dubbed files could not be stored; they are fetched again.",
                retryable=True,
            ) from error
        content_type = (got_audio.content_type or "").split(";", 1)[0].strip()[:100]
        return DubTrack.model_validate(
            {
                "language": language,
                "status": "ready",
                "audio": {
                    "key": audio_key,
                    "contentType": content_type or f"audio/{extension}",
                    "sizeBytes": got_audio.size_bytes,
                },
                "captions": {"key": captions_key, "sizeBytes": got_captions.size_bytes},
            }
        )

    # -- helpers ------------------------------------------------------------

    async def _status(self, job_id: str) -> DubLiveStatus | None:
        try:
            return await self.vendor.live_status(job_id)
        except DubbingVendorError as error:
            raise _failure(error) from error

    async def _status_quietly(self, job_id: str) -> DubLiveStatus | None:
        try:
            return await self.vendor.live_status(job_id)
        except DubbingVendorError:
            return None

    async def _stop_if_settled(self, ack: CallbackAck | None, job_id: str) -> None:
        if ack is None or ack.applied or ack.reason not in _SETTLED:
            return
        if ack.reason == _CANCELLED:
            # The person cancelled the dub: the vendor stops too. A newer attempt
            # owning the row (`stale_attempt`) resumes this same job instead.
            await self._quietly_cancel(job_id)
        raise JobSettledError(ack.reason)

    async def _quietly_cancel(self, job_id: str) -> None:
        try:
            await self.vendor.cancel(job_id)
        except DubbingVendorError as error:
            _log.warning(
                "could not cancel a dub's vendor job",
                extra={**self.log, "vendorJobId": job_id, "reason": error.message},
            )


# ---------------------------------------------------------------------------
# Pure pieces, tested on their own
# ---------------------------------------------------------------------------


@dataclass
class ExportPlan:
    """Per language: both files to fetch, why there are none, or still to come."""

    ready: dict[str, tuple[DubExport, DubExport]] = field(default_factory=dict)
    failed: dict[str, str] = field(default_factory=dict)
    pending: list[str] = field(default_factory=list)


def plan_exports(
    exports: Sequence[DubExport], targets: Sequence[str], *, final_status: str
) -> ExportPlan:
    """What export-status says about each language's audio and SRT.

    An export with no ``download_url`` yet is still coming, even if it says
    completed. A completed export that is not stale wins over a stale one, and
    the newest wins among equals. A language with nothing listed is still
    coming after a ``completed`` job, and failed after a ``partial_failure``.
    """
    plan = ExportPlan()
    for language in targets:
        audio = _pick(exports, language, "audio")
        srt = _pick(exports, language, "srt")
        if isinstance(audio, DubExport) and isinstance(srt, DubExport):
            plan.ready[language] = (audio, srt)
        elif "failed" in (audio, srt):
            kind = "audio" if audio == "failed" else "captions"
            plan.failed[language] = f"The dubbing service could not make this language's {kind}."
        elif "pending" in (audio, srt):
            plan.pending.append(language)
        elif final_status == "partial_failure":
            plan.failed[language] = "The dubbing service did not dub this language."
        else:
            plan.pending.append(language)
    return plan


def _pick(
    exports: Sequence[DubExport], language: str, kind: str
) -> DubExport | Literal["pending", "failed", "missing"]:
    same = [
        export
        for export in exports
        if export.export_type == kind and export.language.lower() == language.lower()
    ]
    usable = [export for export in same if export.status == "completed" and export.download_url]
    if usable:
        fresh = [export for export in usable if not export.is_stale] or usable
        return max(fresh, key=lambda export: export.completed_at)
    if not same:
        return "missing"
    if all(export.status == "failed" for export in same):
        return "failed"
    return "pending"


def sniff_audio_extension(head: bytes, content_type: str | None, url: str) -> str | None:
    """The audio's type from its own first bytes, else what it was served as.

    ``None`` when it is plainly not audio (a page or a JSON error served with a
    200), so it is never filed as a dub.
    """
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:4] == b"fLaC":
        return "flac"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if head[4:8] == b"ftyp":
        return "m4a"
    if head[:3] == b"ID3":
        return "mp3"
    if len(head) >= 2 and head[0] == 0xFF:
        if head[1] & 0xF6 == 0xF0:
            return "aac"  # ADTS
        if head[1] & 0xE0 == 0xE0:
            return "mp3"  # an MPEG audio frame
    kind = (content_type or "").split(";", 1)[0].strip().lower()
    if kind.startswith(("text/", "application/json", "application/xml")):
        return None
    by_type = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/wave": "wav",
        "audio/mp4": "m4a",
        "audio/x-m4a": "m4a",
        "audio/aac": "aac",
        "audio/ogg": "ogg",
        "audio/opus": "opus",
        "audio/flac": "flac",
        "audio/webm": "webm",
    }
    if kind in by_type:
        return by_type[kind]
    suffix = Path(urlsplit(url).path).suffix.lower().lstrip(".")
    if suffix in {"mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "webm"}:
        return suffix
    return "mp3" if kind.startswith("audio/") or kind == "application/octet-stream" else None


def _head(path: Path) -> bytes:
    with path.open("rb") as handle:
        return handle.read(16)


def _readable_captions(path: Path) -> bool:
    """Subtitles are UTF-8 text (a BOM allowed); an empty file is a silent clip's."""
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except UnicodeDecodeError:
        return False
    return text.strip() == "" or "-->" in text


def _failure(error: DubbingVendorError) -> JobFailureError:
    return JobFailureError(error.code, error.message, retryable=error.retryable)


def _name(status: DubLiveStatus | None) -> str:
    return "unknown-to-vendor" if status is None else status.status
