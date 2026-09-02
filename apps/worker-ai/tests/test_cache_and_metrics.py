"""The `09 §1` result cache, and the per-provider metrics it reports into."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from worker_ai.cache import (
    CACHE_TTL_S,
    MemoryResultCache,
    NullResultCache,
    RedisResultCache,
    cache_key,
    content_hash,
    decode_result,
    encode_result,
)
from worker_ai.metrics import AsrMetrics, MetricKey
from worker_ai.providers.base import (
    ProviderSubmission,
    ProviderUsage,
    TranscriptionResult,
    Word,
)

RESULT = TranscriptionResult(
    words=(Word(s=120, e=440, t="toh", c=0.94, sp="S1"), Word(s=480, e=800, t="aaj")),
    language="hi-en",
    language_confidence=0.91,
    usage=ProviderUsage(media_seconds=4.0, provider="sarvam", model="saaras:v4", cost_minor=4),
    segments=((120, 800, "toh aaj"),),
    submissions=(
        ProviderSubmission(
            provider="sarvam", endpoint="https://api/x", artefact="a.wav", external_ref="job-1"
        ),
    ),
    raw={"mode": "codemix"},
)


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------


def test_the_key_is_content_language_provider_and_model() -> None:
    """`09 §1` names the four; a change in any of them is a different transcript."""
    key = cache_key(content="abc", language="hi", provider="sarvam", model="saaras:v4")
    assert key.startswith("montaj:asr:v1:")
    assert cache_key(content="def", language="hi", provider="sarvam", model="saaras:v4") != key
    assert cache_key(content="abc", language="hi-en", provider="sarvam", model="saaras:v4") != key
    assert cache_key(content="abc", language="hi", provider="elevenlabs", model="saaras:v4") != key
    assert cache_key(content="abc", language="hi", provider="sarvam", model="saaras:v3") != key
    # The lane's mode changes the transcript of the same bytes.
    assert (
        cache_key(
            content="abc", language="hi", provider="sarvam", model="saaras:v4", mode="verbatim"
        )
        != key
    )


def test_two_chunks_of_one_file_do_not_collide() -> None:
    """Without the span, chunk 0's words would be served for chunk 3."""
    first = cache_key(
        content="abc",
        language="hi",
        provider="elevenlabs",
        model="scribe_v2",
        offset_ms=0,
        duration_ms=600_000,
    )
    second = cache_key(
        content="abc",
        language="hi",
        provider="elevenlabs",
        model="scribe_v2",
        offset_ms=600_000,
        duration_ms=600_000,
    )
    assert first != second


def test_the_content_hash_is_stable_and_streamed(tmp_path: Path) -> None:
    path = tmp_path / "audio.wav"
    path.write_bytes(b"x" * (3 * 1024 * 1024))
    assert content_hash(path) == content_hash(path, chunk_bytes=1024)
    assert len(content_hash(path)) == 64


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------


def test_a_result_survives_the_round_trip_and_is_marked_cached() -> None:
    restored = decode_result(encode_result(RESULT))
    assert restored is not None
    assert [(word.s, word.e, word.t, word.sp) for word in restored.words] == [
        (120, 440, "toh", "S1"),
        (480, 800, "aaj", None),
    ]
    assert restored.language == "hi-en"
    assert restored.segments == ((120, 800, "toh aaj"),)
    assert restored.submissions[0].external_ref == "job-1"
    assert restored.usage is not None
    assert restored.usage.cost_minor == 4
    # The marker the pipeline reads to write `usage.cached`.
    assert restored.raw["cached"] is True
    assert restored.raw["mode"] == "codemix"


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        '{"v": 99, "words": []}',  # a shape from another version
        '{"v": 1, "words": [], "segments": []}',  # nothing usable
    ],
)
def test_a_corrupt_or_stale_entry_reads_as_a_miss(raw: str) -> None:
    assert decode_result(raw) is None


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


async def test_the_null_cache_always_misses() -> None:
    cache = NullResultCache()
    assert await cache.set("k", RESULT) is False
    assert await cache.get("k") is None
    assert cache.describe()["backend"] == "none"


async def test_the_memory_cache_round_trips() -> None:
    cache = MemoryResultCache()
    assert await cache.set("k", RESULT) is True
    restored = await cache.get("k")
    assert restored is not None
    assert restored.language == "hi-en"
    assert await cache.get("other") is None


async def test_an_oversized_entry_is_refused_rather_than_stored() -> None:
    """A six-hour transcript in Redis is a memory incident waiting for a Tuesday."""
    cache = MemoryResultCache(max_entry_bytes=16)
    assert await cache.set("k", RESULT) is False
    assert await cache.get("k") is None


class _FakeRedis:
    def __init__(self, *, fail: bool = False) -> None:
        self.entries: dict[str, tuple[str, int]] = {}
        self.fail = fail
        self.closed = False

    async def get(self, key: str) -> str | None:
        if self.fail:
            raise ConnectionError("redis is down")
        entry = self.entries.get(key)
        return entry[0] if entry else None

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        if self.fail:
            raise ConnectionError("redis is down")
        self.entries[key] = (value, ex or 0)

    async def aclose(self) -> None:
        self.closed = True


async def test_redis_stores_with_the_thirty_day_ttl() -> None:
    client = _FakeRedis()
    cache = RedisResultCache("redis://x", client=client)
    assert await cache.set("k", RESULT) is True
    assert client.entries["k"][1] == CACHE_TTL_S
    restored = await cache.get("k")
    assert restored is not None
    assert restored.raw["cached"] is True


async def test_a_cache_outage_is_a_miss_not_a_failure() -> None:
    """A cache that is down must slow the pipeline, never break it."""
    cache = RedisResultCache("redis://x", client=_FakeRedis(fail=True))
    assert await cache.get("k") is None
    assert await cache.set("k", RESULT) is False
    await cache.aclose()


async def test_redis_describes_itself_for_the_control_app() -> None:
    cache = RedisResultCache("redis://x", client=_FakeRedis(), max_entry_bytes=1234)
    described = cache.describe()
    assert described == {"backend": "redis", "ttlS": CACHE_TTL_S, "maxEntryBytes": 1234}


def test_the_cache_backend_follows_the_environment() -> None:
    from worker_ai.runtime import build_cache
    from worker_ai.settings import load_settings

    from .conftest import VALID_ENV

    assert build_cache(load_settings(VALID_ENV)).name == "redis"
    assert build_cache(load_settings({**VALID_ENV, "WORKER_AI_CACHE": "memory"})).name == "memory"
    assert build_cache(load_settings({**VALID_ENV, "WORKER_AI_CACHE": "none"})).name == "none"


def test_an_unknown_cache_backend_is_refused_at_boot() -> None:
    from worker_ai.settings import EnvValidationError, load_settings

    from .conftest import VALID_ENV

    with pytest.raises(EnvValidationError, match="WORKER_AI_CACHE"):
        load_settings({**VALID_ENV, "WORKER_AI_CACHE": "memcached"})


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def test_metrics_count_by_provider_language_and_lane() -> None:
    metrics = AsrMetrics()
    key = MetricKey(provider="sarvam", language="hi-en", lane="hinglish")
    metrics.record_call(key, outcome="ok", media_seconds=60.0, cost_minor=53)
    metrics.record_call(key, outcome="ok", media_seconds=60.0, cost_minor=53)
    metrics.record_call(key, outcome="error")

    snapshot = metrics.snapshot()
    counts = {(row["outcome"], row["count"]) for row in snapshot["calls"]}
    assert counts == {("ok", 2), ("error", 1)}
    assert snapshot["costMinor"][0]["minor"] == 106


def test_metric_labels_are_escaped() -> None:
    metrics = AsrMetrics()
    metrics.record_call(
        MetricKey(provider='we"ird', language="hi", lane="global"), outcome="ok"
    )
    assert 'provider="we\\"ird"' in metrics.render()


def test_a_missing_label_reads_as_unknown_rather_than_empty() -> None:
    metrics = AsrMetrics()
    metrics.record_call(MetricKey(provider="", language="", lane=""), outcome="ok")
    assert 'provider="unknown"' in metrics.render()


def test_reset_clears_every_counter() -> None:
    metrics = AsrMetrics()
    metrics.record_call(MetricKey(provider="a", language="b", lane="c"), outcome="ok")
    metrics.record_cache(hit=True)
    metrics.record_fallback(from_provider="a", to_provider="b")
    metrics.reset()
    snapshot: dict[str, Any] = metrics.snapshot()
    assert snapshot["calls"] == []
    assert snapshot["cache"] == {}
    assert snapshot["fallbacks"] == []
