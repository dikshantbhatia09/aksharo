"""``routing_overrides.fetch_overrides``: the 60s cache, ETag revalidation,

stale-if-error fallback, and the routing-freeze precedence hook (B13b)."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import httpx2
import pytest

from worker_ai import routing_overrides
from worker_ai.settings import Settings, load_settings

from .conftest import VALID_ENV


@dataclass
class _FakeResponse:
    status_code: int
    _json: object = None
    headers: dict[str, str] | None = None

    def __post_init__(self) -> None:
        if self.headers is None:
            self.headers = {}

    def json(self) -> object:
        if self._json is None:
            raise ValueError("no body")
        return self._json


@pytest.fixture(autouse=True)
def _reset_cache() -> Iterator[None]:
    routing_overrides.reset_cache_for_tests()
    yield
    routing_overrides.reset_cache_for_tests()


def _settings() -> Settings:
    return load_settings(dict(VALID_ENV))


def test_a_fresh_fetch_returns_the_parsed_body_and_caches_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, str]] = []

    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        calls.append(headers)
        return _FakeResponse(
            status_code=200,
            _json={"lanes": {"hindi": {"candidates": {"sarvam": {"weight": 10}}}}},
            headers={"etag": 'W/"abc"'},
        )

    monkeypatch.setattr(httpx2, "get", fake_get)
    settings = _settings()

    result = routing_overrides.fetch_overrides(settings)

    assert result == {"lanes": {"hindi": {"candidates": {"sarvam": {"weight": 10}}}}}
    assert len(calls) == 1
    assert "if-none-match" not in calls[0]


def test_within_the_60s_window_the_cache_answers_with_no_network_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"count": 0}

    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        calls["count"] += 1
        return _FakeResponse(status_code=200, _json={"lanes": {}}, headers={"etag": 'W/"x"'})

    monkeypatch.setattr(httpx2, "get", fake_get)
    settings = _settings()

    first = routing_overrides.fetch_overrides(settings)
    second = routing_overrides.fetch_overrides(settings)

    assert first == second == {"lanes": {}}
    assert calls["count"] == 1


def test_past_the_cache_window_a_304_keeps_the_cached_body_and_sends_if_none_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    routing_overrides._cache[settings.api_origin] = routing_overrides._CacheEntry(
        body={"lanes": {"hindi": {}}},
        etag='W/"prev"',
        fetched_at=0.0,  # far enough in the past to be stale
    )
    seen_headers: dict[str, str] = {}

    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        seen_headers.update(headers)
        return _FakeResponse(status_code=304)

    monkeypatch.setattr(httpx2, "get", fake_get)

    result = routing_overrides.fetch_overrides(settings)

    assert result == {"lanes": {"hindi": {}}}
    assert seen_headers.get("if-none-match") == 'W/"prev"'


def test_a_network_error_falls_back_to_the_last_cached_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings()
    routing_overrides._cache[settings.api_origin] = routing_overrides._CacheEntry(
        body={"lanes": {"hindi": {}}},
        etag='W/"prev"',
        fetched_at=0.0,
    )

    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        raise httpx2.ConnectError("boom")

    monkeypatch.setattr(httpx2, "get", fake_get)

    assert routing_overrides.fetch_overrides(settings) == {"lanes": {"hindi": {}}}


def test_a_network_error_with_nothing_cached_yet_is_empty_not_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        raise httpx2.ConnectError("boom")

    monkeypatch.setattr(httpx2, "get", fake_get)

    assert routing_overrides.fetch_overrides(_settings()) == {}


def test_a_404_is_not_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        return _FakeResponse(status_code=404)

    monkeypatch.setattr(httpx2, "get", fake_get)
    assert routing_overrides.fetch_overrides(_settings()) == {}


@dataclass
class _FrozenSettings:
    """Stands in for D08's future ``Settings.routing_freeze`` flag.

    ``Settings`` is a frozen, ``slots=True`` dataclass with no such attribute
    yet (D08 lands it in a parallel WP), so this is a minimal stand-in with
    just what ``fetch_overrides`` reads (`routing_overrides._OverrideSettings`,
    a `Protocol` both this and the real `Settings` satisfy structurally) —
    proof of the precedence rule ahead of the real attribute existing, per
    this WP's coordination note.
    """

    api_origin: str
    internal_callback_secret: str
    routing_freeze: bool = True


def test_a_routing_freeze_skips_the_network_call_entirely(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        calls["count"] += 1
        return _FakeResponse(status_code=200, _json={"lanes": {}})

    monkeypatch.setattr(httpx2, "get", fake_get)
    settings = _FrozenSettings(api_origin="http://api.invalid", internal_callback_secret="s")

    result = routing_overrides.fetch_overrides(settings)

    assert result == {}
    assert calls["count"] == 0


def test_no_freeze_attribute_behaves_as_unfrozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """Today's real ``Settings`` has no ``routing_freeze`` at all — must not skip."""

    def fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        return _FakeResponse(status_code=200, _json={"lanes": {}})

    monkeypatch.setattr(httpx2, "get", fake_get)
    assert routing_overrides.fetch_overrides(_settings()) == {"lanes": {}}
