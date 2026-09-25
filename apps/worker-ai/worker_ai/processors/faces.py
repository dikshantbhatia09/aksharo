"""``ai.faces`` — where the faces are, over a whole video.

Queued by the API when a video's proxy is ready (`apps/api/src/media/
faces.trigger.ts`), free and outside the plan's concurrency cap. Downloads the
540p proxy, runs YuNet every `DEFAULT_INTERVAL_MS` (`worker_ai.passes.faces`),
uploads `faces.json` next to the proxy, and reports the key; the API records it
on the media row (`faces_key`) and the caption renderer keeps captions off the
faces it lists (`packages/render-core/src/frame/placement.ts`).

Payload: ``{"mediaId": "...", "projectId": "..."}``.
"""

from __future__ import annotations

import asyncio
import json

from worker_ai.audio import AudioToolError
from worker_ai.callbacks import JobUsage
from worker_ai.logging_setup import get_logger
from worker_ai.passes.faces import (
    DEFAULT_INTERVAL_MS,
    YuNetOnnxDetector,
    detect_face_track,
    face_track_document,
)
from worker_ai.passes.frame_sampling import probe_video_size
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.processors.proxy_media import download_proxy
from worker_ai.storage import StorageError, derived_key

__all__ = ["process_faces"]

_log = get_logger(__name__)


async def process_faces(context: JobContext) -> ProcessorOutcome:
    media_id = context.payload_str("mediaId", required=True)
    project_id = context.payload_str("projectId") or (context.envelope.project_id or "")
    model_path = context.settings.face_model_path
    if not model_path:
        raise JobFailureError(
            "worker/config_missing",
            "YUNET_MODEL_PATH is not set, so this worker cannot detect faces",
            retryable=False,
        )

    await context.progress(5, message="fetching the proxy")
    proxy = await download_proxy(context)

    await context.progress(15, message="finding faces")
    try:
        detector = YuNetOnnxDetector(model_path)
        source_width, source_height = probe_video_size(proxy)
        samples = await asyncio.to_thread(
            detect_face_track, proxy, detector, interval_ms=DEFAULT_INTERVAL_MS
        )
    except AudioToolError as error:
        raise JobFailureError("worker/media_unreadable", str(error), retryable=False) from error

    document = face_track_document(
        samples,
        interval_ms=DEFAULT_INTERVAL_MS,
        source_width=source_width,
        source_height=source_height,
    )
    path = context.workdir / "faces.json"
    path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")

    await context.progress(90, message="uploading")
    store = context.services.derived_store
    if store is None:
        raise JobFailureError(
            "worker/storage_unconfigured",
            "R2_ENDPOINT, R2_BUCKET_DERIVED and the R2 credentials are required",
            retryable=False,
        )
    try:
        key = store.upload(
            path, derived_key(context.envelope.workspace_id, project_id, media_id, "faces.json")
        )
    except StorageError as error:
        raise JobFailureError("worker/storage_unavailable", str(error), retryable=True) from error

    with_faces = sum(1 for sample in samples if sample.boxes)
    _log.info(
        "faces complete",
        extra={
            **context.envelope.log_fields(),
            "mediaId": media_id,
            "samples": len(samples),
            "samplesWithFaces": with_faces,
        },
    )
    duration_s = len(samples) * DEFAULT_INTERVAL_MS / 1000
    return ProcessorOutcome(
        result={
            "mediaId": media_id,
            "facesKey": key,
            "samples": len(samples),
            "samplesWithFaces": with_faces,
        },
        usage=JobUsage(
            media_seconds=duration_s, provider="worker-ai/faces", cost_minor=0, actual_tenths=0
        ),
    )
