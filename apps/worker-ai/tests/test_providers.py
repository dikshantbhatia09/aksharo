"""The Provider interface: signatures only in A01, but they must be usable."""

from __future__ import annotations

import inspect

import pytest

from worker_ai.providers import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderError,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)


class _StubProvider(Provider):
    """Minimal implementation proving the interface is implementable."""

    name = "stub"
    capabilities = frozenset({"transcribe"})

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        return TranscriptionResult(
            words=(Word(s=request.offset_ms, e=request.offset_ms + 500, t="namaste"),),
            language=request.language or "hi-IN",
        )

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError


def test_provider_is_abstract() -> None:
    with pytest.raises(TypeError):
        Provider()  # type: ignore[abstract]


def test_every_capability_method_is_async() -> None:
    for name in ("transcribe", "align", "diarise"):
        assert inspect.iscoroutinefunction(getattr(Provider, name)), name


def test_supports_reports_declared_capabilities() -> None:
    provider = _StubProvider()
    assert provider.supports("transcribe") is True
    assert provider.supports("align") is False
    assert provider.supports("diarise") is False


async def test_transcribe_returns_words_with_millisecond_timings() -> None:
    provider = _StubProvider()
    result = await provider.transcribe(
        TranscriptionRequest(audio_uri="file:///tmp/audio16k.wav", offset_ms=1_000)
    )
    assert result.language == "hi-IN"
    assert len(result.words) == 1
    word = result.words[0]
    assert (word.s, word.e, word.t) == (1_000, 1_500, "namaste")
    assert word.scripts == {}
    assert word.filler is False


def test_words_are_immutable() -> None:
    """Frozen dataclasses stop a pass from mutating transcript data in place."""
    word = Word(s=0, e=100, t="hi")
    with pytest.raises((AttributeError, TypeError)):
        word.t = "bye"  # type: ignore[misc]


def test_provider_error_carries_retryability() -> None:
    transient = ProviderError("429 from provider", provider="sarvam")
    fatal = ProviderError("audio rejected", provider="sarvam", retryable=False)
    assert transient.retryable is True
    assert fatal.retryable is False
    assert fatal.provider == "sarvam"
