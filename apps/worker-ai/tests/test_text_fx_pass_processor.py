"""`ai.pass` (passType `textfx`) queue adapter — `processors/text_fx_pass.py`."""

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
        "createdAt": "2026-09-03T10:00:00.000Z",
        "payload": dict(payload),
    }


def _services() -> Services:
    settings = load_settings({**VALID_ENV, "FEATURE_FLAGS_JSON": '{"asr.local-whisper": false}'})
    from tests.test_processors import RecordingCallbacks

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


def _words_for(segments: list[dict[str, Any]]) -> list[list[Any]]:
    words: list[list[Any]] = []
    index = 0
    for segment in segments:
        text_words = segment["text"].split()
        if not text_words:
            continue
        span = (segment["endMs"] - segment["startMs"]) // max(1, len(text_words))
        t = segment["startMs"]
        for word in text_words:
            words.append([f"0:{index}", t, t + span - 5, word])
            index += 1
            t += span
    return words


def _payload(**overrides: Any) -> dict[str, Any]:
    segments = [
        {"startMs": 0, "endMs": 3000, "text": "welcome back to the channel today"},
        {"startMs": 25_000, "endMs": 28_000, "text": "here are ten quick tips"},
        {"startMs": 50_000, "endMs": 53_000, "text": "why does this even matter"},
    ]
    base: dict[str, Any] = {
        "passType": "textfx",
        "passId": "01JPASS0000000000000000003",
        "mediaId": MEDIA_ID,
        "durationMs": 60_000,
        "language": "en",
        "segments": segments,
        "words": _words_for(segments),
        "cutRanges": [],
        "protectedRanges": [],
    }
    base.update(overrides)
    return base


async def test_text_fx_pass_produces_title_items_from_the_mock_provider() -> None:
    context = _context(**_payload())
    outcome = await process_pass(context)
    assert outcome.result["passType"] == "textfx"
    items = outcome.result["items"]
    assert len(items) >= 1
    for item in items:
        assert item["text"]
        assert item["intent"] in {"title", "stat", "quote", "hook"}
        assert item["motionPreset"] in {
            "pop",
            "slide-up",
            "typewriter",
            "underline",
            "count-up",
            "fade",
        }
        assert item["anchorWordIds"]


async def test_text_fx_pass_needs_segments() -> None:
    payload = _payload(segments=[])
    context = _context(**payload)
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/invalid_payload"


async def test_text_fx_pass_drops_events_inside_protected_ranges() -> None:
    payload = _payload(protectedRanges=[[0, 60_000]])
    context = _context(**payload)
    outcome = await process_pass(context)
    assert outcome.result["items"] == []
