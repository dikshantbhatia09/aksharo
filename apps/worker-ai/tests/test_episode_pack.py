"""``ai.llm`` kind ``episode-pack`` (2026-09-29): the text posted with the whole video."""

from __future__ import annotations

from typing import Any

import pytest

from worker_ai.llm.episode_pack import (
    EPISODE_PACK_TEMPLATE_VERSION,
    condensed_transcript,
    heuristic_chapters,
    parse_chapters,
    parse_pack_text,
)
from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.llm.templates import TranscriptInput, TranscriptSegment
from worker_ai.processors.context import JobContext, JobFailureError
from worker_ai.processors.llm import process_llm

from .fake_llm import FakeLlm
from .test_processors import build_services as build_test_services
from .test_processors import context_for

MINUTE = 60_000

SEGMENTS = [
    {"startMs": 0, "endMs": 60_000, "text": "Namaste doston, aaj hum paise ki baat karenge."},
    {"startMs": 60_000, "endMs": 180_000, "text": "Salary badhti hai lekin savings nahi badhti."},
    {
        "startMs": 180_000,
        "endMs": 300_000,
        "text": "Pehle apne aap ko pay karo, phir kharcha karo.",
    },
    {"startMs": 300_000, "endMs": 420_000, "text": "Emergency fund kyun zaroori hai, yeh samjho."},
]

PACK_TEXT: dict[str, Any] = {
    "youtubeDescription": (
        "Is video mein hum salary aur savings ki baat karte hain.\n\nPoora dekhiye."
    ),
    "showNotes": "Savings ki aadat par baat.\n- Salary trap\n- Pehle khud ko pay karo",
    "linkedinPost": (
        "Salary badhna kaafi nahi hai.\nSavings ki aadat chahiye.\nAap kya sochte hain?"
    ),
    "xThread": ["Salary se ameer kyun nahi bante? #money", "Kyunki kharcha bhi badhta hai.", ""],
    "newsletter": "Salary ka jaal\n\nIs hafte hum savings ki baat karte hain.",
}
CHAPTERS: dict[str, Any] = {
    "chapters": [
        {"start": "1:00", "title": "Salary ka jaal"},
        {"start": "0:05", "title": "Shuruaat"},
        {"start": "1:05", "title": "Too close to the one before"},
        {"start": "3:00", "title": "Pehle khud ko pay karo"},
        {"start": "5:00", "title": "Emergency fund kyun?"},
        {"start": "99:00", "title": "Past the end"},
    ]
}


def writer(chapters: Any = CHAPTERS, text: Any = PACK_TEXT) -> FakeLlm:
    def answer(request: LlmRequest) -> Any:
        if "YouTube chapters" in request.system:
            return chapters
        return text

    fake = FakeLlm(answer, name="sarvam", model="sarvam-105b-conversations")
    fake.no_training = False  # as the real adapter: no zero-retention terms
    return fake


def pack_context(providers: tuple[LlmProvider, ...], **payload: Any) -> JobContext:
    services = build_test_services()
    object.__setattr__(services, "llm_providers", providers)
    return context_for(
        "ai.llm",
        services,
        kind="episode-pack",
        region=payload.pop("region", "in"),
        transcript={
            "language": "hi-Latn",
            "durationMs": 420_000,
            "mediaTitle": "Paisa aur salary",
            "segments": SEGMENTS,
        },
        **payload,
    )


async def test_the_model_writes_the_pack_in_the_runs_language() -> None:
    fake = writer()
    context = pack_context((fake,), copy={"language": "hi-Latn", "scriptMode": "roman"})

    outcome = await process_llm(context)
    result = outcome.result

    assert result["templateId"] == "episode-pack"
    assert result["version"] == EPISODE_PACK_TEMPLATE_VERSION == "episode-pack@1"
    assert result["provider"] == "sarvam"
    output = result["output"]
    assert output["source"] == "model"
    assert output["locale"] == "hi-Latn"
    assert output["chapters"] == [
        {"startMs": 0, "title": "Shuruaat"},
        {"startMs": 60_000, "title": "Salary ka jaal"},
        {"startMs": 180_000, "title": "Pehle khud ko pay karo"},
        {"startMs": 300_000, "title": "Emergency fund kyun?"},
    ]
    assert output["xThread"] == [
        "Salary se ameer kyun nahi bante?",
        "Kyunki kharcha bhi badhta hai.",
    ]
    assert output["youtubeDescription"].startswith("Is video mein")
    assert "\n\n" in output["youtubeDescription"]
    # Both calls were told the language, with the Hinglish example.
    assert all("Salary se ameer kyun nahi bante?" in r.system for r in fake.requests)
    assert all("[1:00] Salary badhti hai" in r.user for r in fake.requests)
    # A paid call is recorded for the erasure trail and priced on the job.
    assert result["providerSubmissions"][0]["provider"] == "sarvam"
    assert result["providerSubmissions"][0]["retentionClass"] == "vendor_default"
    assert outcome.usage is not None and outcome.usage.provider == "sarvam"
    assert outcome.usage.cost_minor is not None and outcome.usage.cost_minor > 0


async def test_without_a_model_the_pack_is_written_from_the_transcript() -> None:
    context = pack_context((MockLlmProvider(),))

    outcome = await process_llm(context)
    output = outcome.result["output"]

    assert outcome.result["provider"] == "heuristic"
    assert output["source"] == "heuristic"
    assert output["chapters"][0]["startMs"] == 0
    assert all(value for key, value in output.items() if key != "source")
    assert output["xThread"][0].startswith("Namaste doston")
    assert outcome.result["providerSubmissions"] == []
    assert outcome.usage is None


@pytest.mark.parametrize(
    "provider",
    [
        FakeLlm(lambda _r: LlmError("down", provider="fake", retryable=False)),
        FakeLlm(lambda _r: "no json here"),
        FakeLlm(lambda _r: {"chapters": [], "youtubeDescription": ""}),
    ],
    ids=["error", "garbage", "empty"],
)
async def test_a_model_that_cannot_write_it_never_fails_the_job(provider: FakeLlm) -> None:
    outcome = await process_llm(pack_context((provider,)))
    assert outcome.result["output"]["source"] == "heuristic"
    assert outcome.result["output"]["chapters"]


async def test_an_unexpected_error_writes_the_pack_by_rule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from worker_ai.llm import episode_pack

    real = episode_pack.write_episode_pack
    calls: list[int] = []

    async def flaky(*args: Any, **kwargs: Any) -> Any:
        calls.append(len(kwargs["chain"]))
        if kwargs["chain"]:
            raise RuntimeError("a bug in the model's part")
        return await real(*args, **kwargs)

    monkeypatch.setattr("worker_ai.processors.llm.write_episode_pack", flaky)

    outcome = await process_llm(pack_context((writer(),)))

    assert calls == [1, 0]
    assert outcome.result["output"]["source"] == "heuristic"


async def test_english_prose_for_a_hinglish_video_is_refused() -> None:
    english = {
        **PACK_TEXT,
        "youtubeDescription": "We talk about salary and savings.",
        "linkedinPost": "A raise is not a plan.",
        "xThread": ["Why a raise never makes you rich."],
    }
    outcome = await process_llm(
        pack_context((writer(text=english),), copy={"language": "hi-Latn", "scriptMode": "roman"})
    )
    output = outcome.result["output"]
    assert output["source"] == "mixed"  # the model's chapters, the rule's text
    assert output["chapters"][1]["title"] == "Salary ka jaal"


async def test_english_parts_are_asked_for_again_and_the_better_reply_is_kept() -> None:
    partly_english = {
        **PACK_TEXT,
        "showNotes": "Three simple rules for savings.\n- Pay yourself first\n- Keep a fund",
    }
    replies = [partly_english, PACK_TEXT]

    def answer(request: LlmRequest) -> Any:
        if "YouTube chapters" in request.system:
            return CHAPTERS
        return replies.pop(0)

    fake = FakeLlm(answer)
    outcome = await process_llm(
        pack_context((fake,), copy={"language": "hi-Latn", "scriptMode": "roman"})
    )

    retry = fake.requests[-1].user
    assert "Your last reply wrote the show notes in English." in retry
    assert outcome.result["output"]["showNotes"] == PACK_TEXT["showNotes"]
    assert outcome.result["output"]["source"] == "model"


async def test_an_eu_workspace_never_reaches_an_indian_only_model() -> None:
    india_only = FakeLlm(lambda _r: CHAPTERS, regions=frozenset({"in"}))
    outcome = await process_llm(pack_context((india_only,), region="eu"))
    assert india_only.requests == []
    assert outcome.result["output"]["source"] == "heuristic"


async def test_a_pack_request_without_a_transcript_is_refused() -> None:
    services = build_test_services()
    context = context_for("ai.llm", services, kind="episode-pack", region="in")
    with pytest.raises(JobFailureError) as excinfo:
        await process_llm(context)
    assert excinfo.value.code == "worker/invalid_payload"


def test_chapters_are_ordered_start_at_zero_and_keep_ten_seconds_apart() -> None:
    chapters = parse_chapters(
        {
            "chapters": [
                {"start": "2:00", "title": "B"},
                {"start": "0:30", "title": "A"},
                {"start": "2:05", "title": "too close"},
                {"start": "1:02:03", "title": "Late"},
                {"start": "7:61", "title": "bad seconds"},
                {"start": 150, "title": "C, in seconds"},
                {"start": "3:00", "title": ""},
            ]
        },
        duration_ms=2 * 60 * MINUTE,
    )
    assert chapters == [
        {"startMs": 0, "title": "A"},
        {"startMs": 120_000, "title": "B"},
        {"startMs": 150_000, "title": "C, in seconds"},
        {"startMs": 3_723_000, "title": "Late"},
    ]


def test_rule_chapters_spread_over_the_video() -> None:
    transcript = TranscriptInput(
        language="en",
        duration_ms=40 * MINUTE,
        segments=tuple(
            TranscriptSegment(m * MINUTE, (m + 1) * MINUTE, f"Topic number {m} starts here.")
            for m in range(40)
        ),
    )
    chapters = heuristic_chapters(transcript)
    assert chapters[0]["startMs"] == 0
    assert 1 < len(chapters) <= 13
    starts = [chapter["startMs"] for chapter in chapters]
    assert starts == sorted(starts)


def test_the_pack_text_needs_all_five_parts() -> None:
    assert parse_pack_text(PACK_TEXT) is not None
    assert parse_pack_text({**PACK_TEXT, "newsletter": ""}) is None
    posts = parse_pack_text({**PACK_TEXT, "xThread": ["x" * 400]})
    assert posts is not None and len(posts["xThread"][0]) <= 280


def test_a_long_transcript_is_condensed_evenly_to_the_budget() -> None:
    transcript = TranscriptInput(
        language="en",
        duration_ms=120 * MINUTE,
        segments=tuple(
            TranscriptSegment(m * 30_000, (m + 1) * 30_000, f"minute {m} " + "word " * 60)
            for m in range(240)
        ),
    )
    text = condensed_transcript(transcript, 8_000)
    assert len(text) <= 8_000
    # The whole video stays in view: its first and its last hour are both there.
    assert "[0:00]" in text
    assert "[1:" in text
