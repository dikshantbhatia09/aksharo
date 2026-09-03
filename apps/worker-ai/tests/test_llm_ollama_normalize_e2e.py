"""End-to-end proof that `generate_insight`'s Ollama path applies
`normalize_insight_output` before schema validation, and that a truncated
reply gets the stricter, higher-token-budget repair message (M20 increment
2b) -- against a mocked `httpx2` transport, no network.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2

from worker_ai.llm.providers.ollama import OllamaLlmProvider
from worker_ai.llm.service import generate_insight
from worker_ai.llm.templates import TranscriptInput, TranscriptSegment

TRANSCRIPT = TranscriptInput(
    language="en",
    duration_ms=20_000,
    media_title="Sample",
    segments=(TranscriptSegment(0, 4_000, "Hello everyone welcome to the show"),),
)


def _provider(handler: Any) -> OllamaLlmProvider:
    return OllamaLlmProvider(client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)))


async def test_over_cap_chapter_title_is_truncated_before_validation_not_rejected() -> None:
    over_cap_title = "x" * 90

    async def handler(_request: httpx2.Request) -> httpx2.Response:
        payload = {"chapters": [{"startMs": 0, "title": over_cap_title}]}
        return httpx2.Response(
            200, json={"choices": [{"message": {"content": json.dumps(payload)}}]}
        )

    provider = _provider(handler)
    result = await generate_insight("chapters", TRANSCRIPT, (provider,), "in")
    assert len(result.output["chapters"][0]["title"]) <= 60
    assert result.output["chapters"][0]["title"] == "x" * 60


async def test_truncated_json_gets_the_stricter_repair_message_and_bigger_budget() -> None:
    seen_bodies: list[dict[str, Any]] = []

    async def handler(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        seen_bodies.append(body)
        if len(seen_bodies) == 1:
            # Simulate a reply cut off mid-string.
            return httpx2.Response(
                200,
                json={
                    "choices": [
                        {"message": {"content": '{"chapters": [{"startMs": 0, "title": "Int'}}
                    ]
                },
            )
        return httpx2.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps({"chapters": [{"startMs": 0, "title": "Intro"}]})
                        }
                    }
                ]
            },
        )

    provider = _provider(handler)
    result = await generate_insight("chapters", TRANSCRIPT, (provider,), "in")

    assert result.output["chapters"][0]["title"] == "Intro"
    assert len(seen_bodies) == 2
    repair_user = seen_bodies[1]["messages"][1]["content"]
    assert "cut off" in repair_user
    assert "under 150 words" in repair_user
    # The stricter repair message also asks for more headroom than the
    # template's own (lower) budget.
    assert seen_bodies[1]["max_tokens"] >= 2_048


async def test_a_non_truncation_schema_failure_still_gets_the_generic_repair_message() -> None:
    seen_bodies: list[dict[str, Any]] = []

    async def handler(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        seen_bodies.append(body)
        if len(seen_bodies) == 1:
            # Valid JSON, but chapters is empty -- a schema failure, not a
            # truncation.
            return httpx2.Response(200, json={"choices": [{"message": {"content": "{}"}}]})
        return httpx2.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps({"chapters": [{"startMs": 0, "title": "Intro"}]})
                        }
                    }
                ]
            },
        )

    provider = _provider(handler)
    result = await generate_insight("chapters", TRANSCRIPT, (provider,), "in")

    assert result.output["chapters"][0]["title"] == "Intro"
    repair_user = seen_bodies[1]["messages"][1]["content"]
    assert "did not match the required JSON schema" in repair_user
    assert "cut off" not in repair_user
