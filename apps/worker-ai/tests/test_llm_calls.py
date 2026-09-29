"""One JSON answer from a chain: `json_reply.py`, `calls.py`, and the insights fall-through."""

from __future__ import annotations

import json

import httpx2
import pytest

from worker_ai.llm.calls import CallLedger, Deadline, complete_json, model_chain
from worker_ai.llm.json_reply import extract_json_object, first_json_object_text
from worker_ai.llm.providers.base import LlmError, LlmRequest, LlmUsage
from worker_ai.llm.providers.mock import MockLlmProvider
from worker_ai.llm.providers.ollama import OllamaLlmProvider
from worker_ai.llm.service import InvalidOutputError, generate_insight
from worker_ai.llm.templates import TranscriptInput, TranscriptSegment

from .fake_llm import FakeLlm, failing

REQUEST = LlmRequest(system="s", user="u", max_tokens=100, temperature=0.1)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('{"a": 1}', {"a": 1}),
        ('  {"a": 1}\n', {"a": 1}),
        ('```json\n{"a": 1}\n```', {"a": 1}),
        ('```\n{"a": 1}\n```', {"a": 1}),
        ('Sure! Here is the JSON:\n{"a": {"b": "}"}}\nHope it helps.', {"a": {"b": "}"}}),
        ('{"a": "quote \\" and brace {"} trailing', {"a": 'quote " and brace {'}),
        ("[1, 2]", None),
        ("no json here", None),
        ('{"a": 1', None),
        ("", None),
    ],
)
def test_the_first_json_object_is_found_however_it_is_wrapped(
    text: str, expected: dict[str, object] | None
) -> None:
    assert extract_json_object(text) == expected


def test_the_extracted_text_parses_as_the_object() -> None:
    found = first_json_object_text('noise {"x": [1, {"y": 2}]} more')
    assert found is not None
    assert json.loads(found) == {"x": [1, {"y": 2}]}


def test_a_reply_that_is_mostly_braces_is_given_up_on_quickly() -> None:
    assert extract_json_object("{" * 50_000) is None


def test_the_chain_leaves_out_the_mock_and_providers_outside_the_region() -> None:
    india = FakeLlm(lambda _r: "{}", name="india", regions=frozenset({"in"}))
    anywhere = FakeLlm(lambda _r: "{}", name="anywhere")
    providers = (india, MockLlmProvider(), anywhere)

    assert [p.name for p in model_chain(providers, "in")] == ["india", "anywhere"]
    assert [p.name for p in model_chain(providers, "eu")] == ["anywhere"]
    assert model_chain(providers, "mars") == ()


async def test_an_error_moves_the_call_to_the_next_provider() -> None:
    second = FakeLlm(lambda _r: '{"ok": 2}', name="second", model="m2")
    ledger = CallLedger()

    reply = await complete_json(
        (failing("first"), second),
        lambda _p: REQUEST,
        what="t",
        deadline=Deadline(60),
        ledger=ledger,
    )

    assert reply is not None
    assert (reply.value, reply.provider, reply.model) == ({"ok": 2}, "second", "m2")
    assert ledger.calls == 1
    assert list(ledger.providers) == ["second"]


async def test_a_retryable_error_is_tried_once_more_on_the_same_provider() -> None:
    replies: list[str | LlmError] = [LlmError("429", provider="flaky", retryable=True), '{"ok": 1}']
    flaky = FakeLlm(lambda _r: replies.pop(0), name="flaky")

    reply = await complete_json((flaky,), lambda _p: REQUEST, what="t", deadline=Deadline(60))

    assert reply is not None and reply.value == {"ok": 1}
    assert len(flaky.requests) == 2


async def test_garbage_and_refused_replies_move_on_and_nothing_usable_is_none() -> None:
    garbage = FakeLlm(lambda _r: "I cannot help with that.", name="garbage")
    refused = FakeLlm(lambda _r: '{"wrong": true}', name="refused")

    reply = await complete_json(
        (garbage, refused),
        lambda _p: REQUEST,
        what="t",
        deadline=Deadline(60),
        accept=lambda value: "right" in value,
    )

    assert reply is None
    assert len(garbage.requests) == 1 and len(refused.requests) == 1


async def test_nothing_is_asked_once_the_deadline_has_passed() -> None:
    provider = FakeLlm(lambda _r: '{"ok": 1}')
    reply = await complete_json((provider,), lambda _p: REQUEST, what="t", deadline=Deadline(0))
    assert reply is None
    assert provider.requests == []


async def test_each_provider_gets_its_own_request() -> None:
    small = FakeLlm(lambda _r: "nope", name="small", max_prompt_chars=100)
    large = FakeLlm(lambda _r: '{"ok": 1}', name="large")

    await complete_json(
        (small, large),
        lambda provider: LlmRequest(
            system="s", user="x" * provider.max_prompt_chars, max_tokens=1, temperature=0
        ),
        what="t",
        deadline=Deadline(60),
    )

    assert len(small.requests[0].user) == 100
    assert len(large.requests[0].user) == 60_000


def test_the_ledger_prices_only_the_paid_provider() -> None:
    ledger = CallLedger()
    usage = LlmUsage(input_tokens=1_000_000, output_tokens=0)
    ledger.record(FakeLlm(lambda _r: "", name="ollama", model="q"), usage, "local")
    ledger.record(FakeLlm(lambda _r: "", name="sarvam", model="s"), usage, "remote")

    assert ledger.cost_inr == pytest.approx(29.28)
    assert ledger.paid_provider == ("sarvam", "s")
    assert ledger.providers["ollama"].endpoint == "local"


# ---------------------------------------------------------------------------
# generate_insight: the chain moves on past invalid output too
# ---------------------------------------------------------------------------


def _transcript() -> TranscriptInput:
    return TranscriptInput(
        language="en",
        duration_ms=20_000,
        segments=(TranscriptSegment(0, 4_000, "Hello everyone welcome to the show"),),
    )


async def test_a_provider_whose_output_stays_invalid_hands_over_to_the_next() -> None:
    broken = FakeLlm(lambda _r: "not json at all", name="broken")
    good = FakeLlm(lambda _r: {"chapters": [{"startMs": 0, "title": "Intro"}]}, name="good")

    result = await generate_insight("chapters", _transcript(), (broken, good), "in")

    assert result.provider == "good"
    assert len(broken.requests) == 2  # the call and its one repair
    assert result.output["chapters"][0]["title"] == "Intro"


async def test_a_fenced_reply_is_valid_output() -> None:
    fenced = FakeLlm(
        lambda _r: '```json\n{"chapters": [{"startMs": 0, "title": "Intro"}]}\n```',
        name="fenced",
    )
    result = await generate_insight("chapters", _transcript(), (fenced,), "in")
    assert result.output["chapters"][0]["title"] == "Intro"
    assert len(fenced.requests) == 1


async def test_an_adapter_that_raises_something_else_hands_over_too() -> None:
    def broken(_request: LlmRequest) -> str:
        raise RuntimeError("an adapter's bug")

    good = FakeLlm(lambda _r: {"chapters": [{"startMs": 0, "title": "Intro"}]}, name="good")
    result = await generate_insight("chapters", _transcript(), (FakeLlm(broken), good), "in")
    assert result.provider == "good"


@pytest.mark.parametrize(
    "body",
    [
        "<html>502 Bad Gateway</html>",
        '{"choices": []}',
        '{"choices": [{"message": {"content": null}}]}',
        '{"choices": [{"nope": 1}]}',
    ],
)
async def test_the_ollama_adapter_turns_an_unexpected_body_into_its_failure(body: str) -> None:
    """In production it is the paid model's fallback: a strange body must be a
    failure the chain handles, never an exception that escapes the job."""

    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, content=body.encode())

    provider = OllamaLlmProvider(client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)))
    if body == '{"choices": []}':
        # No choice is an empty answer (as before), which the caller refuses.
        assert (await provider.generate(REQUEST)).text == ""
        return
    with pytest.raises(LlmError):
        await provider.generate(REQUEST)


async def test_output_no_provider_gets_right_still_fails_as_invalid() -> None:
    first = FakeLlm(lambda _r: "nope", name="first")
    second = FakeLlm(lambda _r: "still nope", name="second")
    with pytest.raises(InvalidOutputError):
        await generate_insight("chapters", _transcript(), (first, second), "in")
