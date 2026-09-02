"""ElevenLabs Scribe v2 — the primary lane for Hindi, Indian English and Indic.

Decision **D12** makes Scribe primary wherever it has coverage, for one reason
that shows up all over this adapter: it returns **word-level timestamps and
diarisation in the price**, so a Scribe-routed job runs neither the forced
aligner (`09 §2`) nor pyannote (D13). It is the only primary lane with that
property, and `routing.yaml` records it as ``alignment: optional``.

## Wire contract

```
POST {ELEVENLABS_BASE_URL}/v1/speech-to-text        multipart/form-data
xi-api-key: {ELEVENLABS_API_KEY}
  file=<audio16k.wav chunk>  model_id=scribe_v2  language_code=hin
  timestamps_granularity=word  diarize=true  num_speakers=3
  keyterms=["Aksharo"]  enable_logging=false

200 { "language_code": "hin", "language_probability": 0.98, "text": "...",
      "words": [ { "text": "toh", "start": 0.12, "end": 0.44, "type": "word",
                   "speaker_id": "speaker_0", "logprob": -0.11 } ] }

POST {ELEVENLABS_BASE_URL}/v1/forced-alignment      multipart/form-data
  file=<audio>  text="toh aaj hum"  enable_logging=false
200 { "words": [ { "text": "toh", "start": 0.12, "end": 0.44, "loss": 0.2 } ] }
```

Times on the wire are **seconds** and become integer milliseconds here and
nowhere else. ``words[].type`` is one of ``word``, ``spacing`` and
``audio_event``; only ``word`` becomes an EDG word, because a spacing token with
a duration would be highlighted in the editor as if it were spoken.

## Residency and retention (`09 §8`, D17)

``ELEVENLABS_BASE_URL`` selects the endpoint. Enterprise India residency is
``https://api.in.residency.elevenlabs.io``; the default is the global endpoint,
which is correct for a development machine and **wrong for Indian production
media** until the contract in A00-06 is signed. ``enable_logging=false`` is the
per-request half of Zero Retention Mode; the account-level half is a [HUMAN]
step. Both are recorded on every :class:`ProviderSubmission` so an audit can see
which endpoint and which retention class a piece of audio actually went to.
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

__all__ = [
    "ELEVENLABS_DEFAULT_BASE_URL",
    "ELEVENLABS_INDIA_BASE_URL",
    "ElevenLabsScribeProvider",
]

_log = get_logger(__name__)

#: Global endpoint. Correct for development; see the module docstring for India.
ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io"

#: Enterprise India residency endpoint (`09 §8`, RR-02 F5).
ELEVENLABS_INDIA_BASE_URL = "https://api.in.residency.elevenlabs.io"

#: ISO-639-3 is what the vendor's ``language_code`` field speaks.
_TO_VENDOR: dict[str, str] = {
    "as": "asm",
    "bn": "ben",
    "en": "eng",
    "gu": "guj",
    "hi": "hin",
    "kn": "kan",
    "ml": "mal",
    "mr": "mar",
    "ne": "nep",
    "or": "ori",
    "pa": "pan",
    "ta": "tam",
    "te": "tel",
    "ur": "urd",
}


class ElevenLabsScribeProvider(Provider):
    """Batch speech-to-text with word timestamps and diarisation included."""

    name = "elevenlabs"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe", "align", "diarise"}),
        word_timestamps=True,
        diarisation=True,
        max_duration_s=None,
        batch=False,
        languages=(
            "hi",
            "en-IN",
            "ta",
            "te",
            "kn",
            "ml",
            "bn",
            "mr",
            "gu",
            "or",
            "ne",
            "as",
            "pa",
        ),
    )

    #: ₹0.35 per media minute, word timestamps and diarisation included (`05 §12`).
    cost_per_minute_inr = 0.35

    #: The separate Forced Alignment product; the same rate (RR-02 F5).
    alignment_model = "eleven-forced-alignment-v1"
    model = "scribe_v2"

    #: Chunks in flight against this vendor. Scribe is a synchronous batch
    #: endpoint with generous limits; the ceiling exists so a six-hour file does
    #: not open thirty-six sockets at once.
    max_parallel_requests = 6

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = ELEVENLABS_DEFAULT_BASE_URL,
        model: str | None = None,
        zero_retention: bool = True,
        client: httpx2.AsyncClient | None = None,
        http: VendorHttp | None = None,
    ) -> None:
        self._api_key = api_key
        self.base_url = (base_url or ELEVENLABS_DEFAULT_BASE_URL).rstrip("/")
        self.model = model or self.model
        self.zero_retention = zero_retention
        self._http = http or VendorHttp(
            provider=self.name,
            base_url=self.base_url,
            headers={"xi-api-key": api_key} if api_key else {},
            client=client,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    @property
    def region(self) -> str:
        """``in`` when the India residency endpoint is configured, else ``global``."""
        return "in" if "in.residency." in self.base_url else "global"

    @property
    def retention_class(self) -> str:
        return "zero-retention" if self.zero_retention else "vendor-default"

    # -- transcription ------------------------------------------------------

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        payload, endpoint = await self._speech_to_text(
            request.audio_uri,
            language=request.language,
            hints=request.hints,
            diarise=bool(request.options.get("diarise", True)),
            num_speakers=_optional_int(request.options.get("numSpeakers")),
        )
        words = _words(payload.get("words"), request.offset_ms)
        if not words:
            raise ProviderError(
                "Scribe returned no words for this chunk",
                provider=self.name,
                # An empty transcript for real audio is a vendor-side oddity, not
                # a bad request; A08 gets to decide whether to try again.
                retryable=True,
            )

        seconds = _duration_seconds(words, request.offset_ms)
        probability = payload.get("language_probability")
        return TranscriptionResult(
            words=words,
            language=normalise_language(str(payload.get("language_code") or ""))
            or (request.language or "en"),
            language_confidence=(
                round(float(probability), 4) if isinstance(probability, int | float) else None
            ),
            usage=ProviderUsage(
                media_seconds=seconds,
                provider=self.name,
                model=self.model,
                cost_minor=self.cost_estimate(seconds).minor,
            ),
            submissions=(self._submission(endpoint, request.audio_uri),),
            raw={"model": self.model, "diarised": any(word.sp for word in words)},
        )

    async def _speech_to_text(
        self,
        audio_uri: str,
        *,
        language: str | None,
        hints: tuple[str, ...],
        diarise: bool,
        num_speakers: int | None,
    ) -> tuple[dict[str, Any], str]:
        """One ``/v1/speech-to-text`` call. Returns the body and the endpoint."""
        endpoint = "/v1/speech-to-text"
        form: dict[str, Any] = {
            "model_id": self.model,
            "timestamps_granularity": "word",
            "diarize": "true" if diarise else "false",
        }
        vendor_language = _vendor_language(language)
        if vendor_language:
            form["language_code"] = vendor_language
        if num_speakers is not None:
            form["num_speakers"] = str(num_speakers)
        if hints:
            # Custom vocabulary: the glossary hints of `09 §3`, passed through
            # because Scribe supports biasing terms. B09 supplies the list.
            form["keyterms"] = _json_list(hints)
        if self.zero_retention:
            form["enable_logging"] = "false"

        payload = await self._http.json(
            "POST",
            endpoint,
            data=form,
            files={"file": (Path(audio_uri).name or "audio.wav", _read(audio_uri, self.name))},
        )
        return payload, self._http.url(endpoint)

    # -- forced alignment ---------------------------------------------------

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        """The paid Forced Alignment product: known text onto audio."""
        if not request.words:
            return TranscriptionResult(words=(), language=request.language)
        endpoint = "/v1/forced-alignment"
        form: dict[str, Any] = {"text": " ".join(request.words)}
        vendor_language = _vendor_language(request.language)
        if vendor_language:
            form["language_code"] = vendor_language
        if self.zero_retention:
            form["enable_logging"] = "false"

        payload = await self._http.json(
            "POST",
            endpoint,
            data=form,
            files={
                "file": (
                    Path(request.audio_uri).name or "audio.wav",
                    _read(request.audio_uri, self.name),
                )
            },
        )
        offset = request.offset_ms + request.start_ms
        words = _words(payload.get("words"), offset)
        return TranscriptionResult(
            words=words,
            language=request.language,
            submissions=(self._submission(self._http.url(endpoint), request.audio_uri),),
            raw={"model": self.alignment_model},
        )

    # -- diarisation --------------------------------------------------------

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        """Speaker turns from a diarised Scribe pass over the whole file.

        Used only when Scribe is already the transcription primary — `09 §2` runs
        pyannote otherwise, and paying Scribe twice for one file would be worse
        than either.
        """
        payload, _endpoint = await self._speech_to_text(
            request.audio_uri,
            language=None,
            hints=(),
            diarise=True,
            num_speakers=request.num_speakers,
        )
        return speaker_turns(_words(payload.get("words"), 0))

    def _submission(self, endpoint: str, artefact: str) -> ProviderSubmission:
        return ProviderSubmission(
            provider=self.name,
            endpoint=endpoint,
            artefact=artefact,
            region=self.region,
            retention_class=self.retention_class,
        )


def speaker_turns(words: tuple[Word, ...]) -> tuple[DiarisedSpeaker, ...]:
    """Collapse consecutive words sharing a speaker into turns.

    Exported because both the diarisation path and the transcription path need it:
    a Scribe transcript already carries per-word speakers, and `09 §2` wants the
    same turn list a diariser would have produced.
    """
    turns: list[DiarisedSpeaker] = []
    for word in words:
        speaker = word.sp
        if speaker is None:
            continue
        if turns and turns[-1].speaker_id == speaker:
            previous = turns[-1]
            turns[-1] = DiarisedSpeaker(
                speaker_id=speaker,
                start_ms=previous.start_ms,
                end_ms=max(previous.end_ms, word.e),
            )
            continue
        turns.append(DiarisedSpeaker(speaker_id=speaker, start_ms=word.s, end_ms=word.e))
    return tuple(turns)


def _words(raw: object, offset_ms: int) -> tuple[Word, ...]:
    """``words[]`` in seconds to EDG words in milliseconds, spacing dropped."""
    if not isinstance(raw, list):
        return ()
    words: list[Word] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "word")
        if kind != "word":
            continue
        text = str(item.get("text") or item.get("word") or "").strip()
        if not text:
            continue
        words.append(
            Word(
                s=offset_ms + round(float(item.get("start") or 0.0) * 1000),
                e=offset_ms + round(float(item.get("end") or 0.0) * 1000),
                t=text,
                c=_confidence(item),
                sp=_speaker(item.get("speaker_id")),
            )
        )
    return tuple(words)


def _confidence(item: dict[str, Any]) -> float | None:
    """Scribe reports a log probability; the EDG wants 0..1."""
    logprob = item.get("logprob")
    if isinstance(logprob, int | float):
        import math

        return round(min(1.0, math.exp(float(logprob))), 4)
    confidence = item.get("confidence")
    if isinstance(confidence, int | float):
        return round(float(confidence), 4)
    return None


def _speaker(raw: object) -> str | None:
    """``speaker_0`` becomes ``S1``: the EDG's own opaque, 1-based speaker id."""
    if not isinstance(raw, str) or not raw:
        return None
    tail = raw.rsplit("_", 1)[-1]
    if tail.isdigit():
        return "S" + str(int(tail) + 1)
    return raw


def _vendor_language(tag: str | None) -> str:
    """Our BCP-47 tag as the vendor's ISO-639-3 code; ``""`` means auto-detect.

    The code-mix lane is deliberately sent as auto-detect: Scribe has no
    Hinglish code, and pinning ``hin`` on code-switched audio makes it translate
    the English rather than transcribe it (RR-02 F6).
    """
    normalised = base_tag(tag)
    if not normalised or normalised == "hi-en":
        return ""
    return _TO_VENDOR.get(normalised, "")


def _json_list(values: tuple[str, ...]) -> str:
    import json

    return json.dumps(list(values), ensure_ascii=False)


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value > 0 else None


def _duration_seconds(words: tuple[Word, ...], offset_ms: int) -> float:
    """Billed media seconds for a chunk, from the words the vendor returned."""
    if not words:
        return 0.0
    return max(0.0, (words[-1].e - offset_ms) / 1000)


def _read(audio_uri: str, provider: str) -> bytes:
    """Read the chunk from disk.

    Vendors take an upload, not a URL, so the worker sends bytes. The file is the
    chunk ``ai.transcribe`` already cut into its scratch directory, which is
    deleted when the job ends (`JobContext.cleanup`).
    """
    path = Path(audio_uri)
    try:
        return path.read_bytes()
    except OSError as error:
        raise ProviderError(
            "could not read the audio chunk " + path.name,
            provider=provider,
            retryable=False,
        ) from error
