"""`ai.pass` (passType `zoom`/`reframe`) queue adapters — `processors/reframe_zoom_pass.py`."""

from __future__ import annotations

import struct
from typing import Any

import pytest

from worker_ai.alignment import AlignerRegistry
from worker_ai.diarisation import DiariserRegistry
from worker_ai.processors.autocut_pass import process_pass
from worker_ai.processors.context import JobContext, JobFailureError, Services
from worker_ai.processors.reframe_zoom_pass import pack_keyframes
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


def _unpack_header(blob: bytes) -> tuple[bytes, int, int]:
    magic, version, count = struct.unpack_from("<4sII", blob, 0)
    return magic, version, count


# ---------------------------------------------------------------------------
# pack_keyframes byte format
# ---------------------------------------------------------------------------


async def test_pack_keyframes_matches_documented_header() -> None:
    packed = pack_keyframes([(0.0, 0.5, 0.5, 1.0), (180.0, 0.5, 0.5, 1.2)])
    magic, version, count = _unpack_header(packed)
    assert magic == b"MKF1"
    assert version == 1
    assert count == 2
    assert len(packed) == 12 + 2 * 16


async def test_pack_keyframes_empty() -> None:
    packed = pack_keyframes([])
    assert len(packed) == 12
    _, _, count = _unpack_header(packed)
    assert count == 0


async def test_pack_keyframes_sorts_by_time() -> None:
    packed = pack_keyframes([(500.0, 0.1, 0.1, 1.0), (0.0, 0.2, 0.2, 1.0)])
    rows = struct.unpack_from("<ffff", packed, 12)
    assert rows[0] == pytest.approx(0.0)
    second_row = struct.unpack_from("<ffff", packed, 12 + 16)
    assert second_row[0] == pytest.approx(500.0)


# ---------------------------------------------------------------------------
# zoom pass end to end
# ---------------------------------------------------------------------------


def _zoom_payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "passType": "zoom",
        "passId": "01JPASS0000000000000000001",
        "durationMs": 10_000,
        "preset": "standard",
        "emphasisWords": [{"tMs": 2000}, {"tMs": 8000}],
        "detections": [
            {"tMs": t, "boxes": [{"x": 0.4, "y": 0.3, "w": 0.2, "h": 0.3}]}
            for t in range(0, 10_000, 200)
        ],
    }
    base.update(overrides)
    return base


async def test_zoom_pass_produces_events_with_packed_keyframes() -> None:
    context = _context(**_zoom_payload())
    outcome = await process_pass(context)
    assert outcome.result["passType"] == "zoom"
    items = outcome.result["items"]
    assert len(items) == 2  # two emphasis cues, 2s apart -- more than the 2.5s min gap
    for item in items:
        keyframes_bytes = bytes.fromhex(item["keyframes"])
        _, version, count = _unpack_header(keyframes_bytes)
        assert version == 1
        assert count == 4  # 4 keyframe rows per zoom event


async def test_zoom_pass_respects_rate_limit_across_close_cues() -> None:
    payload = _zoom_payload(emphasisWords=[{"tMs": 1000}, {"tMs": 1500}])
    context = _context(**payload)
    outcome = await process_pass(context)
    assert len(outcome.result["items"]) == 1


async def test_zoom_pass_with_no_cues_produces_no_items() -> None:
    payload = _zoom_payload(emphasisWords=[])
    context = _context(**payload)
    outcome = await process_pass(context)
    assert outcome.result["items"] == []


# ---------------------------------------------------------------------------
# reframe pass end to end
# ---------------------------------------------------------------------------


def _reframe_payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "passType": "reframe",
        "passId": "01JPASS0000000000000000002",
        "durationMs": 4_000,
        "detections": [
            {"tMs": t, "boxes": [{"x": 0.4, "y": 0.3, "w": 0.2, "h": 0.3}]}
            for t in range(0, 4_000, 200)
        ],
    }
    base.update(overrides)
    return base


async def test_reframe_pass_produces_one_item_with_packed_keyframes() -> None:
    context = _context(**_reframe_payload())
    outcome = await process_pass(context)
    assert outcome.result["passType"] == "reframe"
    items = outcome.result["items"]
    assert len(items) == 1
    item = items[0]
    assert item["aspect"] == "9:16"
    keyframes_bytes = bytes.fromhex(item["keyframes"])
    _, version, count = _unpack_header(keyframes_bytes)
    assert version == 1
    assert count > 0


async def test_reframe_pass_empty_detections_fails_non_retryable() -> None:
    payload = _reframe_payload(detections=[])
    context = _context(**payload)
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/invalid_payload"
    assert raised.value.retryable is False


async def test_reframe_pass_target_aspect_1_1() -> None:
    payload = _reframe_payload(targetAspect=1.0)
    context = _context(**payload)
    outcome = await process_pass(context)
    assert outcome.result["items"][0]["aspect"] == "1:1"
