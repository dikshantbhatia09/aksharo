"""AssemblyAI Universal-2 — the global fallback, and the cost floor.

Decision **D12** puts AssemblyAI behind the serverless GPU on the global lane and
alongside Scribe on Indian English, at ₹0.24 per media minute — the cheapest
word-timestamped vendor on the board (RR-02 F5). It is the fallback that catches
a GPU outage, so its retry behaviour matters more than its speed.

## Wire contract

```
POST {ASSEMBLYAI_BASE_URL}/v2/upload            authorization: {ASSEMBLYAI_API_KEY}
     <raw audio bytes>
200  { "upload_url": "https://cdn.assemblyai.com/upload/..." }

POST {ASSEMBLYAI_BASE_URL}/v2/transcript
     { "audio_url": "...", "language_code": "en", "speech_model": "universal-2",
       "speaker_labels": true, "word_boost": ["Aksharo"], "punctuate": true }
200  { "id": "abc", "status": "queued" }

GET  {ASSEMBLYAI_BASE_URL}/v2/transcript/abc
200  { "status": "completed", "language_code": "en", "audio_duration": 41,
       "confidence": 0.94, "text": "...",
       "words": [ { "text": "toh", "start": 120, "end": 440,
                    "confidence": 0.94, "speaker": "A" } ] }
```

Two details that are easy to get wrong and are therefore pinned by tests:
**AssemblyAI speaks milliseconds**, unlike every other vendor here, so the
adapter must not multiply by a thousand; and ``status`` reaches ``error`` with
the reason in ``error``, which is a permanent failure for that audio rather than
something to retry.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx2

from worker_ai.languages import base_tag, normalise_language
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
from worker_ai.providers.http import VendorHttp

__all__ = ["ASSEMBLYAI_DEFAULT_BASE_URL", "AssemblyAiProvider"]

_log = get_logger(__name__)

ASSEMBLYAI_DEFAULT_BASE_URL = "https://api.assemblyai.com"

_TERMINAL_OK = frozenset({"completed"})
_TERMINAL_BAD = frozenset({"error", "failed"})


class AssemblyAiProvider(Provider):
    """Upload, submit, poll, read — the vendor's async transcript flow."""

    name = "assemblyai"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe", "diarise"}),
        word_timestamps=True,
        diarisation=True,
        max_duration_s=None,
        batch=True,
        # Empty means "any": Universal-2 claims 99+ languages (RR-02 F5), and
        # *which* of them we route to it is the routing table's decision (D12),
        # not the adapter's. Declaring a short list here would stop the global
        # lane falling back to it for anything but English.
        languages=(),
    )

    #: ₹0.24 per media minute (`05 §12`); diarisation adds $0.02/hr (RR-02 F5).
    cost_per_minute_inr = 0.24

    model = "universal-2"

    #: The async endpoint queues work vendor-side, so the client fans out little.
    max_parallel_requests = 4

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = ASSEMBLYAI_DEFAULT_BASE_URL,
        model: str | None = None,
        poll_interval_s: float = 3.0,
        poll_timeout_s: float = 20 * 60.0,
        client: httpx2.AsyncClient | None = None,
        http: VendorHttp | None = None,
    ) -> None:
        self._api_key = api_key
        self.base_url = (base_url or ASSEMBLYAI_DEFAULT_BASE_URL).rstrip("/")
        self.model = model or self.model
        self.poll_interval_s = poll_interval_s
        self.poll_timeout_s = poll_timeout_s
        self._http = http or VendorHttp(
            provider=self.name,
            base_url=self.base_url,
            headers={"authorization": api_key} if api_key else {},
            client=client,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        payload, transcript_id = await self._run(
            request.audio_uri,
            language=request.language,
            hints=request.hints,
            diarise=bool(request.options.get("diarise", False)),
        )
        words = _words(payload.get("words"), request.offset_ms)
        if not words:
            raise ProviderError(
                "AssemblyAI returned no words for this chunk",
                provider=self.name,
                retryable=True,
            )

        seconds = _duration_seconds(payload, words, request.offset_ms)
        confidence = payload.get("confidence")
        return TranscriptionResult(
            words=words,
            language=normalise_language(str(payload.get("language_code") or ""))
            or (request.language or "en"),
            language_confidence=(
                round(float(confidence), 4) if isinstance(confidence, int | float) else None
            ),
            usage=ProviderUsage(
                media_seconds=seconds,
                provider=self.name,
                model=self.model,
                cost_minor=self.cost_estimate(seconds).minor,
            ),
            submissions=(
                ProviderSubmission(
                    provider=self.name,
                    endpoint=self._http.url("/v2/transcript"),
                    artefact=Path(request.audio_uri).name or request.audio_uri,
                    external_ref=transcript_id,
                    region="global",
                    retention_class="vendor-default",
                ),
            ),
            raw={"model": self.model},
        )

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        """Speaker turns from ``utterances``, or from the per-word speaker labels."""
        payload, _transcript_id = await self._run(
            request.audio_uri, language=None, hints=(), diarise=True
        )
        utterances = payload.get("utterances")
        if isinstance(utterances, list) and utterances:
            return tuple(
                DiarisedSpeaker(
                    speaker_id=_speaker(item.get("speaker")) or "S1",
                    start_ms=int(item.get("start") or 0),
                    end_ms=int(item.get("end") or 0),
                    confidence=_float(item.get("confidence")),
                )
                for item in utterances
                if isinstance(item, dict)
            )
        return _turns(_words(payload.get("words"), 0))

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("AssemblyAI does not offer standalone alignment")

    # -- the three phases ---------------------------------------------------

    async def _run(
        self,
        audio_uri: str,
        *,
        language: str | None,
        hints: tuple[str, ...],
        diarise: bool,
    ) -> tuple[dict[str, Any], str]:
        upload_url = await self._upload(audio_uri)
        transcript_id = await self._submit(
            upload_url, language=language, hints=hints, diarise=diarise
        )
        return await self._await_completion(transcript_id), transcript_id

    async def _upload(self, audio_uri: str) -> str:
        """The upload endpoint takes raw bytes, not multipart."""
        response = await self._http.send(
            "POST",
            "/v2/upload",
            content=_read(audio_uri, self.name),
            headers={"content-type": "application/octet-stream"},
        )
        try:
            parsed: Any = response.json()
        except ValueError as error:
            raise ProviderError(
                "AssemblyAI returned a non-JSON upload response",
                provider=self.name,
                retryable=False,
            ) from error
        url = str(parsed.get("upload_url") or "") if isinstance(parsed, dict) else ""
        if not url:
            raise ProviderError(
                "AssemblyAI did not return an upload url",
                provider=self.name,
                retryable=True,
            )
        return url

    async def _submit(
        self, audio_url: str, *, language: str | None, hints: tuple[str, ...], diarise: bool
    ) -> str:
        body: dict[str, Any] = {
            "audio_url": audio_url,
            "speech_model": self.model,
            "punctuate": True,
            "format_text": True,
        }
        vendor_language = _vendor_language(language)
        if vendor_language:
            body["language_code"] = vendor_language
        else:
            body["language_detection"] = True
        if diarise:
            body["speaker_labels"] = True
        if hints:
            # Custom vocabulary: the glossary hints of `09 §3` (B09 supplies them).
            body["word_boost"] = list(hints)
            body["boost_param"] = "high"

        payload = await self._http.json("POST", "/v2/transcript", json_body=body)
        transcript_id = str(payload.get("id") or "")
        if not transcript_id:
            raise ProviderError(
                "AssemblyAI did not return a transcript id",
                provider=self.name,
                retryable=True,
            )
        return transcript_id

    async def _await_completion(self, transcript_id: str) -> dict[str, Any]:
        async def check() -> tuple[bool, dict[str, Any]]:
            payload = await self._http.json("GET", "/v2/transcript/" + transcript_id)
            status = str(payload.get("status") or "").lower()
            if status in _TERMINAL_BAD:
                raise ProviderError(
                    "the AssemblyAI transcript failed: " + _reason(payload),
                    provider=self.name,
                    retryable=False,
                )
            return status in _TERMINAL_OK, payload

        return await self._http.poll(
            check=check,
            interval_s=self.poll_interval_s,
            timeout_s=self.poll_timeout_s,
        )


def _words(raw: object, offset_ms: int) -> tuple[Word, ...]:
    """``words[]`` — already in milliseconds, which is the whole trap here."""
    if not isinstance(raw, list):
        return ()
    words: list[Word] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        words.append(
            Word(
                s=offset_ms + int(item.get("start") or 0),
                e=offset_ms + int(item.get("end") or 0),
                t=text,
                c=_float(item.get("confidence")),
                sp=_speaker(item.get("speaker")),
            )
        )
    return tuple(words)


def _turns(words: tuple[Word, ...]) -> tuple[DiarisedSpeaker, ...]:
    turns: list[DiarisedSpeaker] = []
    for word in words:
        if word.sp is None:
            continue
        if turns and turns[-1].speaker_id == word.sp:
            previous = turns[-1]
            turns[-1] = DiarisedSpeaker(
                speaker_id=word.sp,
                start_ms=previous.start_ms,
                end_ms=max(previous.end_ms, word.e),
            )
            continue
        turns.append(DiarisedSpeaker(speaker_id=word.sp, start_ms=word.s, end_ms=word.e))
    return tuple(turns)


def _speaker(raw: object) -> str | None:
    """``"A"`` becomes ``S1``, ``"B"`` becomes ``S2`` — the EDG's own ids."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    label = raw.strip()
    if len(label) == 1 and label.isalpha():
        return "S" + str(ord(label.upper()) - ord("A") + 1)
    if label.isdigit():
        return "S" + str(int(label) + 1)
    return label


def _vendor_language(tag: str | None) -> str:
    """``en-IN`` collapses to ``en``; the code-mix lane always auto-detects."""
    normalised = base_tag(tag)
    if not normalised or normalised == "hi-en":
        return ""
    return normalised


def _duration_seconds(
    payload: dict[str, Any], words: tuple[Word, ...], offset_ms: int
) -> float:
    duration = payload.get("audio_duration")
    if isinstance(duration, int | float) and duration > 0:
        return float(duration)
    if not words:
        return 0.0
    return max(0.0, (words[-1].e - offset_ms) / 1000)


def _float(value: object) -> float | None:
    return round(float(value), 4) if isinstance(value, int | float) else None


def _reason(payload: dict[str, Any]) -> str:
    for key in ("error", "message"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:200]
    return "no reason given"


def _read(audio_uri: str, provider: str) -> bytes:
    path = Path(audio_uri)
    try:
        return path.read_bytes()
    except OSError as error:
        raise ProviderError(
            "could not read the audio chunk " + path.name,
            provider=provider,
            retryable=False,
        ) from error
