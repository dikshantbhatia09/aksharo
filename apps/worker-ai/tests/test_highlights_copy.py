"""Clip copy (2026-09-29): the words to post each clip with, in the speaker's language.

Driven through :func:`process_highlights` with ``options.copy``, a fake model
that judges every moment the same and writes whatever copy the test gives it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from worker_ai.highlights.clip_copy import (
    ClipSource,
    heuristic_copy,
    normalise_hashtags,
    resolve_style,
    utf16_length,
)
from worker_ai.highlights.contracts import ClipCopy
from worker_ai.llm.providers.base import LlmError, LlmRequest
from worker_ai.processors.context import ProcessorOutcome

from .fake_llm import FakeLlm, clip_blocks, is_copywriting, is_judging, moment_blocks
from .test_highlights_rerank import run_with, transcript

HINGLISH_MOMENT = (
    "yeh sabse badi galti hai jo log salary ke saath karte hain.",
    "salary badhti hai lekin savings nahi badhti kyunki kharcha bhi badh jata hai.",
    "isliye pehle apne aap ko pay karo aur phir kharcha karo.",
)
HINGLISH_COPY: dict[str, Any] = {
    "title": "Salary se ameer kyun nahi bante?",
    "hook": "Yeh galti sab karte hain",
    "summary": "Salary badhne par bhi paise kyun nahi bachte, yeh clip batata hai.",
    "description": "Is clip mein savings ki sabse badi galti ki baat hai.",
    "cta": "Poora episode dekhiye",
    "hashtags": ["#money", "paisa", "#Money", "#saving tips", "#finance!"],
    "instagram": "Yeh galti sab karte hain!\nSalary se ameer kyun nahi bante? #money",
    "tiktok": "Salary ki sabse badi galti",
    "linkedin": "Salary badhna kaafi nahi hai. Savings ki aadat zaroori hai. Aap kya sochte hain?",
    "x": "Salary se ameer kyun nahi bante? " + "bahut " * 60,
}
DEVANAGARI_COPY: dict[str, Any] = {
    "title": "सैलरी से अमीर क्यों नहीं बनते?",
    "hook": "यह गलती सब करते हैं",
    "summary": "सैलरी बढ़ने पर भी पैसे क्यों नहीं बचते, यह क्लिप बताती है।",
    "description": "इस क्लिप में बचत की सबसे बड़ी गलती की बात है।",
    "cta": "पूरा एपिसोड देखिए",
    "hashtags": ["#पैसा", "#बचत", "#हिंदी"],
    "instagram": "यह गलती सब करते हैं!",
    "tiktok": "सैलरी की सबसे बड़ी गलती",
    "linkedin": "सिर्फ सैलरी बढ़ना काफी नहीं है।",
    "x": "सैलरी से अमीर क्यों नहीं बनते?",
}
ENGLISH_COPY: dict[str, Any] = {
    "title": "Why a raise never makes you rich",
    "hook": "Everyone makes this mistake",
    "summary": "Your spending grows with your salary, so savings never do.",
    "description": "The biggest saving mistake, explained.",
    "cta": "Watch the full episode",
    "hashtags": ["#money", "#savings", "#finance"],
    "instagram": "Everyone makes this mistake.",
    "tiktok": "The raise trap",
    "linkedin": "A raise is not a plan.",
    "x": "Why a raise never makes you rich.",
}


def copywriter(*replies: dict[str, Any] | str) -> Callable[[LlmRequest], Any]:
    """Judges the salary moment best, then answers each copy request with the next reply."""
    queue = list(replies)

    def answer(request: LlmRequest) -> Any:
        if is_judging(request):
            return {
                "moments": [
                    {
                        "id": window_id,
                        "standalone": 10 if "salary" in text else 2,
                        "payoff": 10 if "salary" in text else 2,
                        "humour": 0,
                    }
                    for window_id, text in moment_blocks(request).items()
                ]
            }
        if not is_copywriting(request):
            return LlmError("unexpected request", provider="fake", retryable=False)
        reply = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(reply, str):
            return reply
        return {"clips": [{"id": clip_id, **reply} for clip_id in clip_blocks(request)]}

    return answer


def copy_requests(fake: FakeLlm) -> list[LlmRequest]:
    return [request for request in fake.requests if is_copywriting(request)]


async def with_copy(
    fake: FakeLlm | None, language: str, script_mode: str, **overrides: Any
) -> ProcessorOutcome:
    words = transcript(HINGLISH_MOMENT, filler=4)
    providers = () if fake is None else (fake,)
    return await run_with(
        providers,
        words,
        count=overrides.pop("count", 1),
        copy={"language": language, "scriptMode": script_mode},
        **overrides,
    )


def only_copy(outcome: ProcessorOutcome) -> dict[str, Any]:
    (proposal,) = outcome.result["proposals"]
    copy: dict[str, Any] = proposal["copy"]
    ClipCopy.model_validate(copy)
    return copy


# ---------------------------------------------------------------------------
# The model's copy
# ---------------------------------------------------------------------------


async def test_a_hinglish_run_gets_hinglish_copy_normalised_to_the_contract() -> None:
    fake = FakeLlm(copywriter(HINGLISH_COPY))

    copy = only_copy(await with_copy(fake, "hi-Latn", "roman"))

    assert copy["source"] == "model"
    assert copy["locale"] == "hi-Latn"
    assert copy["title"] == "Salary se ameer kyun nahi bante?"
    assert copy["hook"] == "Yeh galti sab karte hain"
    assert copy["hashtags"] == ["#money", "#paisa", "#savingtips", "#finance"]
    platforms = copy["platforms"]
    assert platforms["youtube"]["title"] == copy["title"]
    assert len(platforms["x"]["text"]) <= 280
    # The model's own "#money" is stripped from its caption; the tags go at the end once.
    assert platforms["instagram"]["caption"].count("#money") == 1
    assert platforms["instagram"]["caption"].endswith("#money #paisa #savingtips #finance")
    assert set(platforms) == {"youtube", "instagram", "tiktok", "linkedin", "x", "facebook"}

    system = copy_requests(fake)[0].system
    assert "Hinglish" in system
    assert "Roman (English) letters" in system
    assert "Salary se ameer kyun nahi bante?" in system
    assert "Never use Devanagari" in system


async def test_a_hook_is_cut_to_seven_words() -> None:
    long_hook = {**HINGLISH_COPY, "hook": "yeh ek bahut hi lambi line hai jo screen par nahi aati"}

    copy = only_copy(await with_copy(FakeLlm(copywriter(long_hook)), "hi-Latn", "roman"))

    assert copy["hook"] == "yeh ek bahut hi lambi line hai"


async def test_a_hook_that_repeats_the_title_is_replaced() -> None:
    same = {**HINGLISH_COPY, "hook": HINGLISH_COPY["title"]}

    copy = only_copy(await with_copy(FakeLlm(copywriter(same)), "hi-Latn", "roman"))

    assert copy["hook"].casefold() != copy["title"].casefold()
    assert 3 <= len(copy["hook"].split()) <= 7


async def test_devanagari_for_a_roman_run_is_sent_back_once_with_the_reason() -> None:
    fake = FakeLlm(copywriter(DEVANAGARI_COPY, HINGLISH_COPY))

    copy = only_copy(await with_copy(fake, "hi-Latn", "roman"))

    assert copy["source"] == "model"
    assert copy["title"] == "Salary se ameer kyun nahi bante?"
    retry = copy_requests(fake)[1]
    assert "Fix for c1: write it only in Roman (English) letters" in retry.user


async def test_copy_still_in_the_wrong_script_after_the_retry_is_written_by_rule() -> None:
    fake = FakeLlm(copywriter(DEVANAGARI_COPY))

    copy = only_copy(await with_copy(fake, "hi-Latn", "roman"))

    assert copy["source"] == "heuristic"
    assert len(copy_requests(fake)) == 2


async def test_plain_english_for_a_hinglish_speaker_is_refused() -> None:
    fake = FakeLlm(copywriter(ENGLISH_COPY))

    copy = only_copy(await with_copy(fake, "hi-Latn", "roman"))

    assert copy["source"] == "heuristic"
    assert "not in pure English" in copy_requests(fake)[1].user


async def test_english_texts_in_hinglish_copy_are_asked_again_then_said_by_rule() -> None:
    """Small models slip into English for the summary and LinkedIn text."""
    mixed = {
        **HINGLISH_COPY,
        "summary": "Your spending grows with your salary, so your savings never do.",
        "linkedin": "A raise is not a plan, and spending always rises to meet it.",
        "cta": "Watch the full episode",
    }
    fake = FakeLlm(copywriter(mixed))

    copy = only_copy(await with_copy(fake, "hi-Latn", "roman"))

    retry = copy_requests(fake)[1].user
    assert "write the summary, linkedin in Hinglish too" in retry
    # The model's Hinglish is kept; its English is replaced from the clip's words.
    assert copy["source"] == "model"
    assert copy["title"] == "Salary se ameer kyun nahi bante?"
    assert copy["summary"].startswith("yeh sabse badi galti hai")
    assert "raise is not a plan" not in copy["platforms"]["linkedin"]["text"]
    assert copy["cta"] == "Poora video zaroor dekhiye."
    assert 'like "Poora episode dekhiye"' in copy_requests(fake)[0].system


async def test_an_english_run_takes_english_copy() -> None:
    fake = FakeLlm(copywriter(ENGLISH_COPY))

    copy = only_copy(await with_copy(fake, "en", "auto"))

    assert copy["source"] == "model"
    assert copy["title"] == "Why a raise never makes you rich"
    assert "Write every field in English." in copy_requests(fake)[0].system


async def test_a_native_hindi_run_gets_devanagari_with_its_hashtags_intact() -> None:
    fake = FakeLlm(copywriter(DEVANAGARI_COPY))

    copy = only_copy(await with_copy(fake, "hi", "native"))

    assert copy["source"] == "model"
    assert copy["hashtags"] == ["#पैसा", "#बचत", "#हिंदी"]
    assert "Devanagari script" in copy_requests(fake)[0].system


async def test_a_bilingual_run_asks_for_a_roman_title_and_mixed_text() -> None:
    fake = FakeLlm(copywriter(HINGLISH_COPY))

    only_copy(await with_copy(fake, "hi", "bilingual"))

    system = copy_requests(fake)[0].system
    assert "title, hook and hashtags in Hinglish" in system
    assert "may mix Hinglish and English" in system


async def test_lengths_are_cut_as_the_api_counts_them() -> None:
    """JavaScript counts an emoji as two: a caption that fits here but not there
    would make the API refuse the whole result, every clip with it."""
    fire = chr(0x1F525)
    loud = {**HINGLISH_COPY, "instagram": "Yeh galti sab karte hain " + fire * 3_000}

    copy = only_copy(await with_copy(FakeLlm(copywriter(loud)), "hi-Latn", "roman"))

    caption = copy["platforms"]["instagram"]["caption"]
    assert fire in caption
    assert utf16_length(caption) <= 2_200
    assert utf16_length(copy["platforms"]["x"]["text"]) <= 280


@pytest.mark.parametrize(
    "reply",
    [
        LlmError("down", provider="fake", retryable=False),
        "not json",
        {"clips": [{"id": "c9", **HINGLISH_COPY}]},
        {"clips": [{"id": "c1", "title": "", "hook": "", "summary": ""}]},
    ],
    ids=["error", "garbage", "unknown-id", "empty-fields"],
)
async def test_copy_the_model_cannot_write_is_written_by_rule(reply: Any) -> None:
    def answer(request: LlmRequest) -> Any:
        if is_judging(request):
            return copywriter(HINGLISH_COPY)(request)
        return reply

    copy = only_copy(await with_copy(FakeLlm(answer), "hi-Latn", "roman"))

    assert copy["source"] == "heuristic"
    assert copy["locale"] == "hi-Latn"


async def test_an_unexpected_error_in_the_models_part_never_fails_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Whatever breaks on the model's side (a bug, a body that is not JSON), the
    job answers with the heuristic's pick and copy by rule, as before the model."""

    async def broken(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("a bug in the model's part")

    monkeypatch.setattr("worker_ai.processors.highlights.judge_moments", broken)

    copy = only_copy(await with_copy(FakeLlm(copywriter(HINGLISH_COPY)), "hi-Latn", "roman"))

    assert copy["source"] == "heuristic"


async def test_an_adapter_that_raises_something_else_is_passed_over() -> None:
    def answer(request: LlmRequest) -> Any:
        if is_judging(request):
            return copywriter(HINGLISH_COPY)(request)
        raise ValueError("Expecting value: line 1 column 1 (char 0)")

    copy = only_copy(await with_copy(FakeLlm(answer), "hi-Latn", "roman"))

    assert copy["source"] == "heuristic"


# ---------------------------------------------------------------------------
# Without a model
# ---------------------------------------------------------------------------


async def test_without_a_model_every_pick_gets_copy_from_its_own_words() -> None:
    outcome = await with_copy(None, "hi-Latn", "roman", count=2)

    for proposal in outcome.result["proposals"]:
        copy = proposal["copy"]
        ClipCopy.model_validate(copy)
        assert copy["source"] == "heuristic"
        assert copy["title"] == proposal["title"]
        assert 1 <= len(copy["hook"].split()) <= 7
        assert copy["hook"].casefold() != copy["title"].casefold()
        assert all(tag.startswith("#") and " " not in tag for tag in copy["hashtags"])
        assert copy["cta"] == "Poora video zaroor dekhiye."
    assert all("judgement" not in p for p in outcome.result["proposals"])


def test_rule_based_copy_takes_hashtags_from_the_words_said_most() -> None:
    source = ClipSource(
        key="w-00001",
        text="Savings matter. Savings grow slowly, but savings compound over the years.",
        title="Savings matter",
    )
    copy = heuristic_copy(source, resolve_style("en", "auto"))
    assert copy["hashtags"][0] == "#savings"
    # "Savings matter." is too short to hook; the next phrase, without its comma.
    assert copy["hook"] == "Savings grow slowly"
    assert copy["source"] == "heuristic"
    ClipCopy.model_validate(copy)


# ---------------------------------------------------------------------------
# Language and hashtags
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("language", "mode", "sample", "script", "hinglish"),
    [
        ("hi-Latn", "auto", "", "Latn", True),
        ("hi-Latn", "roman", "", "Latn", True),
        ("hi", "roman", "", "Latn", True),
        ("hi", "native", "", "Deva", False),
        ("hi-Latn", "native", "", "Deva", False),
        ("hi", "auto", "यह सबसे बड़ी गलती है", "Deva", False),
        ("hi", "auto", "yeh sabse badi galti hai", "Latn", True),
        ("hi", "bilingual", "", "Latn", True),
        ("en", "native", "", "Latn", False),
        ("en-IN", "auto", "", "Latn", False),
        ("ta", "native", "", "Taml", False),
        ("ta", "roman", "", "Latn", False),
    ],
)
def test_the_style_follows_the_language_tag_and_script_mode(
    language: str, mode: str, sample: str, script: str, hinglish: bool
) -> None:
    style = resolve_style(language, mode, sample)
    assert style.script == script
    assert style.hinglish is hinglish
    assert style.locale == language


def test_an_unknown_language_follows_the_transcript_and_is_not_checked() -> None:
    style = resolve_style("fr", "auto")
    assert style.script is None
    assert "same language" in style.instruction


def test_hashtags_are_normalised() -> None:
    assert normalise_hashtags(["money", "#Money", "#saving tips", "#finance!!", "", "#"]) == [
        "#money",
        "#savingtips",
        "#finance",
    ]
    assert normalise_hashtags("#a #b, c") == ["#a", "#b", "#c"]
    assert normalise_hashtags(["#हिंदी", "#पैसा"]) == ["#हिंदी", "#पैसा"]
    assert len(normalise_hashtags([f"#tag{index}" for index in range(20)])) == 6
    assert normalise_hashtags(None) == []
