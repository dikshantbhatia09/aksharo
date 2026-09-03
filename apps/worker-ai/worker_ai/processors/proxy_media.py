"""Shared 540p-proxy download for processors that sample the proxy directly
(D04d) rather than relying on producer-supplied statistics.

Factored out of `reframe_zoom_pass.py`'s `_sample_from_proxy` (B19b) so a
second processor — `sfx_pass.py` (D04d), which only needs the audio track,
not decoded video frames — does not have to re-derive the same download
boilerplate (project id resolution, the `derived_store` DI check, the
`StorageError` -> `JobFailureError` translation). Both processors call
:func:`download_proxy`; `reframe_zoom_pass.py` then samples frames and RMS
from the returned path, `sfx_pass.py` samples RMS only.
"""

from __future__ import annotations

from pathlib import Path

from worker_ai.processors.context import JobContext, JobFailureError
from worker_ai.storage import DerivedArtefact, StorageError, derived_key

__all__ = ["download_proxy"]


async def download_proxy(
    context: JobContext, *, filename: DerivedArtefact = "proxy540.mp4"
) -> Path:
    """Download the job's 540p proxy (CONTRACTS §6) into the job's workdir.

    Raises `JobFailureError` (`worker/invalid_payload`, non-retryable) when
    the payload carries no resolvable project id, `worker/storage_unconfigured`
    (non-retryable) when the worker has no derived-store credentials, and
    `worker/storage_unavailable` (retryable) when the download itself fails —
    the API producer is expected to have already rejected a project with no
    proxy, so reaching this function without one means the media row changed
    underneath the job.
    """
    project_id = context.payload_str("projectId") or (context.envelope.project_id or "")
    media_id = context.payload_str("mediaId", required=True)
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
        key = derived_key(context.envelope.workspace_id, project_id, media_id, filename)
        destination = context.workdir / filename
        store.download(key, destination)
    except StorageError as error:
        raise JobFailureError("worker/storage_unavailable", str(error), retryable=True) from error
    return destination
