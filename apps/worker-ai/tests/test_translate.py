"""Translation: glossary preservation, length-aware retry, provider chain fallback,
the three vendor adapters against fixtures, and the `ai.translate` processor."""

from __future__ import annotations

import json

import httpx2
import pytest

from worker_ai.callbacks import CallbackAck, CallbackError
from worker_ai.processors import process_translate
from worker_ai.processors.context import JobFailureError
from worker_ai.providers.base import ProviderError
from worker_ai.translate import AllProvidersFailedError, translate_segments
from worker_ai.translate.glossary import mask_glossary_terms, unmask_glossary_terms
from worker_ai.translate.length import MAX_LENGTH_RATIO, exceeds_budget, truncate_to_budget
from worker_ai.translate.providers.base import (
    TranslatedSegment,
    TranslationProvider,
    TranslationRequest,
    TranslationResult,
    TranslationSegment,
)
from worker_ai.translate.providers.indictrans2 import IndicTrans2Provider
from worker_ai.translate.providers.llm import LLMTranslateProvider
from worker_ai.translate.providers.sarvam_mayura import SarvamMayuraProvider

from .test_processors import build_services, context_for, recorder

# ---------------------------------------------------------------------------
# Glossary masking
# ---------------------------------------------------------------------------


def test_glossary_terms_are_masked_case_insensitively_and_whole_word() -> None:
    masked = mask_glossary_terms("Aksharo Panel makes captions fast", ("Aksharo",))
    assert "Aksharo" not in masked.text
    assert "⟦G0⟧" in masked.text
    assert masked.terms["⟦G0⟧"] == "Aksharo"


def test_glossary_masking_skips_a_substring_match() -> None:
    masked = mask_glossary_terms("the panelist spoke", ("panel",))
    # "panelist" contains "panel" but is not the whole word "panel".
    assert masked.text == "the panelist spoke"
    assert masked.terms == {}


def test_glossary_unmasking_restores_every_term() -> None:
    masked = mask_glossary_terms("Aksharo and Aksharo again", ("Aksharo",))
    restored = unmask_glossary_terms(masked.text, masked.terms)
    assert restored == "Aksharo and Aksharo again"


def test_longer_terms_are_masked_before_their_substrings() -> None:
    masked = mask_glossary_terms("Aksharo Panel is great", ("Aksharo", "Aksharo Panel"))
    restored = unmask_glossary_terms(masked.text, masked.terms)
    assert restored == "Aksharo Panel is great"
    assert "Aksharo Panel" not in masked.text


def test_a_text_already_carrying_placeholder_brackets_is_left_unmasked() -> None:
    masked = mask_glossary_terms("already ⟦G0⟧ marked", ("marked",))
    assert masked.terms == {}
    assert masked.text == "already ⟦G0⟧ marked"


# ---------------------------------------------------------------------------
# Length budget
# ---------------------------------------------------------------------------


def test_exceeds_budget_at_1_3x_source_length() -> None:
    source = "a" * 10
    assert exceeds_budget(source, "b" * 13) is False
    assert exceeds_budget(source, "b" * 14) is True


def test_an_empty_source_never_exceeds_budget() -> None:
    assert exceeds_budget("", "anything") is False


def test_truncate_to_budget_cuts_on_a_word_boundary_and_marks_it() -> None:
    source = "short"
    truncated = truncate_to_budget(source, "this translation is far too long for the caption box")
    assert len(truncated) <= len(source) * MAX_LENGTH_RATIO
    assert truncated.endswith("…")


def test_truncate_to_budget_is_a_no_op_when_already_within_budget() -> None:
    assert truncate_to_budget("hello", "hi") == "hi"


# ---------------------------------------------------------------------------
# Fake providers for the orchestration tests
# ---------------------------------------------------------------------------


class _FailingProvider(TranslationProvider):
    name = "failing"

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        raise ProviderError("always fails", provider=self.name, retryable=True)


class _EchoProvider(TranslationProvider):
    """Prefixes every segment with `[lang]`; doubles it when `shorter` is False,
    so a plain call is deliberately over budget and a `shorter` retry is not —
    this is what exercises the length-aware retry path end to end."""

    name = "echo"

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        segments = tuple(
            TranslatedSegment(
                segment_id=segment.segment_id,
                text=segment.text if segment.shorter else segment.text * 3,
            )
            for segment in request.segments
        )
        return TranslationResult(segments=segments)


class _DropsASegmentProvider(TranslationProvider):
    name = "drops-a-segment"

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        segments = tuple(
            TranslatedSegment(segment_id=segment.segment_id, text=segment.text)
            for segment in request.segments[:-1]
        )
        return TranslationResult(segments=segments)


# ---------------------------------------------------------------------------
# Provider chain and length-aware retry (orchestration)
# ---------------------------------------------------------------------------


async def test_provider_chain_falls_through_to_the_next_provider_on_failure() -> None:
    result = await translate_segments(
        (_FailingProvider(), _EchoProvider()),
        segments=(("s1", "hi"),),
        source_language="hi",
        target_language="en",
    )
    assert result.provider == "echo"


async def test_every_provider_failing_raises_all_providers_failed() -> None:
    with pytest.raises(AllProvidersFailedError):
        await translate_segments(
            (_FailingProvider(),),
            segments=(("s1", "hi"),),
            source_language="hi",
            target_language="en",
        )


async def test_no_segment_exceeds_the_length_budget_after_retries() -> None:
    """Acceptance criterion 2: no segment exceeds 1.3x source length, ever."""
    result = await translate_segments(
        (_EchoProvider(),),
        segments=(("s1", "short"),),
        source_language="hi",
        target_language="en",
    )
    translated = result.segments[0]
    assert len(translated.text) <= len("short") * MAX_LENGTH_RATIO
    # The retry (shorter=True) brought it back under budget on its own.
    assert result.length_retries >= 1
    assert translated.truncated is False


async def test_a_provider_that_stays_over_budget_is_hard_truncated() -> None:
    class _AlwaysLong(TranslationProvider):
        name = "always-long"

        async def translate(self, request: TranslationRequest) -> TranslationResult:
            return TranslationResult(
                segments=tuple(
                    TranslatedSegment(segment_id=s.segment_id, text="x" * 100)
                    for s in request.segments
                )
            )

    result = await translate_segments(
        (_AlwaysLong(),),
        segments=(("s1", "hi"),),
        source_language="hi",
        target_language="en",
    )
    translated = result.segments[0]
    assert len(translated.text) <= len("hi") * MAX_LENGTH_RATIO
    assert translated.truncated is True


async def test_glossary_terms_survive_translation() -> None:
    class _UppercasingProvider(TranslationProvider):
        name = "uppercase"

        async def translate(self, request: TranslationRequest) -> TranslationResult:
            return TranslationResult(
                segments=tuple(
                    TranslatedSegment(segment_id=s.segment_id, text=s.text.upper())
                    for s in request.segments
                )
            )

    result = await translate_segments(
        (_UppercasingProvider(),),
        segments=(("s1", "we love Aksharo so much"),),
        source_language="en",
        target_language="hi",
        glossary=("Aksharo",),
    )
    # Everything except the glossary term was upper-cased by the fake provider;
    # "Aksharo" itself survived untouched because it was masked before the call.
    assert result.segments[0].text == "WE LOVE Aksharo SO MUCH"


async def test_a_provider_that_drops_a_segment_is_rejected() -> None:
    with pytest.raises(ValueError, match="segments"):
        await translate_segments(
            (_DropsASegmentProvider(),),
            segments=(("s1", "a"), ("s2", "b")),
            source_language="hi",
            target_language="en",
        )


async def test_translate_segments_needs_at_least_one_provider() -> None:
    with pytest.raises(ValueError, match="at least one provider"):
        await translate_segments(
            (), segments=(("s1", "a"),), source_language="hi", target_language="en"
        )


async def test_empty_segments_short_circuits_without_calling_a_provider() -> None:
    result = await translate_segments(
        (_FailingProvider(),), segments=(), source_language="hi", target_language="en"
    )
    assert result.segments == ()


# ---------------------------------------------------------------------------
# Sarvam Mayura (fixture-driven; no vendor key exists — A00-06)
# ---------------------------------------------------------------------------


async def test_sarvam_mayura_translates_one_call_per_segment() -> None:
    seen: list[dict[str, object]] = []

    async def handler(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        seen.append(body)
        return httpx2.Response(200, json={"translated_text": f"[en] {body['input']}"})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    provider = SarvamMayuraProvider(api_key="k" * 8, client=client)
    request = TranslationRequest(
        segments=(TranslationSegment(segment_id="s1", text="यह अच्छा है"),),
        source_language="hi",
        target_language="en",
    )
    result = await provider.translate(request)
    await provider.aclose()

    assert result.segments[0].text == "[en] यह अच्छा है"
    assert seen[0]["target_language_code"] == "en-IN"
    assert result.submissions[0].provider == "sarvam-mayura"


async def test_sarvam_mayura_raises_on_a_malformed_response() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"nothing": "useful"})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    provider = SarvamMayuraProvider(api_key="k" * 8, client=client)

    request = TranslationRequest(
        segments=(TranslationSegment(segment_id="s1", text="hi"),),
        source_language="hi",
        target_language="en",
    )
    with pytest.raises(ProviderError):
        await provider.translate(request)
    await provider.aclose()


def test_sarvam_mayura_needs_an_api_key() -> None:
    with pytest.raises(ValueError, match="SARVAM_API_KEY"):
        SarvamMayuraProvider(api_key="")


# ---------------------------------------------------------------------------
# IndicTrans2 (self-hosted, optional; fixture-driven)
# ---------------------------------------------------------------------------


async def test_indictrans2_translates_the_whole_batch_in_one_call() -> None:
    calls: list[int] = []

    async def handler(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        calls.append(len(body["sentences"]))
        return httpx2.Response(200, json={"translations": ["one", "two"]})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    provider = IndicTrans2Provider(base_url="https://indictrans2.invalid", client=client)
    request = TranslationRequest(
        segments=(
            TranslationSegment(segment_id="s1", text="पहला"),
            TranslationSegment(segment_id="s2", text="दूसरा"),
        ),
        source_language="hi",
        target_language="en",
    )
    result = await provider.translate(request)
    await provider.aclose()

    assert calls == [2]  # one HTTP call for the whole batch
    assert [s.text for s in result.segments] == ["one", "two"]


def test_indictrans2_needs_a_base_url() -> None:
    with pytest.raises(ValueError, match="base_url"):
        IndicTrans2Provider(base_url="")


# ---------------------------------------------------------------------------
# LLM adapter — mock mode needs no network
# ---------------------------------------------------------------------------


async def test_llm_mock_provider_needs_no_credential() -> None:
    provider = LLMTranslateProvider(provider="mock")
    request = TranslationRequest(
        segments=(TranslationSegment(segment_id="s1", text="hello"),),
        source_language="en",
        target_language="hi",
    )
    result = await provider.translate(request)
    assert "hello" in result.segments[0].text
    assert result.submissions == ()


async def test_llm_mock_shorter_retry_actually_shortens() -> None:
    provider = LLMTranslateProvider(provider="mock")
    long_request = TranslationRequest(
        segments=(TranslationSegment(segment_id="s1", text="a fairly long sentence"),),
        source_language="en",
        target_language="hi",
    )
    shorter_request = TranslationRequest(
        segments=(
            TranslationSegment(segment_id="s1", text="a fairly long sentence", shorter=True),
        ),
        source_language="en",
        target_language="hi",
    )
    normal = await provider.translate(long_request)
    shorter = await provider.translate(shorter_request)
    assert len(shorter.segments[0].text) < len(normal.segments[0].text)


def test_llm_provider_rejects_an_unknown_provider_name() -> None:
    with pytest.raises(ValueError, match="unknown provider"):
        LLMTranslateProvider(provider="not-a-real-provider")


def test_llm_anthropic_needs_a_key() -> None:
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        LLMTranslateProvider(provider="anthropic")


async def test_llm_anthropic_calls_the_messages_api() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        assert request.headers["x-api-key"] == "secret-key"
        return httpx2.Response(200, json={"content": [{"type": "text", "text": "translated!"}]})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    provider = LLMTranslateProvider(
        provider="anthropic", anthropic_api_key="secret-key", client=client
    )
    request = TranslationRequest(
        segments=(TranslationSegment(segment_id="s1", text="hello"),),
        source_language="en",
        target_language="hi",
    )
    result = await provider.translate(request)
    await provider.aclose()
    assert result.segments[0].text == "translated!"


# ---------------------------------------------------------------------------
# The `ai.translate` processor end to end
# ---------------------------------------------------------------------------


async def test_process_translate_submits_set_segment_text_ops() -> None:
    services = build_services(translation_providers=(_EchoProvider(),))
    context = context_for(
        "ai.translate",
        services=services,
        sourceLanguage="hi",
        targetLanguage="en",
        baseRevision=5,
        segments=[{"segmentId": "seg-1", "text": "short"}],
    )
    outcome = await process_translate(context)

    assert outcome.result["segmentsTranslated"] == 1
    assert outcome.result["provider"] == "echo"
    _project_id, payload = recorder(services).edg_ops_calls[0]
    assert payload["baseRevision"] == 5
    op = payload["ops"][0]
    assert op["type"] == "SetSegmentText"
    assert op["segmentId"] == "seg-1"
    assert op["script"] == "translated"
    assert len(op["opId"]) == 26  # a ULID


async def test_process_translate_maps_a_409_conflict_to_a_clear_error() -> None:
    services = build_services(translation_providers=(_EchoProvider(),))

    async def raising_apply_edg_ops(
        _project_id: str, _attempt_id: str, _payload: dict[str, object]
    ) -> CallbackAck:
        raise CallbackError("conflict", status_code=409)

    services.callbacks.apply_edg_ops = raising_apply_edg_ops  # type: ignore[assignment]

    context = context_for(
        "ai.translate",
        services=services,
        sourceLanguage="hi",
        targetLanguage="en",
        baseRevision=1,
        segments=[{"segmentId": "seg-1", "text": "hi"}],
    )
    with pytest.raises(JobFailureError, match="regenerate to retry") as raised:
        await process_translate(context)
    assert raised.value.retryable is False


async def test_process_translate_rejects_a_negative_base_revision() -> None:
    context = context_for(
        "ai.translate",
        sourceLanguage="hi",
        targetLanguage="en",
        baseRevision=-1,
        segments=[{"segmentId": "seg-1", "text": "hi"}],
    )
    with pytest.raises(JobFailureError, match="baseRevision"):
        await process_translate(context)


async def test_process_translate_surfaces_every_provider_failing() -> None:
    services = build_services(translation_providers=(_FailingProvider(),))
    context = context_for(
        "ai.translate",
        services=services,
        sourceLanguage="hi",
        targetLanguage="en",
        baseRevision=1,
        segments=[{"segmentId": "seg-1", "text": "hi"}],
    )
    with pytest.raises(JobFailureError) as raised:
        await process_translate(context)
    assert raised.value.code == "worker/translation_failed"
