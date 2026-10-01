"""Sarvam's text-to-speech API (``bulbul``), as ``ai.voiceover`` uses it (2026-10-01).

The wire contract, taken from Sarvam's published API reference on 2026-10-01
and NOT yet checked against the account (no live call has been made; the
first real voice-over is the check)::

    POST {base}/text-to-speech
         {text, target_language_code, speaker, pace, model,
          speech_sample_rate, enable_preprocessing}
      -> {"request_id": "...", "audios": ["<base64 WAV>"]}       422 on a bad body

Every call carries ``api-subscription-key``. It is ONE synchronous call: there
is no vendor job to resume or cancel, which is why the processor's only
idempotency guard is its own checkpoint (``processors/voiceover.py``).

Price (published, 2026-10-01): ₹15 per 10,000 characters for ``bulbul:v2``,
billed on the characters sent. A hook is at most 300 characters, so one
voice-over is under half a rupee; the API's daily budget still counts it.

Errors map onto what a retry can change, as the dubbing client's do: 429, 5xx
and a broken connection are retried here with backoff and then reported
retryable; 401/403 is the key (``voiceover/vendor_auth``), any other 4xx is the
vendor refusing the request (``voiceover/vendor_refused``) with its own words.
Nothing that could be the key reaches a log line or an exception.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import random
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Final

import httpx2

from worker_ai.logging_setup import get_logger

__all__ = [
    "SARVAM_TTS_DEFAULT_BASE_URL",
    "VENDOR_PAISE_PER_10K_CHARACTERS",
    "SarvamSpeechClient",
    "SpeechVendorError",
    "SynthesisedSpeech",
    "vendor_paise",
]

_log = get_logger(__name__)

SARVAM_TTS_DEFAULT_BASE_URL: Final[str] = "https://api.sarvam.ai"

#: ₹15 per 10,000 characters (``bulbul:v2``, published 2026-10-01), in paise.
VENDOR_PAISE_PER_10K_CHARACTERS: Final[int] = 1_500

_MAX_RETRY_AFTER_S: Final[float] = 30.0
_MESSAGE_MAX: Final[int] = 300

Sleep = Callable[[float], Awaitable[None]]


def vendor_paise(characters: int) -> int:
    """What the vendor charges for ``characters`` characters, rounded up to a paisa."""
    return -(-max(0, characters) * VENDOR_PAISE_PER_10K_CHARACTERS // 10_000)


class SpeechVendorError(Exception):
    """A call the vendor refused or could not answer.

    ``code`` is the product's (``voiceover/...``); ``message`` is safe to show
    a person (the vendor's own words for a refusal, never the key).
    """

    def __init__(
        self, code: str, message: str, *, retryable: bool, status_code: int | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class SynthesisedSpeech:
    """The vendor's answer: the WAV bytes and its request id (for the operator)."""

    audio: bytes
    request_id: str | None


class SarvamSpeechClient:
    """One vendor, one call. ``client`` and ``sleep`` are injectable for tests."""

    name: Final = "sarvam"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = SARVAM_TTS_DEFAULT_BASE_URL,
        client: httpx2.AsyncClient | None = None,
        timeout_s: float = 60.0,
        max_attempts: int = 3,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("SarvamSpeechClient needs SARVAM_API_KEY")
        self._api_key = api_key
        self.base_url = (base_url or SARVAM_TTS_DEFAULT_BASE_URL).rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx2.AsyncClient(timeout=timeout_s)
        self._max_attempts = max(1, max_attempts)
        self.sleep = sleep

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def synthesise(
        self,
        *,
        text: str,
        language: str,
        speaker: str,
        pace: float,
        model: str,
        sample_rate: int,
    ) -> SynthesisedSpeech:
        """``POST /text-to-speech``: one WAV for ``text``.

        :raises SpeechVendorError: when the vendor refuses, cannot be reached,
            or answers with something that is not one decodable audio file.
        """
        body: dict[str, Any] = {
            "text": text,
            "target_language_code": language,
            "speaker": speaker,
            "pace": pace,
            "model": model,
            "speech_sample_rate": sample_rate,
            # Numbers, dates and abbreviations read the way a person says them.
            "enable_preprocessing": True,
        }
        response = await self._post("/text-to-speech", body)
        try:
            payload = response.json()
        except ValueError as error:
            raise SpeechVendorError(
                "voiceover/vendor_unavailable",
                "Sarvam answered with something that is not JSON.",
                retryable=True,
            ) from error
        audios = payload.get("audios") if isinstance(payload, dict) else None
        if not isinstance(audios, list) or len(audios) == 0 or not isinstance(audios[0], str):
            raise SpeechVendorError(
                "voiceover/vendor_unavailable",
                "Sarvam's answer had no audio in it.",
                retryable=True,
            )
        try:
            audio = base64.b64decode(audios[0], validate=True)
        except (binascii.Error, ValueError) as error:
            raise SpeechVendorError(
                "voiceover/vendor_unavailable",
                "Sarvam's audio could not be decoded.",
                retryable=True,
            ) from error
        request_id = payload.get("request_id")
        return SynthesisedSpeech(
            audio=audio,
            request_id=request_id if isinstance(request_id, str) else None,
        )

    async def _post(self, path: str, body: dict[str, Any]) -> httpx2.Response:
        headers = {
            "api-subscription-key": self._api_key,
            "accept": "application/json",
            "content-type": "application/json",
        }
        content = json.dumps(body).encode("utf-8")
        last = "no attempt was made"
        for attempt in range(1, self._max_attempts + 1):
            wait: float | None = None
            try:
                response = await self._client.request(
                    "POST", f"{self.base_url}{path}", headers=headers, content=content
                )
            except httpx2.HTTPError as error:
                last = type(error).__name__
            else:
                status = response.status_code
                if status < 400:
                    return response
                last = f"HTTP {status}"
                if status in (401, 403):
                    raise SpeechVendorError(
                        "voiceover/vendor_auth",
                        f"Sarvam refused the API key ({status}).",
                        retryable=False,
                        status_code=status,
                    )
                if status != 429 and status < 500:
                    raise SpeechVendorError(
                        "voiceover/vendor_refused",
                        _vendor_message(response),
                        retryable=False,
                        status_code=status,
                    )
                wait = _retry_after(response)
            if attempt < self._max_attempts:
                delay = wait if wait is not None else _backoff(attempt)
                _log.warning(
                    "speech vendor request failed, retrying",
                    extra={"path": path, "attempt": attempt, "reason": last, "delayS": delay},
                )
                await self.sleep(delay)
        raise SpeechVendorError(
            "voiceover/vendor_unavailable",
            f"Sarvam could not be reached ({last}). The voice-over is tried again.",
            retryable=True,
        )


def _vendor_message(response: httpx2.Response) -> str:
    """The vendor's own words for a refusal: short and printable."""
    try:
        body = response.json()
    except ValueError:
        return f"The request was refused ({response.status_code})."
    if isinstance(body, dict):
        for key in ("message", "detail", "error"):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return _clean(value)
            if isinstance(value, dict):
                inner = value.get("message")
                if isinstance(inner, str) and inner.strip():
                    return _clean(inner)
    return f"The request was refused ({response.status_code})."


def _clean(text: str) -> str:
    printable = "".join(ch if ch.isprintable() else " " for ch in text)
    return " ".join(re.sub(r"(https?://[^\s?]+)\?\S*", r"\1", printable).split())[:_MESSAGE_MAX]


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
