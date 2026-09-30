"""``ai.llm`` kind ``broll`` (2026-10-05): where a picture could cut away in a clip."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from worker_ai.llm.broll import bound_moments, ground_moments, numbered_transcript
from worker_ai.llm.broll_contracts import BROLL_TEMPLATE_VERSION, BrollMoment, BrollRequest
from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.processors.context import JobContext, JobFailureError
from worker_ai.processors.llm import process_llm

from .fake_llm import FakeLlm, failing
from .test_processors import build_services as build_test_services
from .test_processors import context_for

REPO_ROOT = Path(__file__).resolve().parents[3]
REQUEST: dict[str, Any] = json.loads(
    (
        REPO_ROOT / "packages" / "repurpose-contracts" / "fixtures" / "ai-llm-broll-request.v1.json"
    ).read_text(encoding="utf-8")
)


def request(**changes: Any) -> BrollRequest:
    return BrollRequest.model_validate({**REQUEST, **changes})


def moment(start: str, end: str, s: int, e: int, score: int, phrase: str = "thing") -> BrollMoment:
    return BrollMoment(
        startWordId=start,
        endWordId=end,
        startMs=s,
        endMs=e,
        phrase=phrase,
        spoken=phrase,
        score=score,
    )


def test_the_transcript_is_numbered_by_line_and_cut_to_fit() -> None:
    words = request().words
    text = numbered_transcript(words, 10_000)
    assert text.splitlines()[0].startswith("0: Kal subah hum Agra")
    assert text.splitlines()[1].startswith("12: chai aur petha")
    assert numbered_transcript(words, 20) == ""


def test_a_moment_is_kept_only_on_the_words_it_quotes() -> None:
    words = request().words
    grounded = ground_moments(
        {
            "moments": [
                # Off by two words: still found, near where it says.
                {"at": 9, "words": "Taj Mahal", "phrase": "Taj Mahal at sunrise!", "score": 9},
                # Punctuation and case do not matter; the times are the words' own.
                {"at": 11, "words": "MASALA chai", "phrase": "masala chai", "score": 7.4},
                # Quoted words the speaker never said: dropped.
                {"at": 3, "words": "Red Fort", "phrase": "red fort", "score": 10},
                # Too far from where it says.
                {"at": 60, "words": "petha", "phrase": "petha sweet", "score": 6},
                # Unusable entries.
                {"at": 3, "words": "Agra", "phrase": "x", "score": 5},
                "not a moment",
            ]
        },
        words,
    )
    assert [(m.start_word_id, m.end_word_id, m.phrase, m.score) for m in grounded] == [
        ("0:7", "0:8", "taj mahal at sunrise", 9),
        ("0:11", "0:12", "masala chai", 7),
    ]
    assert (grounded[0].start_ms, grounded[0].end_ms, grounded[0].spoken) == (
        4_800,
        5_620,
        "Taj Mahal",
    )
    assert ground_moments({"moments": "none"}, words) == []


def test_the_moments_kept_are_bounded_and_spaced() -> None:
    req = request(maxMoments=2, minGapMs=4_000)
    moments = [
        moment("0:3", "0:3", 1_020, 1_480, 8),  # in the hook: avoided
        moment("0:7", "0:8", 4_800, 5_620, 9),
        moment("0:9", "0:9", 5_660, 6_000, 10),  # 0.86 s after the Taj Mahal: crowded
        moment("0:11", "0:12", 11_200, 12_040, 7),
        moment("0:14", "0:14", 12_300, 12_780, 6),  # a third: over the most
    ]
    kept = bound_moments(moments, req)
    assert [m.start_word_id for m in kept] == ["0:9", "0:11"]


async def test_the_model_proposes_grounded_moments_through_the_processor() -> None:
    def answer(req: LlmRequest) -> Any:
        assert "Never pick a person" in req.system
        assert "<transcript>" in req.user and "Title: Agra trip in one day" in req.user
        return {
            "moments": [
                {"at": 7, "words": "Taj Mahal", "phrase": "taj mahal", "score": 9},
                {"at": 11, "words": "masala chai", "phrase": "masala chai", "score": 7},
                {"at": 0, "words": "Kal subah", "phrase": "morning", "score": 2},
            ]
        }

    fake = FakeLlm(answer, name="sarvam", model="sarvam-105b-conversations")
    fake.no_training = False
    outcome = await process_llm(broll_context((fake,)))
    result = outcome.result

    assert result["templateId"] == "broll"
    assert result["version"] == BROLL_TEMPLATE_VERSION == "broll@1"
    assert result["provider"] == "sarvam"
    assert result["output"] == {
        "schemaVersion": 1,
        "moments": [
            {
                "startWordId": "0:7",
                "endWordId": "0:8",
                "startMs": 4_800,
                "endMs": 5_620,
                "phrase": "taj mahal",
                "spoken": "Taj Mahal",
                "score": 9,
            },
            {
                "startWordId": "0:11",
                "endWordId": "0:12",
                "startMs": 11_200,
                "endMs": 12_040,
                "phrase": "masala chai",
                "spoken": "masala chai",
                "score": 7,
            },
        ],
        "source": "model",
    }
    assert result["providerSubmissions"][0]["provider"] == "sarvam"
    assert outcome.usage is not None and outcome.usage.provider == "sarvam"


async def test_the_chain_moves_on_and_no_answer_is_no_moments() -> None:
    fallback = FakeLlm(
        lambda _r: {"moments": [{"at": 7, "words": "Taj Mahal", "phrase": "taj mahal"}]},
        name="ollama",
        model="qwen2.5:3b",
    )
    outcome = await process_llm(broll_context((failing("sarvam"), fallback)))
    assert outcome.result["provider"] == "ollama"
    assert [m["phrase"] for m in outcome.result["output"]["moments"]] == ["taj mahal"]

    nothing = await process_llm(broll_context((failing("sarvam"), MockLlmProvider())))
    assert nothing.result["provider"] == "none"
    assert nothing.result["output"] == {"schemaVersion": 1, "moments": [], "source": "none"}
    assert nothing.usage is None


async def test_a_reply_that_is_not_the_shape_asked_for_is_the_next_providers_turn() -> None:
    garbled = FakeLlm(lambda _r: "I think the Taj Mahal is nice", name="sarvam")
    down = FakeLlm(lambda _r: LlmError("no", provider="ollama", retryable=False), name="ollama")
    outcome = await process_llm(broll_context((garbled, down)))
    assert outcome.result["output"]["moments"] == []
    assert outcome.result["output"]["source"] == "none"


async def test_an_eu_workspace_never_reaches_an_indian_only_model() -> None:
    india_only = FakeLlm(lambda _r: {"moments": []}, regions=frozenset({"in"}))
    outcome = await process_llm(broll_context((india_only,), region="eu"))
    assert india_only.requests == []
    assert outcome.result["output"]["source"] == "none"


async def test_a_malformed_request_is_refused_and_not_retried() -> None:
    services = build_test_services()
    for payload in ({}, {"broll": {**REQUEST, "extra": 1}}, {"broll": {**REQUEST, "words": []}}):
        context = context_for("ai.llm", services, kind="broll", region="in", **payload)
        with pytest.raises(JobFailureError) as excinfo:
            await process_llm(context)
        assert excinfo.value.code == "worker/invalid_payload"
        assert excinfo.value.retryable is False


def broll_context(providers: tuple[LlmProvider, ...], **payload: Any) -> JobContext:
    services = build_test_services()
    object.__setattr__(services, "llm_providers", providers)
    return context_for(
        "ai.llm",
        services,
        kind="broll",
        region=payload.pop("region", "in"),
        broll=REQUEST,
        **payload,
    )
