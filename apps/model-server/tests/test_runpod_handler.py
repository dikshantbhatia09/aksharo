"""The RunPod queue lane, proving it is the same app rather than a second one."""

from __future__ import annotations

import pytest

from model_server.runpod_handler import RunPodWorker
from tests.conftest import TOKEN, build_settings, inline, make_wav


async def worker(**overrides: object) -> RunPodWorker:
    """A RunPod worker wired to the same fakes the HTTP tests use."""
    from model_server.models.registry import ModelRegistry
    from tests.conftest import FakeAligner, FakeAsr, FakeDiariser

    settings = build_settings(**overrides)
    registry = ModelRegistry(
        asr=FakeAsr(),
        aligner=FakeAligner(),
        diariser=FakeDiariser(),
        required=settings.preload,
    )
    instance = RunPodWorker(settings, registry=registry)
    await instance.start()
    return instance


async def test_a_transcribe_event_returns_the_same_body_as_the_route() -> None:
    instance = await worker()
    try:
        result = await instance.handle(
            {"input": {"route": "/transcribe", "body": {"audio": inline(make_wav(2.0))}}}
        )
    finally:
        await instance.stop()
    output = result["output"]
    assert output["language"] == "hi"
    assert output["durationS"] == 2.0
    assert output["usage"]["batchSize"] >= 1
    assert output["words"]


async def test_a_flat_input_defaults_to_transcribe() -> None:
    instance = await worker()
    try:
        result = await instance.handle({"input": {"audio": inline(make_wav(1.0))}})
    finally:
        await instance.stop()
    assert "output" in result


async def test_every_route_is_reachable_by_name() -> None:
    instance = await worker()
    audio = inline(make_wav(2.0))
    bodies = {
        "diarise": {"audio": audio},
        "detect-language": {"audio": audio},
        "align": {"audio": audio, "words": ["toh"], "language": "hi"},
    }
    try:
        for route, body in bodies.items():
            result = await instance.handle({"input": {"route": route, "body": body}})
            assert "output" in result, route + ": " + repr(result)
    finally:
        await instance.stop()


async def test_an_unknown_route_is_an_error_not_a_traceback() -> None:
    instance = await worker()
    try:
        result = await instance.handle({"input": {"route": "summarise", "body": {}}})
    finally:
        await instance.stop()
    assert result["error"]["code"] == "model-server/unknown-route"


async def test_a_missing_input_object_is_an_error() -> None:
    instance = await worker()
    try:
        assert "error" in await instance.handle({})
    finally:
        await instance.stop()


async def test_a_model_error_becomes_an_error_envelope_with_retry_after() -> None:
    instance = await worker(
        memory_budget_bytes=1024 * 1024, memory_bytes_per_audio_second=1024 * 1024
    )
    try:
        result = await instance.handle(
            {"input": {"route": "transcribe", "body": {"audio": inline(make_wav(4.0))}}}
        )
    finally:
        await instance.stop()
    assert result["error"]["code"] == "model-server/overloaded"
    assert result["error"]["retryAfterSeconds"] == 5


async def test_the_optional_event_token_is_enforced_when_asked_for() -> None:
    instance = await worker(runpod_require_token=True)
    audio = inline(make_wav(1.0))
    try:
        refused = await instance.handle({"input": {"route": "transcribe", "audio": audio}})
        assert refused["error"]["code"] == "model-server/unauthorized"

        allowed = await instance.handle(
            {"input": {"route": "transcribe", "token": TOKEN, "audio": audio}}
        )
        assert "output" in allowed
    finally:
        await instance.stop()


@pytest.mark.parametrize("route", ["transcribe", "/transcribe", "//transcribe"])
async def test_the_route_may_carry_a_leading_slash(route: str) -> None:
    instance = await worker()
    try:
        result = await instance.handle(
            {"input": {"route": route, "body": {"audio": inline(make_wav(1.0))}}}
        )
    finally:
        await instance.stop()
    assert "output" in result
