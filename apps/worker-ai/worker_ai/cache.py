"""Result cache: the same audio never pays a vendor twice (`09 §1`).

Keyed by ``contentHash + language + provider + model`` exactly as `09 §1` says,
with the lane's ``mode`` folded in because Saaras ``codemix`` and Saaras
``verbatim`` are different transcripts of the same bytes.

Why this matters more than a normal cache: a re-run of a job — a BullMQ retry
after a stall, a user re-transcribing a clip they just transcribed, the eval
harness scoring a set twice — is a **second charge from a vendor** and a second
copy of the audio leaving the building. A cache hit avoids both, and records
``cached: true`` in usage so the API's cost accounting does not double-count.

Three implementations behind one protocol:

* :class:`RedisResultCache` — production. TTL 30 days; entries larger than the
  size cap are simply not stored, because a six-hour transcript in Redis is a
  memory incident waiting for a busy Tuesday.
* :class:`MemoryResultCache` — tests and single-process runs; same semantics,
  same size cap, no TTL expiry (the process is shorter than a TTL).
* :class:`NullResultCache` — no Redis configured. Every read misses, every write
  is dropped, and the pipeline behaves exactly as it did in A09.

The cache stores the **wire form** of a :class:`TranscriptionResult`, not the
dataclass, so a schema change in the adapter cannot resurrect a stale shape:
:func:`decode_result` rejects anything it does not recognise and the caller
treats that as a miss.
"""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from contextlib import suppress
from pathlib import Path
from typing import Any

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import (
    ProviderSubmission,
    ProviderUsage,
    TranscriptionResult,
    Word,
)

__all__ = [
    "CACHE_TTL_S",
    "DEFAULT_MAX_ENTRY_BYTES",
    "MemoryResultCache",
    "NullResultCache",
    "RedisResultCache",
    "ResultCache",
    "cache_key",
    "content_hash",
    "decode_result",
    "encode_result",
]

_log = get_logger(__name__)

#: `09 §1`: thirty days.
CACHE_TTL_S = 30 * 24 * 60 * 60

#: Entries above this are not stored. 512 KB is roughly an hour of dense words.
DEFAULT_MAX_ENTRY_BYTES = 512 * 1024

#: Key namespace; the queue prefix is BullMQ's, this one is ours.
_NAMESPACE = "montaj:asr:v1"

#: Version stamp inside the value, so a shape change invalidates old entries
#: without anyone having to remember to flush Redis.
_ENCODING_VERSION = 1


def content_hash(path: Path, *, chunk_bytes: int = 1024 * 1024) -> str:
    """SHA-256 of a file, streamed.

    The media worker will eventually put a content hash on the media row; until
    it does, hashing the derived ``audio16k.wav`` is both correct and cheap
    relative to a vendor call.
    """
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk_bytes)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def cache_key(
    *,
    content: str,
    language: str,
    provider: str,
    model: str,
    mode: str = "",
    offset_ms: int = 0,
    duration_ms: int = 0,
) -> str:
    """The `09 §1` key, plus the chunk span so two chunks never collide.

    ``contentHash`` identifies the *file*; a ten-minute chunk of it is identified
    by the span as well, and leaving the span out would serve chunk 0's words for
    chunk 3.
    """
    material = "|".join(
        (
            content,
            language or "auto",
            provider,
            model,
            mode,
            str(offset_ms),
            str(duration_ms),
        )
    )
    return _NAMESPACE + ":" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def encode_result(result: TranscriptionResult) -> str:
    """A transcription result as JSON for the cache."""
    return json.dumps(
        {
            "v": _ENCODING_VERSION,
            "language": result.language,
            "languageConfidence": result.language_confidence,
            "words": [
                {"s": word.s, "e": word.e, "t": word.t, "c": word.c, "sp": word.sp}
                for word in result.words
            ],
            "segments": [list(segment) for segment in result.segments],
            "submissions": [submission.to_wire() for submission in result.submissions],
            "usage": {
                "mediaSeconds": result.usage.media_seconds if result.usage else None,
                "provider": result.usage.provider if result.usage else None,
                "model": result.usage.model if result.usage else None,
                "costMinor": result.usage.cost_minor if result.usage else None,
            },
            "raw": {key: value for key, value in result.raw.items() if _jsonable(value)},
        },
        separators=(",", ":"),
    )


def decode_result(raw: str) -> TranscriptionResult | None:
    """Parse a cached entry; ``None`` when it is from another shape or corrupt."""
    try:
        parsed: Any = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(parsed, dict) or parsed.get("v") != _ENCODING_VERSION:
        return None

    words = tuple(
        Word(
            s=int(item["s"]),
            e=int(item["e"]),
            t=str(item["t"]),
            c=item.get("c"),
            sp=item.get("sp"),
        )
        for item in parsed.get("words", [])
        if isinstance(item, dict) and "s" in item and "e" in item and "t" in item
    )
    segments = tuple(
        (int(item[0]), int(item[1]), str(item[2]))
        for item in parsed.get("segments", [])
        if isinstance(item, list) and len(item) == 3
    )
    if not words and not segments:
        return None

    usage_raw = parsed.get("usage") or {}
    usage = ProviderUsage(
        media_seconds=usage_raw.get("mediaSeconds"),
        provider=usage_raw.get("provider"),
        model=usage_raw.get("model"),
        cost_minor=usage_raw.get("costMinor"),
    )
    submissions = tuple(
        ProviderSubmission(
            provider=str(item.get("provider", "")),
            endpoint=str(item.get("endpoint", "")),
            artefact=str(item.get("artefact", "")),
            external_ref=item.get("externalRef"),
            region=item.get("region"),
            retention_class=item.get("retentionClass"),
        )
        for item in parsed.get("submissions", [])
        if isinstance(item, dict)
    )
    raw_extra = parsed.get("raw")
    return TranscriptionResult(
        words=words,
        language=str(parsed.get("language") or ""),
        language_confidence=parsed.get("languageConfidence"),
        usage=usage,
        segments=segments,
        submissions=submissions,
        raw={**(raw_extra if isinstance(raw_extra, dict) else {}), "cached": True},
    )


class ResultCache(ABC):
    """Where a transcription result is remembered between jobs."""

    name: str = "abstract"

    @abstractmethod
    async def get(self, key: str) -> TranscriptionResult | None:
        """The cached result for ``key``, or ``None``."""
        raise NotImplementedError

    @abstractmethod
    async def set(self, key: str, result: TranscriptionResult) -> bool:
        """Store ``result``; ``False`` when it was refused (too large, no store)."""
        raise NotImplementedError

    async def aclose(self) -> None:
        """Release any connection. Idempotent; the default is a no-op."""
        return None

    def describe(self) -> dict[str, Any]:
        return {"backend": self.name, "ttlS": CACHE_TTL_S}


class NullResultCache(ResultCache):
    """No cache: every read misses and every write is dropped."""

    name = "none"

    async def get(self, key: str) -> TranscriptionResult | None:
        del key
        return None

    async def set(self, key: str, result: TranscriptionResult) -> bool:
        del key, result
        return False


class MemoryResultCache(ResultCache):
    """A process-local dictionary with the same size cap as the real one."""

    name = "memory"

    def __init__(self, *, max_entry_bytes: int = DEFAULT_MAX_ENTRY_BYTES) -> None:
        self._entries: dict[str, str] = {}
        self._max_entry_bytes = max_entry_bytes

    async def get(self, key: str) -> TranscriptionResult | None:
        raw = self._entries.get(key)
        return decode_result(raw) if raw is not None else None

    async def set(self, key: str, result: TranscriptionResult) -> bool:
        encoded = encode_result(result)
        if len(encoded.encode("utf-8")) > self._max_entry_bytes:
            return False
        self._entries[key] = encoded
        return True


class RedisResultCache(ResultCache):
    """Redis-backed, 30-day TTL, with a per-entry size cap.

    The client is created lazily from ``REDIS_URL`` and every failure is
    swallowed: a cache that is down must slow the pipeline, never break it, so a
    read error is a miss and a write error is a dropped write.
    """

    name = "redis"

    def __init__(
        self,
        redis_url: str,
        *,
        ttl_s: int = CACHE_TTL_S,
        max_entry_bytes: int = DEFAULT_MAX_ENTRY_BYTES,
        client: Any = None,
    ) -> None:
        self._url = redis_url
        self._ttl_s = ttl_s
        self._max_entry_bytes = max_entry_bytes
        self._client = client
        self._owns_client = client is None

    def _connect(self) -> Any:
        if self._client is None:
            from redis.asyncio import Redis

            self._client = Redis.from_url(self._url, decode_responses=True)
        return self._client

    async def get(self, key: str) -> TranscriptionResult | None:
        try:
            raw = await self._connect().get(key)
        except Exception as error:  # a cache miss is always a safe answer
            _log.warning("result cache read failed", extra={"reason": str(error)[:200]})
            return None
        if not isinstance(raw, str):
            return None
        return decode_result(raw)

    async def set(self, key: str, result: TranscriptionResult) -> bool:
        encoded = encode_result(result)
        if len(encoded.encode("utf-8")) > self._max_entry_bytes:
            _log.info("result too large to cache", extra={"bytes": len(encoded)})
            return False
        try:
            await self._connect().set(key, encoded, ex=self._ttl_s)
        except Exception as error:
            _log.warning("result cache write failed", extra={"reason": str(error)[:200]})
            return False
        return True

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            with suppress(Exception):  # pragma: no cover - shutdown is best effort
                await self._client.aclose()
        self._client = None

    def describe(self) -> dict[str, Any]:
        return {"backend": self.name, "ttlS": self._ttl_s, "maxEntryBytes": self._max_entry_bytes}


def _jsonable(value: Any) -> bool:
    return isinstance(value, str | int | float | bool | list | dict | type(None))
