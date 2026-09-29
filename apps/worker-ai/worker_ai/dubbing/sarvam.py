"""Sarvam's Dubbing API (Beta), as ``ai.dub`` uses it (2026-10-04).

The wire contract, researched and checked against the account on 2026-09-29
(an unknown job id answers 404 ``{"status":"error","message":"Job not found",
"code":"NotFoundError"}``, so the key is accepted; a bad key answers 401
``{"detail":"Invalid API key"}``)::

    POST {base}/dubbing/jobs
         {src_lang, target_langs[], export_options[], voice_cloning, num_speakers,
          disable_watermark, editor_flow, job_name}
      -> {"status":"success","data":{"job_id","upload_url","expires_in_hours",
          "processing_started","voice_cloning", ...}}                 422 on a bad body
    PUT  {upload_url}          Content-Type: video/mp4, x-ms-blob-type: BlockBlob
    POST {base}/dubbing/jobs/{job_id}/start
    GET  {base}/dubbing/jobs/{job_id}/live-status
      -> {"data":{"status": not_started|queued|in_progress|completed|
                             partial_failure|failed|deleted,
                  "progress": 0-100, "current_step_label", "error_message"}}
    GET  {base}/dubbing/jobs/{job_id}/export-status?limit=n        (max 100)
      -> {"data":{"exports":[{"id","target_language","export_type":"video|audio|srt",
                              "status":"in_progress|completed|failed","is_stale",
                              "created_at","completed_at","download_url"?}]}}
    POST {base}/dubbing/jobs/{job_id}/cancel

Every call carries ``api-subscription-key``. The two signed URLs - the upload
target and each export's ``download_url`` (an Azure blob with a SAS token, good
for about a day, never cached) - are NOT Sarvam's API, and never receive the
key: a signed URL is its own credential. They must be ``https`` on a named host,
never an address, since they come from a response rather than from us.

Price: ₹40 per minute of source per target language. ``editor_flow: true``
doubles it, so it is always sent ``false``; ``disable_watermark`` is always
``true``. Cloning a voice needs the speaker's consent: the API records it
before it ever enqueues a dub.

Errors map onto what a retry can change: 429, 5xx and a broken connection are
retried here with backoff and then reported retryable; a 401/403 is the key
(``dub/vendor_auth``), any other 4xx is the vendor refusing the request
(``dub/vendor_refused``) with its own words; a 404 on a job is "no such job".
Nothing that could be the key, and no signed URL's query string, reaches a log
line or an exception.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import random
import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal
from urllib.parse import urlsplit

import httpx2

from worker_ai.logging_setup import get_logger

__all__ = [
    "DUBBING_FAILED",
    "DUBBING_FINISHED",
    "SARVAM_DUBBING_DEFAULT_BASE_URL",
    "CreatedDubJob",
    "DownloadedFile",
    "DubExport",
    "DubLiveStatus",
    "DubbingVendorError",
    "SarvamDubbingClient",
]

_log = get_logger(__name__)

SARVAM_DUBBING_DEFAULT_BASE_URL: Final[str] = "https://api.sarvam.ai"

#: Vendor statuses that end a job with something to collect, and with nothing.
DUBBING_FINISHED: Final = frozenset({"completed", "partial_failure"})
DUBBING_FAILED: Final = frozenset({"failed", "deleted"})

#: A vendor's "come back later" is honoured up to this, so one 429 cannot hold a
#: worker past its lock while pretending to be polite.
_MAX_RETRY_AFTER_S: Final[float] = 30.0
_UPLOAD_CHUNK: Final[int] = 1024 * 1024
#: Words a vendor's refusal is cut to before anyone reads them.
_MESSAGE_MAX: Final[int] = 300

Sleep = Callable[[float], Awaitable[None]]


class DubbingVendorError(Exception):
    """A call the vendor refused or could not answer.

    ``code`` is the product's (``dub/...``), ``message`` is safe to show a
    person (the vendor's own words for a refusal, never a key or a signed URL).
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class CreatedDubJob:
    job_id: str
    upload_url: str
    expires_in_hours: float | None
    processing_started: bool


@dataclass(frozen=True, slots=True)
class DubLiveStatus:
    status: str
    progress: float | None
    step: str | None
    error_message: str | None


@dataclass(frozen=True, slots=True)
class DubExport:
    id: str
    language: str
    export_type: str
    status: str
    is_stale: bool
    download_url: str | None
    completed_at: str


@dataclass(frozen=True, slots=True)
class DownloadedFile:
    size_bytes: int
    content_type: str | None


class SarvamDubbingClient:
    """One vendor, six calls. ``client`` and ``sleep`` are injectable for tests.

    The timings live here too, so the processor's loops and this client's
    retries both wait through the same ``sleep``: a test runs a two-hour poll in
    milliseconds, and nothing in production sleeps a different way.
    """

    name: Final = "sarvam"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = SARVAM_DUBBING_DEFAULT_BASE_URL,
        client: httpx2.AsyncClient | None = None,
        timeout_s: float = 300.0,
        max_attempts: int = 3,
        sleep: Sleep = asyncio.sleep,
        poll_interval_s: float = 15.0,
        poll_timeout_s: float = 2 * 60 * 60.0,
        export_interval_s: float = 10.0,
        export_timeout_s: float = 20 * 60.0,
    ) -> None:
        if not api_key:
            raise ValueError("SarvamDubbingClient needs SARVAM_API_KEY")
        self._api_key = api_key
        self.base_url = (base_url or SARVAM_DUBBING_DEFAULT_BASE_URL).rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx2.AsyncClient(timeout=timeout_s)
        self._max_attempts = max(1, max_attempts)
        self.sleep = sleep
        self.poll_interval_s = poll_interval_s
        self.poll_timeout_s = poll_timeout_s
        self.export_interval_s = export_interval_s
        self.export_timeout_s = export_timeout_s

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # -- the vendor's six calls -------------------------------------------

    async def create_job(
        self,
        *,
        source_language: str,
        target_languages: list[str],
        speakers: int,
        job_name: str,
    ) -> CreatedDubJob:
        """``POST /dubbing/jobs``: audio and SRT back, the speaker's voice, no watermark."""
        body: dict[str, Any] = {
            "src_lang": source_language,
            "target_langs": list(target_languages),
            "export_options": ["audio", "srt"],
            "voice_cloning": True,
            "num_speakers": speakers,
            "disable_watermark": True,
            # True doubles the price, for an editor this product does not use.
            "editor_flow": False,
            "job_name": job_name[:100],
        }
        data = _data_of(await self._api("POST", "/dubbing/jobs", json_body=body))
        job_id = data.get("job_id")
        upload_url = data.get("upload_url")
        if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
            raise DubbingVendorError(
                "dub/vendor_unavailable",
                "Sarvam did not return a usable job id.",
                retryable=True,
            )
        if not isinstance(upload_url, str):
            raise DubbingVendorError(
                "dub/vendor_unavailable",
                "Sarvam did not return an upload address for the video.",
                retryable=True,
            )
        expires = data.get("expires_in_hours")
        return CreatedDubJob(
            job_id=job_id,
            upload_url=_signed_url(upload_url),
            expires_in_hours=float(expires) if isinstance(expires, int | float) else None,
            processing_started=data.get("processing_started") is True,
        )

    async def upload(self, upload_url: str, path: Path, *, content_type: str) -> None:
        """``PUT`` the video to the job's signed blob URL, streamed, never with the key."""
        url = _signed_url(upload_url)
        size = await asyncio.to_thread(lambda: path.stat().st_size)
        headers = {
            "content-type": content_type,
            "x-ms-blob-type": "BlockBlob",
            # Explicit, so the body streams without chunked encoding: a blob PUT
            # needs its length up front.
            "content-length": str(size),
        }

        async def body() -> AsyncIterator[bytes]:
            with path.open("rb") as handle:
                while chunk := handle.read(_UPLOAD_CHUNK):
                    yield chunk

        await self._send("PUT", url, headers=headers, content=body, signed=True)

    async def start(self, job_id: str) -> None:
        """``POST /dubbing/jobs/{id}/start``: from here the vendor may charge."""
        await self._api("POST", f"/dubbing/jobs/{_job(job_id)}/start")

    async def live_status(self, job_id: str) -> DubLiveStatus | None:
        """Where the job stands, or ``None`` when the vendor has no such job."""
        try:
            response = await self._api("GET", f"/dubbing/jobs/{_job(job_id)}/live-status")
        except _NotFoundError:
            return None
        data = _data_of(response)
        status = data.get("status")
        progress = data.get("progress")
        step = data.get("current_step_label")
        error = data.get("error_message")
        return DubLiveStatus(
            status=status.strip().lower() if isinstance(status, str) else "unknown",
            progress=float(progress) if isinstance(progress, int | float) else None,
            step=_clean(step, 120) if isinstance(step, str) and step.strip() else None,
            error_message=_clean(error, _MESSAGE_MAX) if isinstance(error, str) and error else None,
        )

    async def export_status(self, job_id: str, *, limit: int) -> list[DubExport]:
        """Every export the job has, newest first as the vendor lists them."""
        response = await self._api(
            "GET",
            f"/dubbing/jobs/{_job(job_id)}/export-status",
            params={"limit": max(1, min(100, limit))},
        )
        exports = _data_of(response).get("exports")
        found: list[DubExport] = []
        for entry in exports if isinstance(exports, list) else []:
            if not isinstance(entry, dict):
                continue
            url = entry.get("download_url")
            found.append(
                DubExport(
                    id=str(entry.get("id") or ""),
                    language=str(entry.get("target_language") or "").strip(),
                    export_type=str(entry.get("export_type") or "").strip().lower(),
                    status=str(entry.get("status") or "").strip().lower(),
                    is_stale=entry.get("is_stale") is True,
                    download_url=url if isinstance(url, str) and url else None,
                    completed_at=str(entry.get("completed_at") or ""),
                )
            )
        return found

    async def download(self, url: str, destination: Path, *, max_bytes: int) -> DownloadedFile:
        """Stream one export to ``destination``, refusing anything over ``max_bytes``."""
        signed = _signed_url(url)
        last = "no attempt was made"
        for attempt in range(1, self._max_attempts + 1):
            try:
                async with self._client.stream("GET", signed) as response:
                    if response.status_code >= 400:
                        last = f"HTTP {response.status_code}"
                        if not _retryable_status(response.status_code):
                            raise DubbingVendorError(
                                "dub/download_failed",
                                f"Sarvam's file could not be fetched ({response.status_code}).",
                                retryable=True,
                                status_code=response.status_code,
                            )
                    else:
                        declared = response.headers.get("content-length")
                        if (
                            declared is not None
                            and declared.isdigit()
                            and int(declared) > max_bytes
                        ):
                            raise DubbingVendorError(
                                "dub/download_too_large",
                                "A dubbed file came back larger than a clip's can be.",
                                retryable=False,
                            )
                        size = 0
                        with destination.open("wb") as handle:
                            async for chunk in response.aiter_bytes():
                                size += len(chunk)
                                if size > max_bytes:
                                    raise DubbingVendorError(
                                        "dub/download_too_large",
                                        "A dubbed file came back larger than a clip's can be.",
                                        retryable=False,
                                    )
                                handle.write(chunk)
                        return DownloadedFile(
                            size_bytes=size,
                            content_type=response.headers.get("content-type"),
                        )
            except httpx2.HTTPError as error:
                last = type(error).__name__
            if attempt < self._max_attempts:
                await self.sleep(_backoff(attempt))
        raise DubbingVendorError(
            "dub/download_failed",
            f"Sarvam's file could not be fetched ({last}).",
            retryable=True,
        )

    async def cancel(self, job_id: str) -> bool:
        """``POST /dubbing/jobs/{id}/cancel``. False: nothing was left to stop."""
        try:
            await self._api("POST", f"/dubbing/jobs/{_job(job_id)}/cancel")
        except _NotFoundError:
            return False
        except DubbingVendorError as error:
            # A job that already finished, failed or was cancelled refuses a
            # cancel; that is the outcome a cancel wants.
            if error.status_code is not None and 400 <= error.status_code < 500:
                return False
            raise
        return True

    # -- transport ---------------------------------------------------------

    async def _api(
        self,
        method: Literal["GET", "POST"],
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> httpx2.Response:
        headers = {"api-subscription-key": self._api_key, "accept": "application/json"}
        content: bytes | None = None
        if json_body is not None:
            headers["content-type"] = "application/json"
            content = json.dumps(dict(json_body)).encode("utf-8")
        return await self._send(
            method,
            f"{self.base_url}{path}",
            headers=headers,
            content=content,
            params=params,
            signed=False,
        )

    async def _send(
        self,
        method: Literal["GET", "POST", "PUT"],
        url: str,
        *,
        headers: dict[str, str],
        content: bytes | Callable[[], AsyncIterator[bytes]] | None = None,
        params: Mapping[str, Any] | None = None,
        signed: bool,
    ) -> httpx2.Response:
        """The one place a vendor request is made; ``signed`` URLs never get the key."""
        where = _safe_path(url)
        last = "no attempt was made"
        for attempt in range(1, self._max_attempts + 1):
            wait: float | None = None
            body = content() if callable(content) else content
            try:
                response = await self._client.request(
                    method, url, headers=headers, content=body, params=params
                )
            except httpx2.HTTPError as error:
                last = type(error).__name__
            else:
                status = response.status_code
                if status < 400:
                    return response
                last = f"HTTP {status}"
                if status == 404 and not signed:
                    raise _NotFoundError(where)
                if status in (401, 403) and not signed:
                    raise DubbingVendorError(
                        "dub/vendor_auth",
                        f"Sarvam refused the API key ({status}).",
                        retryable=False,
                        status_code=status,
                    )
                if not _retryable_status(status):
                    raise DubbingVendorError(
                        "dub/upload_failed" if signed else "dub/vendor_refused",
                        _vendor_message(response)
                        if not signed
                        else f"The video could not be handed to Sarvam ({status}).",
                        # A refused upload is the address's fault (expired,
                        # say), and a new job gets a new one.
                        retryable=signed,
                        status_code=status,
                    )
                wait = _retry_after(response)
            if attempt < self._max_attempts:
                delay = wait if wait is not None else _backoff(attempt)
                _log.warning(
                    "dubbing vendor request failed, retrying",
                    extra={"path": where, "attempt": attempt, "reason": last, "delayS": delay},
                )
                await self.sleep(delay)
        raise DubbingVendorError(
            "dub/vendor_unavailable",
            f"Sarvam could not be reached ({last}). The dub is tried again.",
            retryable=True,
        )


class _NotFoundError(Exception):
    """The vendor has no such job (404)."""


def _data_of(response: httpx2.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError as error:
        raise DubbingVendorError(
            "dub/vendor_unavailable",
            "Sarvam answered with something that is not JSON.",
            retryable=True,
        ) from error
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise DubbingVendorError(
            "dub/vendor_unavailable", "Sarvam's answer had no data in it.", retryable=True
        )
    return data


def _vendor_message(response: httpx2.Response) -> str:
    """The vendor's own words for a refusal: short, printable, never a URL's query."""
    try:
        body = response.json()
    except ValueError:
        return f"The request was refused ({response.status_code})."
    if isinstance(body, dict):
        for key in ("message", "detail", "error"):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return _clean(value, _MESSAGE_MAX)
            if isinstance(value, dict):
                inner = value.get("message")
                if isinstance(inner, str) and inner.strip():
                    return _clean(inner, _MESSAGE_MAX)
            if isinstance(value, list):
                # FastAPI's 422: [{"loc": [...], "msg": "..."}]
                parts = [
                    f"{'.'.join(str(p) for p in item.get('loc', [])[1:])}: {item.get('msg')}"
                    for item in value
                    if isinstance(item, dict) and isinstance(item.get("msg"), str)
                ]
                if parts:
                    return _clean("; ".join(parts), _MESSAGE_MAX)
    return f"The request was refused ({response.status_code})."


def _clean(text: str, limit: int) -> str:
    """One line of printable text, signed-URL query strings removed, cut to ``limit``."""
    printable = "".join(ch if ch.isprintable() else " " for ch in text)
    without_queries = re.sub(r"(https?://[^\s?]+)\?\S*", r"\1", printable)
    return " ".join(without_queries.split())[:limit]


def _job(job_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
        raise DubbingVendorError(
            "dub/vendor_unavailable", "A vendor job id was not an id.", retryable=False
        )
    return job_id


def _signed_url(url: str) -> str:
    """A vendor-given URL, held to ``https`` on a named host before anything is sent to it."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    named = bool(host) and host != "localhost" and not host.endswith(".localhost")
    if named:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            named = False
    if parts.scheme != "https" or not named:
        raise DubbingVendorError(
            "dub/vendor_unavailable",
            "Sarvam gave a file address this worker will not use.",
            retryable=False,
        )
    return url


def _safe_path(url: str) -> str:
    """Scheme, host and path only: a signed URL's query is its credential."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def _retryable_status(status: int) -> bool:
    return status == 429 or status >= 500


def _retry_after(response: httpx2.Response) -> float | None:
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    try:
        seconds = float(raw.strip())
    except ValueError:
        return None
    return min(max(seconds, 0.0), _MAX_RETRY_AFTER_S)


def _backoff(attempt: int) -> float:
    ceiling = min(2.0 ** (attempt - 1), 8.0)
    return ceiling * (0.5 + random.random() / 2)  # noqa: S311 - jitter, not crypto
