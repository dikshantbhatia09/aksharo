"""Whisper ``large-v3-turbo`` on a per-second serverless GPU (decision **D15**).

The production global lane. The GPU side is a container that exposes one HTTP
endpoint; this adapter is the client, and the contract between them is small
enough to state here in full:

```
POST {GPU_PROVIDER_URL}/transcribe
Authorization: Bearer {GPU_PROVIDER_TOKEN}      (when configured)
{ "audio": "<https url or base64 wav>", "language": "hi", "wordTimestamps": true,
  "hints": ["..."], "model": "large-v3-turbo" }

200 { "language": "hi", "languageProbability": 0.98, "durationS": 41.2,
      "model": "large-v3-turbo",
      "words": [{ "start": 0.12, "end": 0.44, "word": "toh", "probability": 0.94 }],
      "segments": [{ "start": 0.0, "end": 4.1, "text": "..." }] }
```

Times on the wire are **seconds**, because that is what every ASR stack emits;
they become integer milliseconds here and nowhere else. ``segments`` is optional
and only used when the endpoint returns no word timings, in which case the caller
routes the result through the alignment registry (`09 §2`).

A08's retry policy already retries `ai.*` jobs, so this adapter retries only what
is cheap and obviously transient (429 and 5xx) and lets everything else surface.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx2

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderCapabilities,
    ProviderError,
    ProviderSubmission,
    ProviderUsage,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)

__all__ = ["ServerlessWhisperProvider"]

_log = get_logger(__name__)

_DEFAULT_TIMEOUT_S = 600.0
_DEFAULT_ATTEMPTS = 3


class ServerlessWhisperProvider(Provider):
    """HTTP client for the serverless-GPU Whisper endpoint."""

    name = "serverless-whisper"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe"}),
        word_timestamps=True,
        diarisation=False,
        # A serverless container is billed per second; a 2 h ceiling keeps one job
        # from holding an instance for an unbounded time (`05 §10`).
        max_duration_s=2 * 60 * 60,
        batch=False,
        languages=(),
    )

    #: 0.09 to 0.13 rupees per media minute (`05 §12`); the midpoint is what we estimate with.
    cost_per_minute_inr = 0.11

    def __init__(
        self,
        base_url: str,
        *,
        token: str = "",
        model: str = "large-v3-turbo",
        client: httpx2.AsyncClient | None = None,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        max_attempts: int = _DEFAULT_ATTEMPTS,
    ) -> None:
        if not base_url:
            raise ValueError("GPU_PROVIDER_URL is required for the serverless adapter")
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._token = token
        self._max_attempts = max(1, max_attempts)
        self._owns_client = client is None
        self._client = client or httpx2.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json"}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        return headers

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        endpoint = f"{self.base_url}/transcribe"
        body: dict[str, Any] = {
            "audio": request.audio_uri,
            "wordTimestamps": request.word_timestamps,
            "model": self.model,
            **request.options,
        }
        if request.language:
            body["language"] = request.language
        if request.hints:
            body["hints"] = list(request.hints)

        payload = await self._post(endpoint, body)
        words = _words(payload.get("words"), request.offset_ms)
        segments = _segments(payload.get("segments"), request.offset_ms)
        if not words and not segments:
            raise ProviderError(
                "the GPU endpoint returned neither words nor segments",
                provider=self.name,
                retryable=False,
            )

        seconds = float(payload.get("durationS") or 0.0)
        model = str(payload.get("model") or self.model)
        probability = payload.get("languageProbability")
        return TranscriptionResult(
            words=words,
            language=str(payload.get("language") or request.language or "en"),
            language_confidence=(
                round(float(probability), 4) if isinstance(probability, int | float) else None
            ),
            usage=ProviderUsage(
                media_seconds=seconds,
                provider=self.name,
                model=model,
                cost_minor=self.cost_estimate(seconds).minor,
            ),
            segments=segments,
            submissions=(
                ProviderSubmission(
                    provider=self.name,
                    endpoint=endpoint,
                    artefact=request.audio_uri,
                    external_ref=str(payload["requestId"])
                    if isinstance(payload.get("requestId"), str)
                    else None,
                    retention_class="ephemeral",
                ),
            ),
            raw={"model": model},
        )

    async def _post(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        last: str = "no attempt was made"
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post(url, json=body, headers=self._headers())
            except httpx2.HTTPError as error:
                last = f"{type(error).__name__}: {error}"
            else:
                if response.status_code < 400:
                    parsed = response.json()
                    if not isinstance(parsed, dict):
                        raise ProviderError(
                            "the GPU endpoint returned a non-object body",
                            provider=self.name,
                            retryable=False,
                        )
                    return parsed
                if response.status_code < 500 and response.status_code != 429:
                    raise ProviderError(
                        f"the GPU endpoint refused the request ({response.status_code})",
                        provider=self.name,
                        # 4xx is a bad request or a bad token; retrying cannot help.
                        retryable=False,
                    )
                last = f"HTTP {response.status_code}"

            if attempt < self._max_attempts:
                delay = min(2.0 ** (attempt - 1), 8.0) * (0.5 + random.random() / 2)  # noqa: S311
                _log.warning(
                    "serverless GPU call failed, retrying",
                    extra={"attempt": attempt, "reason": last},
                )
                await asyncio.sleep(delay)

        raise ProviderError(
            f"the GPU endpoint was unreachable after {self._max_attempts} attempts: {last}",
            provider=self.name,
            retryable=True,
        )

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("the serverless Whisper image does not expose alignment")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("the serverless Whisper image does not expose diarisation")


def _words(raw: object, offset_ms: int) -> tuple[Word, ...]:
    if not isinstance(raw, list):
        return ()
    words: list[Word] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("word") or item.get("text") or "").strip()
        if not text:
            continue
        confidence = item.get("probability", item.get("confidence"))
        words.append(
            Word(
                s=offset_ms + round(float(item.get("start") or 0.0) * 1000),
                e=offset_ms + round(float(item.get("end") or 0.0) * 1000),
                t=text,
                c=round(float(confidence), 4) if isinstance(confidence, int | float) else None,
            )
        )
    return tuple(words)


def _segments(raw: object, offset_ms: int) -> tuple[tuple[int, int, str], ...]:
    if not isinstance(raw, list):
        return ()
    segments: list[tuple[int, int, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        segments.append(
            (
                offset_ms + round(float(item.get("start") or 0.0) * 1000),
                offset_ms + round(float(item.get("end") or 0.0) * 1000),
                text,
            )
        )
    return tuple(segments)
