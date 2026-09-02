"""`ai.pass` (passType `autocut`) queue adapter — `processors/autocut_pass.py`."""

from __future__ import annotations

from typing import Any

import pytest

from worker_ai.alignment import AlignerRegistry
from worker_ai.diarisation import DiariserRegistry
from worker_ai.processors.autocut_pass import process_pass
from worker_ai.processors.context import JobContext, JobFailureError, Services
from worker_ai.providers.registry import build_registry
from worker_ai.queues import parse_envelope
from worker_ai.routing import load_routing_table
from worker_ai.settings import load_settings
from worker_ai.vad import EnergyVad

from .conftest import ATTEMPT_ID, JOB_ID, MEDIA_ID, PROJECT_ID, VALID_ENV, WORKSPACE_ID

pytestmark = pytest.mark.asyncio


def _envelope(**payload: Any) -> dict[str, Any]:
    return {
        "jobId": JOB_ID,
        "attemptId": ATTEMPT_ID,
        "workspaceId": WORKSPACE_ID,
        "projectId": PROJECT_ID,
        "priority": 3,
        "jobKey": f"ai.pass:{MEDIA_ID}",
        "createdAt": "2026-09-02T10:00:00.000Z",
        "payload": dict(payload),
    }


def _services() -> Services:
    settings = load_settings({**VALID_ENV, "FEATURE_FLAGS_JSON": '{"asr.local-whisper": false}'})
    from tests.test_processors import RecordingCallbacks  # local import: shares the test double

    return Services(
        settings=settings,
        callbacks=RecordingCallbacks(),
        providers=build_registry(settings),
        routing=load_routing_table(),
        aligners=AlignerRegistry.default(),
        diarisers=DiariserRegistry.default(),
        vad=EnergyVad(),
    )


def _context(**payload: Any) -> JobContext:
    return JobContext(
        envelope=parse_envelope(_envelope(**payload)), queue="ai.pass", services=_services()
    )


def _words(count: int, *, gap_ms: int = 300) -> list[dict[str, Any]]:
    tokens = ["so", "um", "we", "went", "there", "matlab", "and", "it", "was", "great"]
    words: list[dict[str, Any]] = []
    t = 0
    for i in range(count):
        words.append({"wid": f"0:{i}", "s": t, "e": t + 250, "t": tokens[i % len(tokens)]})
        t += gap_ms
    return words


async def test_unsupported_pass_type_fails_non_retryable() -> None:
    context = _context(passType="reframe", passId="01JPASS0000000000000000000")
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/not_implemented"
    assert raised.value.retryable is False


async def test_missing_words_fails_non_retryable() -> None:
    context = _context(passType="autocut", passId="01JPASS0000000000000000000", words=[])
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/invalid_payload"
    assert raised.value.retryable is False


async def test_autocut_pass_end_to_end_with_word_derived_regions() -> None:
    words = _words(20)
    duration_ms = words[-1]["e"] + 1000
    context = _context(
        passType="autocut",
        passId="01JPASS0000000000000000000",
        preset="standard",
        language="en",
        durationMs=duration_ms,
        words=words,
    )
    outcome = await process_pass(context)
    assert outcome.result["passId"] == "01JPASS0000000000000000000"
    assert outcome.result["passType"] == "autocut"
    assert outcome.result["preset"] == "standard"
    assert isinstance(outcome.result["items"], list)
    assert isinstance(outcome.result["counts"], dict)
    # "um" (always-cut) is present among the fixture's tokens.
    reasons = {item["reason"] for item in outcome.result["items"]}
    assert reasons <= {"silence", "pause", "filler", "retake"}
    assert outcome.usage is not None
    assert outcome.usage.media_seconds == pytest.approx(duration_ms / 1000)


async def test_explicit_speech_regions_are_honoured_over_word_derivation() -> None:
    # No filler tokens here: the point is an isolated trailing silence, sized so
    # it fits comfortably under `standard`'s 30% removal cap relative to a
    # deliberately long total duration.
    tokens = ["there", "and", "it", "was", "great"] * 6
    words: list[dict[str, Any]] = []
    t = 0
    for i, tok in enumerate(tokens):
        words.append({"wid": f"0:{i}", "s": t, "e": t + 250, "t": tok})
        t += 300
    last_end = words[-1]["e"]
    duration_ms = last_end + 3_000

    context = _context(
        passType="autocut",
        passId="01JPASS0000000000000000000",
        preset="standard",
        language="en",
        durationMs=duration_ms,
        words=words,
        speechRegions=[{"startMs": 0, "endMs": last_end}],
    )
    outcome = await process_pass(context)
    silence_items = [item for item in outcome.result["items"] if item["reason"] == "silence"]
    assert any(item["endMs"] <= duration_ms for item in silence_items)
    assert any(item["startMs"] >= last_end - 1 for item in silence_items)


async def test_protected_ranges_and_guarded_words_are_respected() -> None:
    words = _words(10)
    duration_ms = words[-1]["e"] + 500
    protected_word = words[1]  # an "um" in the always-cut lexicon
    context = _context(
        passType="autocut",
        passId="01JPASS0000000000000000000",
        preset="standard",
        language="en",
        durationMs=duration_ms,
        words=words,
        guardedWordIds=[protected_word["wid"]],
    )
    outcome = await process_pass(context)
    cut_word_ids = {wid for item in outcome.result["items"] for wid in item["wordIds"]}
    assert protected_word["wid"] not in cut_word_ids
