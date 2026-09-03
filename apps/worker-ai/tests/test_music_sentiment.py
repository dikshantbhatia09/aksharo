"""`worker_ai.passes.music.sentiment` — the D05 follow-up's `music-mood@1`
seam (brief §2): scores through B11's LLM client, with the lexicon scorer as
its offline fallback, one clearly reported `source` either way."""

from __future__ import annotations

import pytest

from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmResponse
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.passes.music.sentiment import (
    SentenceInput,
    lexicon_cues,
    lexicon_score,
    score_sentiment,
)


class _AlwaysFailsProvider(LlmProvider):
    name = "always-fails"
    supported_regions = frozenset({"in", "eu", "us"})

    async def generate(self, request: LlmRequest) -> LlmResponse:  # pragma: no cover - unused
        raise LlmError("boom", provider=self.name, retryable=False)


def test_lexicon_score_is_deterministic_and_grounded() -> None:
    assert lexicon_score("this is amazing and awesome") > 0
    assert lexicon_score("this is terrible and the worst") < 0
    assert lexicon_score("") == 0.0
    assert lexicon_score("no sentiment words here at all") <= 0  # "no" is negative


def test_lexicon_cues_pairs_midpoint_with_score() -> None:
    sentences = [SentenceInput(start_ms=1_000, end_ms=3_000, text="great and amazing")]
    cues = lexicon_cues(sentences)
    assert cues == [(2_000, lexicon_score("great and amazing"))]


@pytest.mark.asyncio
async def test_score_sentiment_empty_sentences_short_circuits_to_lexicon() -> None:
    cues, source = await score_sentiment([], llm_providers=(MockLlmProvider(),), region="in")
    assert cues == []
    assert source == "lexicon"


@pytest.mark.asyncio
async def test_score_sentiment_uses_the_llm_seam_when_it_succeeds() -> None:
    sentences = [
        SentenceInput(start_ms=0, end_ms=2_000, text="this is the best and most amazing win"),
        SentenceInput(start_ms=2_000, end_ms=4_000, text="this is terrible and the worst"),
    ]
    cues, source = await score_sentiment(
        sentences, llm_providers=(MockLlmProvider(),), region="in", language="en"
    )
    assert source == "llm"
    assert len(cues) == 2
    assert cues[0][1] > 0
    assert cues[1][1] < 0


@pytest.mark.asyncio
async def test_score_sentiment_falls_back_to_lexicon_when_every_provider_fails() -> None:
    sentences = [SentenceInput(start_ms=0, end_ms=2_000, text="this is amazing and awesome")]
    cues, source = await score_sentiment(
        sentences, llm_providers=(_AlwaysFailsProvider(),), region="in"
    )
    assert source == "lexicon"
    assert cues == lexicon_cues(sentences)


@pytest.mark.asyncio
async def test_score_sentiment_falls_back_to_lexicon_on_a_region_block() -> None:
    sentences = [SentenceInput(start_ms=0, end_ms=2_000, text="great fun")]
    eu_only = _AlwaysFailsProvider()
    eu_only.supported_regions = frozenset({"eu"})
    cues, source = await score_sentiment(sentences, llm_providers=(eu_only,), region="in")
    assert source == "lexicon"
    assert cues == lexicon_cues(sentences)
