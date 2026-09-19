"""Signed worker → API callbacks (``docs/CONTRACTS.md`` section 3).

```
POST {API_ORIGIN}/internal/jobs/{jobId}/progress  {progress, etaMs?, message?}
POST {API_ORIGIN}/internal/jobs/{jobId}/complete  {status, result?, error?, usage?}

X-Montaj-Attempt:   <attemptId>
X-Montaj-Timestamp: <unix seconds>
X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))
```

Three things matter and all three are easy to get wrong:

1. **The signature covers the exact bytes that go on the wire.** ``json.dumps`` and
   ``JSON.stringify`` disagree on separators, so this module serialises once, signs
   those bytes, and posts those same bytes — never a re-encoding.
2. **The worker signs with the primary secret only.** ``INTERNAL_CALLBACK_SECRET_NEXT``
   is the API's *verification* key during a rotation; a worker is rolled onto the
   new secret by restarting it with a new ``INTERNAL_CALLBACK_SECRET``
   (``internal-signature.ts``).
3. **Delivery is at-least-once.** Retries are safe because the API is idempotent on
   ``(jobId, attemptId)``: a replay answers 200 with ``applied: false``, which this
   client reports rather than treating as a failure.

``X-Montaj-*`` uses the engineering codename, which is correct for a wire header
(CONTRACTS section 0 covers user-visible strings).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import random
import time
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Literal, Self

import httpx2

from worker_ai.logging_setup import get_logger

__all__ = [
    "ATTEMPT_HEADER",
    "SIGNATURE_HEADER",
    "TIMESTAMP_HEADER",
    "CallbackAck",
    "CallbackClient",
    "CallbackError",
    "JobCompletion",
    "JobError",
    "JobUsage",
    "encode_body",
    "sign_request",
    "signature_headers",
]

_log = get_logger(__name__)

ATTEMPT_HEADER = "X-Montaj-Attempt"
TIMESTAMP_HEADER = "X-Montaj-Timestamp"
SIGNATURE_HEADER = "X-Montaj-Signature"

#: The API rejects anything outside five minutes either side (CONTRACTS section 3),
#: so a callback that has been retrying for longer than this can never be accepted.
SIGNATURE_SKEW_S = 5 * 60

_DEFAULT_TIMEOUT_S = 15.0
_DEFAULT_MAX_ATTEMPTS = 4
_DEFAULT_BACKOFF_S = 0.5


def encode_body(payload: dict[str, Any]) -> bytes:
    """Serialise a callback body to the exact bytes that will be signed and sent.

    ``separators`` matches ``JSON.stringify``; ``allow_nan=False`` because ``NaN``
    is not JSON and the API's Zod schema would reject it after a confusing trip
    through the wire.
    """
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode(
        "utf-8"
    )


def sign_request(secret: str, timestamp: int | str, body: bytes) -> str:
    """``hex(hmac_sha256(secret, timestamp + "." + body))``."""
    mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
    mac.update(f"{timestamp}.".encode())
    mac.update(body)
    return mac.hexdigest()


def signature_headers(
    *, secret: str, attempt_id: str, body: bytes, now: float | None = None
) -> dict[str, str]:
    """Headers a signed internal request needs, ready to hand to httpx."""
    timestamp = int(now if now is not None else time.time())
    return {
        "content-type": "application/json",
        ATTEMPT_HEADER: attempt_id,
        TIMESTAMP_HEADER: str(timestamp),
        SIGNATURE_HEADER: sign_request(secret, timestamp, body),
    }


@dataclass(frozen=True, slots=True)
class CallbackAck:
    """The API's reply, shared by both callbacks.

    ``applied`` is ``False`` for a replay or a superseded attempt. That is a
    success for the worker: the state the callback describes is already recorded.
    """

    applied: bool
    job_id: str
    status: str
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class JobUsage:
    """``usage`` on the completion body — what the job actually consumed."""

    media_seconds: float | None = None
    output_seconds: float | None = None
    provider: str | None = None
    model: str | None = None
    cost_minor: int | None = None
    egress_bytes: int | None = None
    actual_tenths: int | None = None
    #: True when at least one chunk was served from the `09 §1` result cache, so
    #: the API knows not to count this job as a fresh vendor charge.
    cached: bool | None = None

    def to_wire(self) -> dict[str, Any]:
        """Camel-case JSON with every unset field omitted."""
        wire: dict[str, Any] = {}
        if self.media_seconds is not None:
            wire["mediaSeconds"] = round(self.media_seconds, 3)
        if self.output_seconds is not None:
            wire["outputSeconds"] = round(self.output_seconds, 3)
        if self.provider is not None:
            wire["provider"] = self.provider
        if self.model is not None:
            wire["model"] = self.model
        if self.cost_minor is not None:
            wire["costMinor"] = int(self.cost_minor)
        if self.egress_bytes is not None:
            wire["egressBytes"] = int(self.egress_bytes)
        if self.actual_tenths is not None:
            wire["actualTenths"] = int(self.actual_tenths)
        if self.cached is not None:
            wire["cached"] = bool(self.cached)
        return wire


@dataclass(frozen=True, slots=True)
class JobError:
    """``error`` on a failed completion. ``retryable=False`` dead-letters the job."""

    code: str
    message: str
    retryable: bool = True

    def to_wire(self) -> dict[str, Any]:
        return {
            "code": self.code[:128],
            "message": self.message[:2000] or "failed",
            "retryable": self.retryable,
        }


@dataclass(frozen=True, slots=True)
class JobCompletion:
    """The completion body of CONTRACTS section 3."""

    status: Literal["succeeded", "failed"]
    result: dict[str, Any] | None = None
    error: JobError | None = None
    usage: JobUsage | None = None
    #: True when BullMQ has no attempts left; A08b reads it to fill the DLQ table.
    final_attempt: bool | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {"status": self.status}
        if self.result is not None:
            wire["result"] = self.result
        if self.error is not None:
            wire["error"] = self.error.to_wire()
        if self.usage is not None:
            usage = self.usage.to_wire()
            if usage:
                wire["usage"] = usage
        if self.final_attempt is not None:
            wire["finalAttempt"] = self.final_attempt
        return wire


class CallbackError(RuntimeError):
    """The API refused a callback, or was unreachable for every attempt."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class CallbackClient:
    """Posts signed progress and completion callbacks, with bounded retries.

    Retries cover the transport and the API's 5xx and 429 only. A 4xx is a
    contract error — a bad signature, an unknown job, a body the API's schema
    rejects — and retrying it would just burn the five-minute signature window.
    """

    def __init__(
        self,
        api_origin: str,
        secret: str,
        *,
        client: httpx2.AsyncClient | None = None,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        max_attempts: int = _DEFAULT_MAX_ATTEMPTS,
        backoff_s: float = _DEFAULT_BACKOFF_S,
    ) -> None:
        if not secret:
            raise ValueError("INTERNAL_CALLBACK_SECRET is required to sign callbacks")
        self._origin = api_origin.rstrip("/")
        self._secret = secret
        self._max_attempts = max(1, max_attempts)
        self._backoff_s = backoff_s
        self._owns_client = client is None
        self._client = client or httpx2.AsyncClient(timeout=timeout_s)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the HTTP client when this instance created it."""
        if self._owns_client:
            await self._client.aclose()

    async def progress(
        self,
        job_id: str,
        attempt_id: str,
        progress: float,
        *,
        eta_ms: int | None = None,
        message: str | None = None,
    ) -> CallbackAck:
        """``POST /internal/jobs/{jobId}/progress``. Also flips the row to running."""
        body: dict[str, Any] = {"progress": max(0.0, min(100.0, round(progress, 2)))}
        if eta_ms is not None:
            body["etaMs"] = max(0, int(eta_ms))
        if message is not None:
            body["message"] = message[:1000]
        return await self._post(f"/internal/jobs/{job_id}/progress", attempt_id, body)

    async def complete(
        self, job_id: str, attempt_id: str, completion: JobCompletion
    ) -> CallbackAck:
        """``POST /internal/jobs/{jobId}/complete``. Safe to replay."""
        return await self._post(
            f"/internal/jobs/{job_id}/complete", attempt_id, completion.to_wire()
        )

    async def write_transcript_scripts(
        self, transcript_id: str, attempt_id: str, payload: dict[str, Any]
    ) -> CallbackAck:
        """``POST /internal/transcripts/{id}/scripts`` — A22's ``ai.transliterate`` write.

        A word-level write, not a job-completion one: `TransliterateCompletionHandler`
        only settles credits and logs the job event, so this call carries the actual
        `word.scripts` merge (A22's transcripts/scripts module) and happens *before*
        the job is completed, exactly like a `media.probe` completion patches
        `/internal/media/{id}` before it calls `complete`.
        """
        return await self._post(
            f"/internal/transcripts/{transcript_id}/scripts", attempt_id, payload
        )

    async def apply_edg_ops(
        self, project_id: str, attempt_id: str, payload: dict[str, Any]
    ) -> CallbackAck:
        """``POST /internal/projects/{id}/edg/ops`` — the worker's signed EDG write path.

        A22's ``ai.translate`` submits a `SetSegmentText` batch here (`source:
        "worker"` is implied by the signature, never sent on the wire — CONTRACTS
        section 2, `apps/api/src/edg/edg-internal.controller.ts`). Any other queue
        that ever needs `MergePass` or another worker-authored op batch calls the
        same method.
        """
        return await self._post(f"/internal/projects/{project_id}/edg/ops", attempt_id, payload)

    async def get_transcript_words(
        self, transcript_id: str, attempt_id: str, revision: int | None = None
    ) -> dict[str, Any]:
        """Fetch transcript words from ``POST /internal/transcripts/{id}/words``."""
        payload = {"revision": revision} if revision is not None else {}
        body = encode_body(payload)
        url = f"{self._origin}/internal/transcripts/{transcript_id}/words"
        for attempt in range(1, self._max_attempts + 1):
            headers = signature_headers(secret=self._secret, attempt_id=attempt_id, body=body)
            try:
                response = await self._client.post(url, content=body, headers=headers)
                if response.status_code < 400:
                    data = response.json()
                    return data if isinstance(data, dict) else {}
                if response.status_code < 500 and response.status_code != 429:
                    raise CallbackError(
                        f"get_transcript_words rejected with {response.status_code}",
                        status_code=response.status_code,
                    )
            except httpx2.HTTPError as error:
                _log.warning(
                    "get_transcript_words transport failure",
                    extra={"attempt": attempt, "reason": str(error)},
                )
            if attempt < self._max_attempts:
                await asyncio.sleep(self._delay_for(attempt))
        raise CallbackError(f"get_transcript_words failed after {self._max_attempts} attempts")

    async def _post(self, path: str, attempt_id: str, payload: dict[str, Any]) -> CallbackAck:
        body = encode_body(payload)
        url = f"{self._origin}{path}"
        last_error: Exception | None = None

        for attempt in range(1, self._max_attempts + 1):
            # Re-signed per attempt: a retry after a long backoff must not carry a
            # timestamp the API has already aged out of its five-minute window.
            headers = signature_headers(secret=self._secret, attempt_id=attempt_id, body=body)
            try:
                response = await self._client.post(url, content=body, headers=headers)
            except httpx2.HTTPError as error:  # transport, DNS, timeout
                last_error = error
                _log.warning(
                    "callback transport failure",
                    extra={"path": path, "attempt": attempt, "reason": type(error).__name__},
                )
            else:
                if response.status_code < 400:
                    return _ack(response)
                if response.status_code < 500 and response.status_code != 429:
                    raise CallbackError(
                        f"{path} rejected with {response.status_code}",
                        status_code=response.status_code,
                    )
                last_error = CallbackError(
                    f"{path} answered {response.status_code}",
                    status_code=response.status_code,
                )
                _log.warning(
                    "callback rejected, will retry",
                    extra={"path": path, "attempt": attempt, "status": response.status_code},
                )

            if attempt < self._max_attempts:
                await asyncio.sleep(self._delay_for(attempt))

        raise CallbackError(f"{path} failed after {self._max_attempts} attempts: {last_error}")

    def _delay_for(self, attempt: int) -> float:
        """Exponential backoff with jitter, capped inside the signature window."""
        base: float = min(self._backoff_s * float(2 ** (attempt - 1)), 30.0)
        # Jitter spreads retries across workers; it is not a security value.
        jitter: float = 0.5 + random.random() / 2  # noqa: S311
        return base * jitter


def _ack(response: httpx2.Response) -> CallbackAck:
    """Read the API's ``CallbackAck``, tolerating a body it did not send."""
    try:
        parsed = response.json()
    except ValueError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    reason = parsed.get("reason")
    return CallbackAck(
        applied=bool(parsed.get("applied", True)),
        job_id=str(parsed.get("jobId", "")),
        status=str(parsed.get("status", "")),
        reason=str(reason) if isinstance(reason, str) else None,
    )
