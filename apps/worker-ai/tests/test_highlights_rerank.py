"""``ai.highlights`` with a language model: it judges the shortlist, never the timecodes.

Every test drives :func:`process_highlights` end to end with a fake model that
scores each moment from its words, so what is asserted is the ranking the job
returns, not a helper's arithmetic.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import pytest

from worker_ai.highlights import HighlightsResult
from worker_ai.highlights.rerank import (
    MODEL_WEIGHT,
    Judged,
    blend,
    model_quality,
    parse_judgements,
    shortlist_size,
)
from worker_ai.highlights.scoring import Score
from worker_ai.highlights.windows import Window
from worker_ai.llm.budget import BudgetedLlmProvider, MemorySpendLedger
from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest
from worker_ai.processors.context import ProcessorOutcome
from worker_ai.processors.highlights import (
    HIGHLIGHT_MODEL,
    _Candidate,
    _rank_with_model,
    discover,
    process_highlights,
)

from .fake_llm import FakeLlm, failing, is_judging, moment_blocks
from .test_highlights import (
    NEUTRAL,
    STRONG_AT_12,
    TranscriptApi,
    options,
    payload,
    talk,
    words_response,
)
from .test_processors import build_services as build_test_services
from .test_processors import context_for

PUNCHLINE = (
    "then my uncle told the punchline about the old bus and the goat.",
    "the whole room laughed at that punchline for five minutes.",
)
CRICKET_A = ("the cricket match went to the last ball and we held our breath.",)
CRICKET_B = ("my first cricket bat was a gift from my grandfather in the village.",)


def transcript(*blocks: Sequence[str], filler: int = 5) -> list[dict[str, Any]]:
    """Neutral talk around each block, so every block is its own moment."""
    sentences: list[str] = []
    for index, block in enumerate(blocks):
        sentences.extend(NEUTRAL[(index + k) % len(NEUTRAL)] for k in range(filler))
        sentences.extend(block)
    sentences.extend(NEUTRAL[k % len(NEUTRAL)] for k in range(filler))
    return talk(sentences)


def judge(scores: Callable[[str], tuple[int, int, int, int]]) -> Callable[[LlmRequest], Any]:
    """A fake editor: ``scores(text) -> (standalone, payoff, humour, topicFit)``."""

    def answer(request: LlmRequest) -> Any:
        if not is_judging(request):
            return LlmError("not asked to judge", provider="fake", retryable=False)
        moments = []
        for window_id, text in moment_blocks(request).items():
            standalone, payoff, humour, fit = scores(text)
            moments.append(
                {
                    "id": window_id,
                    "standalone": standalone,
                    "payoff": payoff,
                    "humour": humour,
                    "topicFit": fit,
                    "why": "Says it plainly." if payoff < 8 else "Lands a clear punchline.",
                }
            )
        return {"moments": moments}

    return answer


def loves(marker: str, *, others: int = 2) -> Callable[[str], tuple[int, int, int, int]]:
    def scores(text: str) -> tuple[int, int, int, int]:
        return (10, 10, 10, 9) if marker in text else (others, others, 0, 1)

    return scores


async def run_with(
    providers: tuple[LlmProvider, ...], words: list[dict[str, Any]], **option_overrides: Any
) -> ProcessorOutcome:
    services = build_test_services()
    object.__setattr__(services, "callbacks", TranscriptApi(words_response(words)))
    object.__setattr__(services, "llm_providers", providers)
    context = context_for("ai.highlights", services, **payload(**option_overrides))
    outcome = await process_highlights(context)
    HighlightsResult.model_validate(outcome.result)
    return outcome


def excerpts(result: dict[str, Any]) -> list[str]:
    return [proposal["transcriptExcerpt"] for proposal in result["proposals"]]


def heuristic(words: list[dict[str, Any]], **option_overrides: Any) -> list[tuple[int, int, int]]:
    proposals, _ = discover(words, options(**option_overrides))
    return [(p.start_ms, p.end_ms, p.potential_score) for p in proposals]


def spans(result: dict[str, Any]) -> list[tuple[int, int, int]]:
    return [(p["startMs"], p["endMs"], p["potentialScore"]) for p in result["proposals"]]


# ---------------------------------------------------------------------------
# The model changes the ranking
# ---------------------------------------------------------------------------


async def test_the_models_favourite_wins_over_the_heuristics() -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE)
    heuristic_first = discover(words, options(count=1))[0][0].transcript_excerpt
    assert "Did you know" in heuristic_first  # the heuristic's own pick

    fake = FakeLlm(judge(loves("punchline")))
    outcome = await run_with((fake,), words, count=1)
    result = outcome.result

    (proposal,) = result["proposals"]
    assert "punchline" in proposal["transcriptExcerpt"]
    assert proposal["judgement"] == {
        "standalone": 10,
        "payoff": 10,
        "humour": 10,
        "model": "fake-model",
    }
    # The model's view is the first reason, in plain words, with its scores.
    first = proposal["reasons"][0]
    assert first["label"] == "standalone"
    assert first["explanation"].startswith("AI editor: Lands a clear punchline.")
    assert "10/10" in first["explanation"]
    assert any(reason["label"] == "emotion" for reason in proposal["reasons"])
    assert result["model"] == f"{HIGHLIGHT_MODEL}+fake-model"


async def test_the_model_only_sees_enumerated_windows_and_answers_by_id() -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE)
    fake = FakeLlm(judge(loves("punchline")))

    result = (await run_with((fake,), words, count=2)).result

    asked = {window_id for request in fake.requests for window_id in moment_blocks(request)}
    assert 0 < len(asked) <= shortlist_size(2)
    assert {p["windowId"] for p in result["proposals"]} <= asked
    # The prompt names the languages the transcript may be in.
    assert "Hinglish" in fake.requests[0].system


async def test_the_potential_score_blends_both_readings() -> None:
    judged = Judged(standalone=8, payoff=6, humour=0, topic_fit=None, why="", model="m")
    quality = model_quality(judged, "education", with_topic=False)
    assert quality == pytest.approx(0.7)
    assert blend(0.5, judged, "education", with_topic=False) == pytest.approx(
        (1 - MODEL_WEIGHT) * 0.5 + MODEL_WEIGHT * 0.7
    )
    assert blend(0.5, None, "education", with_topic=False) == 0.5


def test_humour_lifts_a_moment_but_never_sinks_a_serious_one() -> None:
    serious = Judged(standalone=9, payoff=9, humour=0, topic_fit=None, why="", model="m")
    funny = Judged(standalone=6, payoff=6, humour=10, topic_fit=None, why="", model="m")
    assert model_quality(serious, "reach", with_topic=False) == pytest.approx(0.9)
    assert model_quality(funny, "engagement", with_topic=False) > model_quality(
        funny, "education", with_topic=False
    )


# ---------------------------------------------------------------------------
# Topic
# ---------------------------------------------------------------------------


async def test_a_topic_keeps_only_the_moments_about_it() -> None:
    words = transcript(STRONG_AT_12, CRICKET_A, PUNCHLINE, CRICKET_B)

    def scores(text: str) -> tuple[int, int, int, int]:
        return (6, 6, 0, 9 if "cricket" in text else 1)

    fake = FakeLlm(judge(scores))
    result = (await run_with((fake,), words, count=2, topic="cricket memories")).result

    assert len(result["proposals"]) == 2
    assert all("cricket" in excerpt for excerpt in excerpts(result))
    for proposal in result["proposals"]:
        assert proposal["judgement"]["topicFit"] == 9
        assert {
            "label": "clear_point",
            "explanation": "On your topic (cricket memories): 9/10.",
        } in (proposal["reasons"])
    assert "topicFit" in fake.requests[0].system
    assert "<topic>cricket memories</topic>" in fake.requests[0].user


async def test_too_few_on_topic_moments_are_topped_up_with_the_closest() -> None:
    words = transcript(STRONG_AT_12, CRICKET_A, PUNCHLINE, CRICKET_B)

    def scores(text: str) -> tuple[int, int, int, int]:
        if "cricket" in text:
            return (6, 6, 0, 9)
        return (6, 6, 0, 4 if "punchline" in text else 1)

    result = (await run_with((FakeLlm(judge(scores)),), words, count=3, topic="cricket")).result

    fits = sorted(p["judgement"]["topicFit"] for p in result["proposals"])
    # Two on topic, and min(count, 3) = 3: the closest off-topic one fills in.
    assert fits == [4, 9, 9]


# ---------------------------------------------------------------------------
# minPotential applies after the model has had its say
# ---------------------------------------------------------------------------


async def test_the_bar_is_applied_to_the_blended_score() -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE)
    bar = 0.6
    # On the heuristic alone the punchline does not clear the bar...
    assert not any(
        "punchline" in p.transcript_excerpt for p in discover(words, options(minPotential=bar))[0]
    )

    fake = FakeLlm(judge(loves("punchline", others=0)))
    result = (await run_with((fake,), words, count=5, minPotential=bar)).result

    # ...with the model it does, and what the model marked down no longer does.
    assert result["proposals"]
    assert all("punchline" in excerpt for excerpt in excerpts(result))
    assert all(p["potentialScore"] >= bar * 100 for p in result["proposals"])


# ---------------------------------------------------------------------------
# Falling back: the model never fails a run
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "provider",
    [
        failing("down"),
        failing("flaky", retryable=True),
        FakeLlm(lambda _r: "Sorry, I cannot rate these moments.", name="chatty"),
        FakeLlm(lambda _r: {"moments": [{"id": "w-99999", "standalone": 9}]}, name="wrong"),
        FakeLlm(
            lambda request: {
                "moments": [
                    {"id": window_id, "standalone": 14, "payoff": -1, "humour": "lots"}
                    for window_id in moment_blocks(request)
                ]
            },
            name="out-of-range",
        ),
    ],
    ids=["error", "retryable-error", "no-json", "unknown-ids", "out-of-range"],
)
async def test_a_model_that_cannot_answer_leaves_the_heuristics_pick(
    provider: FakeLlm,
) -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE)

    outcome = await run_with((provider,), words, count=3)

    assert spans(outcome.result) == heuristic(words, count=3)
    assert all("judgement" not in p for p in outcome.result["proposals"])
    assert outcome.result["model"] == HIGHLIGHT_MODEL
    assert provider.requests  # it was asked


async def test_a_moment_the_model_saw_and_left_out_is_dropped() -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE, CRICKET_A)

    def answer(request: LlmRequest) -> Any:
        first = next(iter(moment_blocks(request)))
        return {
            "moments": [
                {"id": first, "standalone": 7, "payoff": 7, "humour": 1, "why": "ok"},
                {"id": "w-99999", "standalone": 10, "payoff": 10, "humour": 10},
            ]
        }

    fake = FakeLlm(answer)
    result = (await run_with((fake,), words, count=5)).result

    judged_ids = {next(iter(moment_blocks(request))) for request in fake.requests}
    assert {p["windowId"] for p in result["proposals"]} == judged_ids
    assert all("judgement" in p for p in result["proposals"])


def test_an_unanswered_batch_keeps_its_moments_on_the_same_scale() -> None:
    """Passed over (asked, left out) is dropped; never asked about is kept, blended
    with the typical reading of the moments that were judged."""

    def candidate(window_id: str, potential: float) -> Any:
        window = Window(window_id=window_id, first=0, last=0, start_ms=0, end_ms=15_000)
        return _Candidate(window, None, Score(potential, 0, 0, 0, 0, 0, 0, 0, 0))  # type: ignore[arg-type]

    shortlist = [candidate("w-1", 0.5), candidate("w-2", 0.7), candidate("w-3", 0.9)]
    judged = {"w-1": Judged(standalone=8, payoff=8, humour=0, topic_fit=None, why="", model="m")}

    ranked = _rank_with_model(
        shortlist, judged, frozenset({"w-1", "w-3"}), options(count=5, contentGoal="education")
    )

    by_id = {entry.candidate.window.window_id: entry for entry in ranked}
    assert set(by_id) == {"w-1", "w-2"}
    assert by_id["w-1"].potential == pytest.approx((1 - MODEL_WEIGHT) * 0.5 + MODEL_WEIGHT * 0.8)
    assert by_id["w-2"].judged is None
    assert by_id["w-2"].potential == pytest.approx((1 - MODEL_WEIGHT) * 0.7 + MODEL_WEIGHT * 0.8)


async def test_a_spent_budget_judges_with_the_free_fallback() -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE)
    ledger = MemorySpendLedger()
    await ledger.add(300.0)
    sarvam_inner = FakeLlm(
        judge(loves("Did you know")), name="sarvam", model="sarvam-105b-conversations"
    )
    sarvam = BudgetedLlmProvider(sarvam_inner, ledger=ledger, daily_budget_inr=300)
    ollama = FakeLlm(judge(loves("punchline")), name="ollama", model="qwen2.5:3b")

    outcome = await run_with((sarvam, ollama), words, count=1)

    assert sarvam_inner.requests == []
    (proposal,) = outcome.result["proposals"]
    assert "punchline" in proposal["transcriptExcerpt"]
    assert proposal["judgement"]["model"] == "qwen2.5:3b"
    assert outcome.usage is not None and outcome.usage.provider == "ollama"
    assert outcome.usage.cost_minor == 0


async def test_a_paid_judgement_reports_its_cost_on_the_job() -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE)
    sarvam = FakeLlm(judge(loves("punchline")), name="sarvam", model="sarvam-105b-conversations")

    outcome = await run_with((sarvam,), words, count=1)

    assert outcome.usage is not None
    assert outcome.usage.provider == "sarvam"
    assert outcome.usage.model == "sarvam-105b-conversations"
    assert outcome.usage.cost_minor is not None and outcome.usage.cost_minor > 0


async def test_an_eu_workspace_never_reaches_an_indian_only_model() -> None:
    words = transcript(STRONG_AT_12, PUNCHLINE)
    india_only = FakeLlm(judge(loves("punchline")), regions=frozenset({"in"}))

    outcome = await run_with((india_only,), words, count=3, region="eu")

    assert india_only.requests == []
    assert spans(outcome.result) == heuristic(words, count=3)


# ---------------------------------------------------------------------------
# Reading the reply
# ---------------------------------------------------------------------------


def test_judgements_are_read_strictly() -> None:
    value = {
        "moments": [
            {
                "id": "w-00001",
                "standalone": 7,
                "payoff": "8",
                "humor": 2.4,
                "why": "...a good line\nwith a clean end",
            },
            {"id": "w-00002", "standalone": 11, "payoff": 5, "humour": 1},
            {"id": "w-00003", "standalone": True, "payoff": 5, "humour": 1},
            {"id": "w-00004", "standalone": 5, "payoff": 5},
            {"id": "w-00001", "standalone": 1, "payoff": 1, "humour": 1},
            {"id": "w-00009", "standalone": 5, "payoff": 5, "humour": 5},
        ]
    }
    ids = ["w-00001", "w-00002", "w-00003", "w-00004"]

    judged = parse_judgements(value, ids, with_topic=False, model="m")

    assert set(judged) == {"w-00001"}
    assert judged["w-00001"] == Judged(
        standalone=7,
        payoff=8,
        humour=2,
        topic_fit=None,
        why="a good line with a clean end.",
        model="m",
    )


@pytest.mark.parametrize("why", ["...", "…", "ok", "", None, 7])
def test_a_placeholder_or_empty_why_is_left_out(why: object) -> None:
    value = {"moments": [{"id": "w-1", "standalone": 5, "payoff": 5, "humour": 0, "why": why}]}
    assert parse_judgements(value, ["w-1"], with_topic=False, model="m")["w-1"].why == ""


def test_a_reason_keeps_no_emoji_the_api_would_count_twice() -> None:
    fire = chr(0x1F525)
    value = {
        "moments": [
            {
                "id": "w-1",
                "standalone": 5,
                "payoff": 5,
                "humour": 0,
                "why": f"{fire} Lands a clear point {fire * 200}",
            }
        ]
    }
    why = parse_judgements(value, ["w-1"], with_topic=False, model="m")["w-1"].why
    assert why == "Lands a clear point."


def test_a_topic_run_needs_topic_fit() -> None:
    value = {"moments": [{"id": "w-00001", "standalone": 7, "payoff": 8, "humour": 2}]}
    assert parse_judgements(value, ["w-00001"], with_topic=True, model="m") == {}


def test_ids_as_keys_are_read_too() -> None:
    value = {"w-00001": {"standalone": 7, "payoff": 8, "humour": 2}}
    assert "w-00001" in parse_judgements(value, ["w-00001"], with_topic=False, model="m")


def test_the_clip_analysis_is_read_when_given_and_never_required() -> None:
    """Hook, trend, the four notes and the names (2026-10-01): optional extras."""
    value = {
        "moments": [
            {
                "id": "w-1",
                "standalone": 7,
                "payoff": 6,
                "humour": 1,
                "hook": 9,
                "trend": "4",
                "why": "Asks a question and answers it.",
                "notes": {
                    "hook": "Opens with a direct question.",
                    "flow": "A complete thought.",
                    "value": "...",
                    "trend": 7,
                    "other": "ignored entirely here",
                },
                "people": [
                    "Warren Buffett",
                    "",
                    42,
                    "Warren Buffett",
                    "Raj Shamani",
                    "A",
                    "Elon Musk",
                    "Fourth Person",
                ],
            },
            {"id": "w-2", "standalone": 5, "payoff": 5, "humour": 0, "hook": 11, "notes": "no"},
        ]
    }
    judged = parse_judgements(value, ["w-1", "w-2"], with_topic=False, model="m")
    first = judged["w-1"]
    assert (first.hook, first.trend) == (9, 4)
    # A placeholder note and a non-string one are left out, like a "why".
    assert dict(first.notes) == {
        "hook": "Opens with a direct question.",
        "flow": "A complete thought.",
    }
    assert first.people == ("Warren Buffett", "Raj Shamani", "Elon Musk")
    # Out of range or malformed: no hook, no notes - and still a judgement.
    second = judged["w-2"]
    assert (second.hook, second.trend, second.notes, second.people) == (None, None, (), ())


def test_a_strong_hook_lifts_a_moment_a_little() -> None:
    plain = parse_judgements(
        {"moments": [{"id": "w-1", "standalone": 6, "payoff": 6, "humour": 0}]},
        ["w-1"],
        with_topic=False,
        model="m",
    )["w-1"]
    hooked = parse_judgements(
        {"moments": [{"id": "w-1", "standalone": 6, "payoff": 6, "humour": 0, "hook": 10}]},
        ["w-1"],
        with_topic=False,
        model="m",
    )["w-1"]
    assert model_quality(hooked, "reach", with_topic=False) > model_quality(
        plain, "reach", with_topic=False
    )


async def test_the_clip_analysis_reaches_the_proposal() -> None:
    """2026-10-01: what the model said of hook, flow, value and trend goes out with the moment."""
    words = transcript(STRONG_AT_12, PUNCHLINE)

    def answer(request: LlmRequest) -> Any:
        if not is_judging(request):
            return LlmError("not asked to judge", provider="fake", retryable=False)
        return {
            "moments": [
                {
                    "id": window_id,
                    "standalone": 8,
                    "payoff": 8,
                    "humour": 2,
                    "hook": 9,
                    "trend": 6,
                    "why": "Lands a clear punchline.",
                    "notes": {
                        "hook": "Opens on a surprising question.",
                        "value": "One clear takeaway.",
                    },
                    "people": ["Raj Shamani"],
                }
                for window_id in moment_blocks(request)
            ]
        }

    outcome = await run_with((FakeLlm(answer),), words, count=1)
    (proposal,) = outcome.result["proposals"]
    assert proposal["judgement"] == {
        "standalone": 8,
        "payoff": 8,
        "humour": 2,
        "hook": 9,
        "trend": 6,
        "notes": {"hook": "Opens on a surprising question.", "value": "One clear takeaway."},
        "people": ["Raj Shamani"],
        "model": "fake-model",
    }
