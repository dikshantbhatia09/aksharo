"""One HTTP client for every vendor adapter: retries, backoff and error mapping.

A09 wrote this logic inline in ``serverless_whisper.py``; A10 adds three more
vendors and the rules have to be identical across all of them, so they live here
once. What the rules are, and why:

* **429 and 5xx are retryable, other 4xx are not.** A rate limit or a bad gateway
  clears on its own; a rejected key or a malformed request does not, and retrying
  it burns the vendor's quota and A08's two job attempts for nothing.
* **``Retry-After`` is obeyed when the vendor sends one**, capped, because a
  vendor that says "come back in 30 s" and is asked again in 200 ms gets angrier.
* **Backoff is exponential with jitter.** Every chunk of a fan-out hits the same
  limit at the same instant; without jitter they all come back at the same
  instant too.
* **Nothing that could be a credential is ever logged or put in an exception
  message** (THREAT-MODEL T21). The adapters pass their key in a header this
  module owns, and the only thing that reaches a log line is the path and the
  status code.

Polling belongs here too: two of the three vendors are submit-and-poll (Sarvam
Batch, AssemblyAI async), and a poll loop that does not heartbeat is how a job
loses its BullMQ lock halfway through (A08b).
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Literal

import httpx2

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import ProviderError

__all__ = [
    "DEFAULT_MAX_ATTEMPTS",
    "DEFAULT_TIMEOUT_S",
    "MAX_RETRY_AFTER_S",
    "VendorHttp",
]

_log = get_logger(__name__)

#: Vendor batch jobs run for minutes; the read timeout has to outlast a poll.
DEFAULT_TIMEOUT_S = 600.0

#: Attempts per request, including the first.
DEFAULT_MAX_ATTEMPTS = 3

#: A vendor may ask for a long wait; we cap it so one 429 cannot hold a worker
#: past its lock (A08b) while pretending to be polite.
MAX_RETRY_AFTER_S = 30.0

Method = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]


class VendorHttp:
    """A small, retrying HTTP client bound to one vendor.

    ``client`` is injectable so every adapter test drives a
    :class:`httpx2.MockTransport` instead of a network — which is the only way
    these adapters can be tested at all, because no vendor key exists yet
    (A00-06).
    """

    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        headers: Mapping[str, str] | None = None,
        client: httpx2.AsyncClient | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self._headers = dict(headers or {})
        self._max_attempts = max(1, max_attempts)
        self._owns_client = client is None
        self._client = client or httpx2.AsyncClient(timeout=timeout_s)
        self._sleep = sleep

    async def aclose(self) -> None:
        """Close the client when this object created it. Idempotent."""
        if self._owns_client:
            await self._client.aclose()

    def url(self, path: str) -> str:
        """Absolute URL for ``path``; an absolute ``path`` is returned unchanged.

        Vendors hand back absolute URLs for uploads and downloads (a signed blob
        URL, an upload target), and those must not be prefixed.
        """
        if path.startswith(("http://", "https://")):
            return path
        return self.base_url + "/" + path.lstrip("/")

    async def json(
        self,
        method: Method,
        path: str,
        *,
        json_body: Any = None,
        data: Mapping[str, Any] | None = None,
        files: Any = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        """Send a request and parse a JSON **object** from the response."""
        response = await self.send(
            method,
            path,
            json_body=json_body,
            data=data,
            files=files,
            params=params,
            headers=headers,
        )
        try:
            parsed: Any = response.json()
        except ValueError as error:
            raise ProviderError(
                self.provider + " returned a body that is not JSON",
                provider=self.provider,
                retryable=False,
            ) from error
        if not isinstance(parsed, dict):
            raise ProviderError(
                self.provider + " returned a JSON value that is not an object",
                provider=self.provider,
                retryable=False,
            )
        return parsed

    async def content(
        self,
        method: Method,
        path: str,
        *,
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> bytes:
        """Send a request and return the raw body — blob upload and download."""
        response = await self.send(method, path, content=body, headers=headers)
        return response.content

    async def send(
        self,
        method: Method,
        path: str,
        *,
        json_body: Any = None,
        data: Mapping[str, Any] | None = None,
        files: Any = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        content: bytes | None = None,
    ) -> httpx2.Response:
        """The one place a vendor request is actually made.

        :raises ProviderError: mapped from the status code, with ``retryable``
            set per the rules in the module docstring.
        """
        url = self.url(path)
        merged = {**self._headers, **dict(headers or {})}
        last = "no attempt was made"

        for attempt in range(1, self._max_attempts + 1):
            wait: float | None = None
            try:
                response = await self._client.request(
                    method,
                    url,
                    json=json_body,
                    data=data,
                    files=files,
                    params=params,
                    headers=merged,
                    content=content,
                )
            except httpx2.HTTPError as error:
                last = type(error).__name__
            else:
                if response.status_code < 400:
                    return response
                last = "HTTP " + str(response.status_code)
                if not _retryable_status(response.status_code):
                    raise ProviderError(
                        self._describe(response.status_code, path),
                        provider=self.provider,
                        retryable=False,
                    )
                wait = _retry_after(response)

            if attempt < self._max_attempts:
                delay = wait if wait is not None else _backoff(attempt)
                _log.warning(
                    "vendor request failed, retrying",
                    extra={
                        "provider": self.provider,
                        "path": _safe_path(path),
                        "attempt": attempt,
                        "reason": last,
                        "delayS": round(delay, 2),
                    },
                )
                await self._sleep(delay)

        raise ProviderError(
            self.provider + " was unreachable after " + str(self._max_attempts) + " attempts "
            "(" + last + ")",
            provider=self.provider,
            retryable=True,
        )

    def _describe(self, status_code: int, path: str) -> str:
        """A message that names the failure without ever naming the credential."""
        if status_code in (401, 403):
            return (
                self.provider + " rejected the credential (" + str(status_code) + "); "
                "check the key and the account's entitlements"
            )
        if status_code == 404:
            return self.provider + " has no " + _safe_path(path) + " endpoint (404)"
        if status_code == 413:
            return self.provider + " refused the audio as too large (413)"
        return self.provider + " refused the request (" + str(status_code) + ")"

    async def poll(
        self,
        *,
        check: Callable[[], Awaitable[tuple[bool, dict[str, Any]]]],
        interval_s: float,
        timeout_s: float,
        on_wait: Callable[[float], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        """Call ``check`` until it reports done, or give up.

        ``check`` returns ``(done, payload)``. ``on_wait`` is the caller's
        heartbeat: ``ai.transcribe`` beats its BullMQ lock from here, because a
        Sarvam batch job can sit in ``Pending`` for minutes (`09 §9`).
        """
        waited = 0.0
        while True:
            done, payload = await check()
            if done:
                return payload
            if waited >= timeout_s:
                raise ProviderError(
                    self.provider + " did not finish within " + str(int(timeout_s)) + "s",
                    provider=self.provider,
                    # The vendor is alive and slow; A08 decides whether to retry.
                    retryable=True,
                )
            if on_wait is not None:
                await on_wait(waited)
            await self._sleep(interval_s)
            waited += interval_s


def _retryable_status(status_code: int) -> bool:
    """429 and 5xx clear on their own; every other 4xx is a permanent answer."""
    return status_code == 429 or status_code >= 500


def _retry_after(response: httpx2.Response) -> float | None:
    """``Retry-After`` in seconds, capped; ``None`` when absent or unparseable."""
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    try:
        seconds = float(raw.strip())
    except ValueError:
        # The HTTP-date form is legal but rare; backing off normally is safer
        # than parsing a date we would then have to trust.
        return None
    return min(max(seconds, 0.0), MAX_RETRY_AFTER_S)


def _backoff(attempt: int) -> float:
    """Exponential with full jitter on the upper half, capped at 8 s."""
    ceiling = min(2.0 ** (attempt - 1), 8.0)
    return ceiling * (0.5 + random.random() / 2)  # noqa: S311 - jitter, not crypto


def _safe_path(path: str) -> str:
    """A path with any query string removed, so a signed URL never reaches a log."""
    return path.split("?", 1)[0]
