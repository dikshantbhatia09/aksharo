"""Sarvam Saaras v4 through the **Batch API** — the code-mix and coverage lane.

Decision **D12** makes Saaras primary for Hinglish (``mode=codemix``) and for the
ten scheduled languages Scribe does not cover. Two vendor facts from RR-02 F1
shape every line below, and neither is negotiable:

* **REST caps at 30 seconds of audio.** The D14 chunk plan is ten minutes a
  chunk, so the REST endpoint cannot serve this product at all. Every production
  call is a Batch job (≤ 2 h per file), which is why ``capabilities.batch`` is
  ``True`` and why ``routing.yaml`` marks the lane ``api: batch``.
* **There are no word-level timestamps.** Saaras returns chunk (sentence) spans,
  so ``capabilities.word_timestamps`` is ``False`` and the alignment registry of
  `09 §2` is **mandatory** behind this adapter. A Saaras result reaches the EDG
  as ``segments``, never as words.

## Wire contract (batch flow verified live 2026-09-14; timestamp shape
## corrected 2026-09-17 — see the warning below before trusting either date)

This adapter's first version guessed this shape from stale documentation
without ever calling the vendor (see git history) — every real call 400'd on
the very first request. The six-phase batch flow below was checked against
Sarvam's published API reference and confirmed with a live call and has not
been wrong since:

```
POST {SARVAM_BASE_URL}/speech-to-text/job/v1
api-subscription-key: {SARVAM_API_KEY}
{ "job_parameters": { "model": "saaras:v4", "mode": "codemix",
  "language_code": "unknown", "with_timestamps": true,
  "with_diarization": false, "keyterms": ["..."] } }
202 { "job_id": "...", "storage_container_type": "Azure_V1", "job_state": "Accepted" }

POST {SARVAM_BASE_URL}/speech-to-text/job/v1/upload-files
{ "job_id": "...", "files": ["name.wav"] }
200 { "upload_urls": { "name.wav": { "file_url": "https://...?sas" } } }

PUT {file_url}                                     x-ms-blob-type: BlockBlob

POST {SARVAM_BASE_URL}/speech-to-text/job/v1/{job_id}/start      (empty body)

GET  {SARVAM_BASE_URL}/speech-to-text/job/v1/{job_id}/status
200  { "job_state": "Pending|Running|Completed|Failed", "error_message": null,
       "job_details": [ { "outputs": [ { "file_name": "name.json" } ] } ] }

POST {SARVAM_BASE_URL}/speech-to-text/job/v1/download-files
{ "job_id": "...", "files": ["name.json"] }
200 { "download_urls": { "name.json": { "file_url": "https://...?sas" } } }

GET  {file_url}
200  { "language_code": "en-IN",
       "transcript": "Alright, so here we are, ...",
       "timestamps": { "words": ["Alright, so here we are, ..."],
                        "start_time_seconds": [0.0],
                        "end_time_seconds": [19.07] } }
```

**The ``timestamps`` shape above is what a live account actually returns as
of 2026-09-17** — three parallel arrays, keyed ``words`` even though (at least
for the call that produced this example) each entry was chunk-grained, not a
single word. `_parallel_array_segments` parses this. The *previous* version of
this docstring claimed a different shape (a ``chunks`` list of ``{text,
start_time_seconds, end_time_seconds}`` objects) was "verified live
2026-09-14" — that verification's own example was not `mode: codemix`, and
every real call this product makes is, which is the gap that produced the
2026-09-16 incident: real Hindi/Hinglish projects transcribed with correct
*text* and every word's timing silently collapsed to ``(0, 0)``, because
nothing in the actual response matched the keys this parser was looking for.
`_chunk_list`'s object-list parsing stays as a fallback in case some other
mode or a future response genuinely uses it — it is not proven wrong, only
proven not to be what `mode: codemix` returns today — and the whole-file
fallback below it stays as the last resort for a response with neither shape.

Nothing here is fixture-verified end to end against a live, non-empty
response yet: `worker_ai/fixtures/vendor/sarvam` and the manual smoke path in
the README were written against the *first* (2026-09-14) shape, so replaying
them proves the parser handles that shape, not that the vendor still sends
it. `test_vendor_smoke.py`, gated behind `RUN_VENDOR_SMOKE=1`, is what proves
this against the real account when someone is willing to spend the call.
"""

from __future__ import annotations

import json
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
)
from worker_ai.providers.http import VendorHttp

__all__ = ["SARVAM_DEFAULT_BASE_URL", "SARVAM_MODES", "SarvamSaarasProvider"]

_log = get_logger(__name__)

SARVAM_DEFAULT_BASE_URL = "https://api.sarvam.ai"

#: The five documented Saaras modes (RR-02 F1). ``translate`` is A22's, not ours.
SARVAM_MODES: frozenset[str] = frozenset(
    {"transcribe", "verbatim", "translit", "codemix", "translate"}
)

#: Sarvam speaks BCP-47 with a region; ``unknown`` asks it to auto-detect.
_AUTO = "unknown"


class SarvamSaarasProvider(Provider):
    """Saaras v4 via submit / poll / download on the Batch API."""

    name = "sarvam"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe"}),
        # Chunk-level only — this False is the reason the Hinglish lane pairs the
        # provider with a forced aligner in `routing.yaml`.
        word_timestamps=False,
        diarisation=False,
        max_duration_s=2 * 60 * 60,
        batch=True,
        languages=(
            "hi-en",
            "hi",
            "ur",
            "sd",
            "kok",
            "ks",
            "sa",
            "sat",
            "mni",
            "brx",
            "mai",
            "doi",
        ),
    )

    #: ₹0.50 per media minute plus ₹0.03 for the mandatory alignment (`09 §1`).
    cost_per_minute_inr = 0.53

    model = "saaras:v4"
    #: `mode=codemix` is what makes the Hinglish lane a code-mix lane.
    default_mode = "codemix"

    #: A batch job is one request for the whole file, so there is nothing to fan
    #: out; the ceiling exists only so a pool of workers cannot exceed the 60
    #: requests a minute of the Starter plan (RR-02 F1) all at once.
    max_parallel_requests = 1

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = SARVAM_DEFAULT_BASE_URL,
        model: str | None = None,
        poll_interval_s: float = 10.0,
        poll_timeout_s: float = 30 * 60.0,
        client: httpx2.AsyncClient | None = None,
        http: VendorHttp | None = None,
    ) -> None:
        self._api_key = api_key
        self.base_url = (base_url or SARVAM_DEFAULT_BASE_URL).rstrip("/")
        self.model = model or self.model
        self.poll_interval_s = poll_interval_s
        self.poll_timeout_s = poll_timeout_s
        self._http = http or VendorHttp(
            provider=self.name,
            base_url=self.base_url,
            headers={"api-subscription-key": api_key} if api_key else {},
            client=client,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        """Run one Batch job over one file and return its chunk-level segments."""
        mode = _mode(request.options)
        name = Path(request.audio_uri).name or "audio.wav"
        submissions: list[ProviderSubmission] = []

        job = await self._create_job(mode=mode, language=request.language, hints=request.hints)
        job_id = str(job.get("job_id") or "")
        if not job_id:
            raise ProviderError(
                "Sarvam did not return a job id", provider=self.name, retryable=True
            )
        submissions.append(self._submission("/speech-to-text/job/v1", name, job_id))

        upload_url = await self._upload_url(job_id, name)
        submissions.append(self._submission("/speech-to-text/job/v1/upload-files", name, job_id))

        await self._upload(upload_url, request.audio_uri)
        submissions.append(self._submission("azure-blob/input", name, job_id))

        await self._start(job_id)
        outputs = await self._await_completion(job_id)
        output_name = outputs[0] if outputs else name.rsplit(".", 1)[0] + ".json"

        download_url = await self._download_url(job_id, output_name)
        submissions.append(
            self._submission("/speech-to-text/job/v1/download-files", output_name, job_id)
        )

        payload = await self._download(download_url)
        submissions.append(self._submission("azure-blob/output", output_name, job_id))

        segments = _segments(payload, request.offset_ms)
        if not segments:
            raise ProviderError(
                "the Saaras job produced no transcript",
                provider=self.name,
                retryable=False,
            )

        seconds = max(0.0, (segments[-1][1] - request.offset_ms) / 1000)
        return TranscriptionResult(
            # Deliberately empty: Saaras has no word timings, and inventing them
            # here would hide the mandatory alignment step from the caller.
            words=(),
            language=normalise_language(str(payload.get("language_code") or ""))
            or (request.language or "hi"),
            language_confidence=_probability(payload),
            usage=ProviderUsage(
                media_seconds=seconds,
                provider=self.name,
                model=self.model,
                cost_minor=self.cost_estimate(seconds).minor,
            ),
            segments=segments,
            submissions=tuple(submissions),
            raw={"model": self.model, "mode": mode, "jobId": job_id, "alignmentRequired": True},
        )

    # -- the six Batch phases -----------------------------------------------

    async def _create_job(
        self, *, mode: str, language: str | None, hints: tuple[str, ...]
    ) -> dict[str, Any]:
        parameters: dict[str, Any] = {
            "model": self.model,
            "mode": mode,
            "language_code": _vendor_language(language),
            "with_timestamps": True,
            # Diarisation is pyannote's job (D13); paying Sarvam ₹0.25/min for a
            # chunk-level answer would be worse and dearer.
            "with_diarization": False,
        }
        if hints:
            # Custom vocabulary where the vendor supports it (`09 §3`).
            parameters["keyterms"] = list(hints)
        return await self._http.json(
            "POST", "/speech-to-text/job/v1", json_body={"job_parameters": parameters}
        )

    async def _upload_url(self, job_id: str, name: str) -> str:
        """Ask the job for a presigned PUT URL for ``name`` (Azure blob SAS)."""
        payload = await self._http.json(
            "POST",
            "/speech-to-text/job/v1/upload-files",
            json_body={"job_id": job_id, "files": [name]},
        )
        return _presigned_url(payload, "upload_urls", name, self.name)

    async def _upload(self, upload_url: str, audio_uri: str) -> None:
        await self._http.content(
            "PUT",
            upload_url,
            body=_read(audio_uri, self.name),
            headers={"x-ms-blob-type": "BlockBlob", "content-type": "audio/wav"},
        )

    async def _start(self, job_id: str) -> None:
        await self._http.json("POST", "/speech-to-text/job/v1/" + job_id + "/start")

    async def _await_completion(self, job_id: str) -> tuple[str, ...]:
        """Poll ``/status`` until the job leaves ``Pending``/``Running``.

        Returns the output file names named in the final payload's
        ``job_details``, so the caller knows what to ask ``download-files`` for.
        """

        async def check() -> tuple[bool, dict[str, Any]]:
            payload = await self._http.json(
                "GET", "/speech-to-text/job/v1/" + job_id + "/status"
            )
            state = str(payload.get("job_state") or "").lower()
            if state in {"failed", "error", "cancelled"}:
                raise ProviderError(
                    "the Saaras job failed: " + _reason(payload),
                    provider=self.name,
                    # The vendor rejected this audio; a retry pays twice for the
                    # same answer. Routing falls back to the next candidate.
                    retryable=False,
                )
            return state in {"completed", "partiallycompleted"}, payload

        payload = await self._http.poll(
            check=check,
            interval_s=self.poll_interval_s,
            timeout_s=self.poll_timeout_s,
        )
        return _output_names(payload)

    async def _download_url(self, job_id: str, name: str) -> str:
        """Ask the job for a presigned GET URL for output file ``name``."""
        payload = await self._http.json(
            "POST",
            "/speech-to-text/job/v1/download-files",
            json_body={"job_id": job_id, "files": [name]},
        )
        return _presigned_url(payload, "download_urls", name, self.name)

    async def _download(self, download_url: str) -> dict[str, Any]:
        body = await self._http.content("GET", download_url)
        try:
            parsed: Any = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise ProviderError(
                "the Saaras output blob is not JSON", provider=self.name, retryable=False
            ) from error
        if not isinstance(parsed, dict):
            raise ProviderError(
                "the Saaras output blob is not an object", provider=self.name, retryable=False
            )
        return parsed

    def _submission(self, endpoint: str, artefact: str, job_id: str) -> ProviderSubmission:
        return ProviderSubmission(
            provider=self.name,
            endpoint=self._http.url(endpoint) if endpoint.startswith("/") else endpoint,
            artefact=artefact,
            external_ref=job_id,
            region="in",
            # Sarvam's ephemeral mode is a contract switch, not a request flag
            # (RR-02 F2); A00-06 turns it on and this string records the intent.
            retention_class="ephemeral",
        )

    # -- capabilities this vendor does not have -----------------------------

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("Sarvam does not offer forced alignment")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("diarisation runs on pyannote community-1 (D13)")


def _mode(options: dict[str, Any]) -> str:
    """The lane's ``mode``, validated against the documented set."""
    raw = str(options.get("mode") or SarvamSaarasProvider.default_mode)
    if raw not in SARVAM_MODES:
        raise ProviderError(
            "unknown Saaras mode " + repr(raw) + "; routing.yaml must name one of "
            + ", ".join(sorted(SARVAM_MODES)),
            provider=SarvamSaarasProvider.name,
            retryable=False,
        )
    return raw


def _vendor_language(tag: str | None) -> str:
    """Our tag as Sarvam's ``language_code``; ``unknown`` asks it to detect.

    The code-mix lane always auto-detects: ``mode=codemix`` is the switch that
    matters and pinning ``hi-IN`` alongside it would fight the mode.
    """
    normalised = base_tag(tag)
    if not normalised or normalised == "hi-en":
        return _AUTO
    if normalised == "en":
        return "en-IN"
    return normalised + "-IN"


def _presigned_url(payload: dict[str, Any], key: str, name: str, provider: str) -> str:
    """Pull ``payload[key][name]["file_url"]`` — the shape both upload-files and
    download-files answer with, one presigned Azure blob URL per requested name.

    A batch job in this product is always exactly one file (`max_parallel_requests
    = 1`; D14 chunks are submitted one per job), so a single-entry map is used
    even when its key does not echo the name we sent — do not require the vendor
    to round-trip a name it may normalise or rename.
    """
    urls = payload.get(key)
    if not isinstance(urls, dict) or not urls:
        raise ProviderError(
            "Sarvam did not return any " + key, provider=provider, retryable=True
        )
    entry = urls.get(name)
    if entry is None and len(urls) == 1:
        entry = next(iter(urls.values()))
    url = entry.get("file_url") if isinstance(entry, dict) else None
    if not url:
        raise ProviderError(
            "Sarvam did not return a " + key + " entry for " + name,
            provider=provider,
            retryable=True,
        )
    return str(url)


def _output_names(payload: dict[str, Any]) -> tuple[str, ...]:
    """Output file names named in a completed job's ``job_details``."""
    names: list[str] = []
    for detail in payload.get("job_details") or []:
        if not isinstance(detail, dict):
            continue
        for output in detail.get("outputs") or []:
            if isinstance(output, dict):
                name = output.get("file_name")
                if isinstance(name, str) and name:
                    names.append(name)
    return tuple(names)


def _segments(payload: dict[str, Any], offset_ms: int) -> tuple[tuple[int, int, str], ...]:
    """Chunk-level spans in milliseconds, from any of the shapes the docs show."""
    parallel = _parallel_array_segments(payload, offset_ms)
    if parallel is not None:
        return parallel

    raw = _chunk_list(payload)
    segments: list[tuple[int, int, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or item.get("transcript") or "").strip()
        if not text:
            continue
        start, start_found = _seconds(item, ("start_time_seconds", "start_time", "start"))
        end, end_found = _seconds(item, ("end_time_seconds", "end_time", "end"))
        if not start_found and not end_found:
            # Every documented key name missed on this chunk. That is not "the
            # vendor answered 0.0" (a real first chunk legitimately can) -- it
            # is "none of start_time_seconds/start_time/start/end_time_seconds/
            # end_time/end exist on this object at all", which downstream is
            # indistinguishable from a real zero and silently collapses every
            # word in the chunk onto (0, 0) once ProportionalAligner sees a
            # zero-length span (found live 2026-09-16: real Hindi/Hinglish
            # projects routed to Sarvam, transcript text correct, every word's
            # s/e exactly 0). `start_time_seconds` was "verified live
            # 2026-09-14" (this file's own docstring) against a plain request;
            # this job's mode was codemix -- never independently checked. Log
            # the chunk's own keys, not its content, so the next occurrence
            # comes with actual evidence instead of another guess.
            _log.warning(
                "Sarvam chunk has no recognised timestamp field; check whether "
                "codemix mode names them differently",
                extra={"provider": "sarvam", "chunkKeys": sorted(item.keys())},
            )
        segments.append(
            (offset_ms + round(start * 1000), offset_ms + round(max(end, start) * 1000), text)
        )
    if segments:
        return tuple(segments)

    # No chunk list: one segment over the whole file. The aligner still places
    # every word, so this degrades quality rather than failing the job.
    transcript = str(payload.get("transcript") or "").strip()
    if not transcript:
        return ()
    duration, duration_found = _seconds(payload, ("duration_seconds", "audio_duration", "duration"))
    if not duration_found:
        _log.warning(
            "Sarvam response has no recognised duration field; falling back "
            "to a zero-length whole-file segment",
            extra={"provider": "sarvam", "payloadKeys": sorted(payload.keys())},
        )
    return ((offset_ms, offset_ms + round(duration * 1000), transcript),)


def _parallel_array_segments(
    payload: dict[str, Any], offset_ms: int
) -> tuple[tuple[int, int, str], ...] | None:
    """The shape a real account actually returns (confirmed live 2026-09-17,
    `mode: codemix`, against `worker_ai/fixtures/vendor/sarvam` audio already
    known to transcribe correctly through this exact adapter):

    ```json
    "timestamps": { "words": ["toh aaj hum baat karenge"],
                     "start_time_seconds": [0.0], "end_time_seconds": [2.1] }
    ```

    Three parallel arrays under ``timestamps``, not a list of chunk objects.
    The key is named ``words`` but each entry is chunk-grained (a real call
    returned one 19-second entry holding the *entire* transcript) -- Saaras
    still has no word-level timing, this is just a different envelope for the
    same chunk spans `_chunk_list` was written for. This is what the docstring
    above's "verified live 2026-09-14" shape never actually was: that
    verification's example was not `mode: codemix`, and every real call this
    product makes is. Checked first because it is the shape a live call
    returns today; `_chunk_list` stays as a fallback for whatever the object-
    list shape was verified against, in case a different mode or a future
    vendor response still uses it.

    ``None`` when this shape is not present, so the caller falls through to
    the older parsing rather than treating an absent field as "zero segments."
    """
    timestamps = payload.get("timestamps")
    if not isinstance(timestamps, dict):
        return None
    texts = timestamps.get("words")
    starts = timestamps.get("start_time_seconds")
    ends = timestamps.get("end_time_seconds")
    if not (isinstance(texts, list) and isinstance(starts, list) and isinstance(ends, list)):
        return None
    if not texts or not (len(texts) == len(starts) == len(ends)):
        return None

    segments: list[tuple[int, int, str]] = []
    for raw_text, raw_start, raw_end in zip(texts, starts, ends, strict=True):
        text = str(raw_text).strip()
        if not text:
            continue
        start = float(raw_start) if isinstance(raw_start, int | float) else 0.0
        end = float(raw_end) if isinstance(raw_end, int | float) else start
        segments.append(
            (offset_ms + round(start * 1000), offset_ms + round(max(end, start) * 1000), text)
        )
    return tuple(segments) if segments else None


def _chunk_list(payload: dict[str, Any]) -> list[Any]:
    timestamps = payload.get("timestamps")
    if isinstance(timestamps, dict) and isinstance(timestamps.get("chunks"), list):
        chunks: list[Any] = timestamps["chunks"]
        return chunks
    for key in ("chunks", "segments", "diarized_transcript"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _seconds(item: dict[str, Any], keys: tuple[str, ...]) -> tuple[float, bool]:
    """The value at the first matching key, and whether any key matched at all."""
    for key in keys:
        value = item.get(key)
        if isinstance(value, int | float):
            return float(value), True
    return 0.0, False


def _probability(payload: dict[str, Any]) -> float | None:
    value = payload.get("language_probability")
    if isinstance(value, int | float):
        return round(float(value), 4)
    return None


def _reason(payload: dict[str, Any]) -> str:
    for key in ("error_message", "error", "message"):
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
            "could not read the audio file " + path.name,
            provider=provider,
            retryable=False,
        ) from error
