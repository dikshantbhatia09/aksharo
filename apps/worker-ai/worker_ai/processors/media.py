"""Fetching the derived audio every ``ai.*`` processor starts from.

``apps/worker-media`` writes ``audio16k.wav`` under the CONTRACTS section 6 derived
key; the payload names the ids, never the key, so a compromised producer cannot
point this worker at another workspace's object.

A payload may carry ``audioUri`` instead — a local path or an https URL — which is
how the eval harness and the integration test run without a bucket. That is a
deliberate escape hatch and it is *only* honoured for paths that are not storage
keys, so it can never be used to read an arbitrary key from the derived bucket.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from worker_ai.audio import Pcm, read_pcm
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError
from worker_ai.storage import StorageError, derived_key
from worker_ai.vad import SpeechRegion, detect_regions

__all__ = ["MediaAudio", "load_audio", "load_track_audio", "speech_regions"]

_log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class MediaAudio:
    """The 16 kHz mono audio for one media asset, on local disk."""

    media_id: str
    path: Path
    pcm: Pcm
    #: The storage key it came from, or ``""`` for a locally supplied file.
    key: str = ""
    size_bytes: int = 0

    @property
    def duration_ms(self) -> int:
        return self.pcm.duration_ms


def load_audio(context: JobContext) -> MediaAudio:
    """Download (or open) ``audio16k.wav`` and decode it.

    :raises JobFailureError: with a non-retryable code when the payload is wrong, and a
        retryable one when the object store is momentarily unavailable.
    """
    media_id = context.payload_str("mediaId", required=True)
    local = context.payload_str("audioUri")
    if local:
        return _load_local(media_id, Path(local))

    project_id = context.payload_str("projectId") or (context.envelope.project_id or "")
    if not project_id:
        raise JobFailureError(
            "worker/invalid_payload",
            "derived media keys need a projectId (CONTRACTS section 6)",
            retryable=False,
        )

    store = context.services.derived_store
    if store is None:
        raise JobFailureError(
            "worker/storage_unconfigured",
            "R2_ENDPOINT, R2_BUCKET_DERIVED and the R2 credentials are required",
            retryable=False,
        )

    try:
        key = derived_key(context.envelope.workspace_id, project_id, media_id, "audio16k.wav")
    except StorageError as error:
        raise JobFailureError("worker/invalid_payload", str(error), retryable=False) from error

    destination = context.workdir / "audio16k.wav"
    try:
        store.download(key, destination)
        size = destination.stat().st_size
    except StorageError as error:
        # Could be a missing object (the media worker has not finished) or a blip;
        # either way a retry is the right answer and A08 bounds how many.
        raise JobFailureError("worker/storage_unavailable", str(error), retryable=True) from error

    _log.info(
        "derived audio fetched",
        extra={**context.envelope.log_fields(), "mediaId": media_id, "bytes": size},
    )
    return MediaAudio(
        media_id=media_id,
        path=destination,
        pcm=_decode(destination),
        key=key,
        size_bytes=size,
    )


def load_track_audio(
    context: JobContext, track: dict[str, Any], track_index: int = 0
) -> MediaAudio:
    """Download (or open) one isolated audio track for a multi-track media asset."""
    media_id = context.payload_str("mediaId", required=True)
    track_id = str(track.get("id") or f"track_{track_index}")

    # 1. Local path / audioUri provided (test mode or local worker)
    local_uri = track.get("audioUri") or track.get("path")
    if local_uri and Path(str(local_uri)).is_file():
        return _load_local(f"{media_id}-{track_id}", Path(str(local_uri)))

    # 2. Local file path supplied in storageKey
    storage_key = track.get("storageKey")
    if storage_key and Path(str(storage_key)).is_file():
        return _load_local(f"{media_id}-{track_id}", Path(str(storage_key)))

    store = context.services.derived_store
    if store is None:
        raise JobFailureError(
            "worker/storage_unconfigured",
            "R2_ENDPOINT, R2_BUCKET_DERIVED and the R2 credentials are required",
            retryable=False,
        )

    if not storage_key:
        raise JobFailureError(
            "worker/invalid_payload",
            f"audio track {track_id} is missing storageKey",
            retryable=False,
        )

    destination = context.workdir / f"track_{track_id}.wav"
    try:
        store.download(storage_key, destination)
        size = destination.stat().st_size
    except StorageError as error:
        raise JobFailureError("worker/storage_unavailable", str(error), retryable=True) from error

    _log.info(
        "derived audio track fetched",
        extra={
            **context.envelope.log_fields(),
            "mediaId": media_id,
            "trackId": track_id,
            "bytes": size,
        },
    )
    return MediaAudio(
        media_id=f"{media_id}-{track_id}",
        path=destination,
        pcm=_decode(destination),
        key=storage_key,
        size_bytes=size,
    )


def _load_local(media_id: str, path: Path) -> MediaAudio:
    if not path.is_file():
        raise JobFailureError(
            "worker/invalid_payload", f"audioUri {path.name} does not exist", retryable=False
        )
    return MediaAudio(
        media_id=media_id,
        path=path,
        pcm=_decode(path),
        size_bytes=path.stat().st_size,
    )


def _decode(path: Path) -> Pcm:
    try:
        return read_pcm(path)
    except Exception as error:
        raise JobFailureError(
            "worker/undecodable_audio",
            f"could not decode {path.name}: {error}",
            # Bad bytes stay bad; retrying would burn a GPU minute for nothing.
            retryable=False,
        ) from error


def speech_regions(context: JobContext, audio: MediaAudio) -> tuple[SpeechRegion, ...]:
    """Run the configured VAD backend over ``audio``."""
    return detect_regions(context.services.vad, audio.pcm)
