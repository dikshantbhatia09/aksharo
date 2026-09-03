"""`ai.pass` (passType `music`) queue adapter — `processors/music_pass.py` (D05)."""

from __future__ import annotations

from typing import Any

import pytest

from worker_ai.alignment import AlignerRegistry
from worker_ai.audio_embed import StubEmbedder
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


def _catalogue_entry(
    asset_id: str, mood: str, bpm: int, *, duration_ms: int = 40_000
) -> dict[str, Any]:
    return {
        "id": asset_id,
        "packId": "fixture-pack",
        "mood": [mood],
        "bpm": bpm,
        "embedding": StubEmbedder().embed_text(f"{mood} background music"),
        "licenceSnapshot": {"provider": "owned", "licenceRef": "fixtures/audio-pack"},
        "introMs": 500,
        "outroMs": 500,
        "durationMs": duration_ms,
    }


def _payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "passType": "music",
        "passId": "01JPASS0000000000000000005",
        "durationMs": 30_000,
        "speechRanges": [[0, 30_000]],
        "cutTimesMs": [1_000, 2_000, 3_000],
        "sentiment": [[15_000, 0.4]],
        "protectedRanges": [],
        "catalogue": [
            _catalogue_entry("01JASSET0000000000000000B1", "calm", 92),
            _catalogue_entry("01JASSET0000000000000000B2", "upbeat", 128),
        ],
    }
    base.update(overrides)
    return base


async def test_music_pass_produces_items() -> None:
    context = _context(**_payload())
    outcome = await process_pass(context)
    assert outcome.result["passType"] == "music"
    assert isinstance(outcome.result["bpmTarget"], int)
    items = outcome.result["items"]
    assert len(items) >= 1
    for item in items:
        assert item["assetId"]
        assert item["packId"] == "fixture-pack"
        assert item["loopPolicy"] in {"none", "loop", "trim"}
        assert item["bedDuck"] == {"depthDb": -12, "attackMs": 150, "releaseMs": 150}
        assert item["licenceSnapshot"]["provider"] == "owned"
        assert isinstance(item["mood"], list)


async def test_music_pass_needs_a_catalogue() -> None:
    payload = _payload(catalogue=[])
    context = _context(**payload)
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/invalid_payload"


async def test_music_pass_drops_sections_inside_protected_ranges() -> None:
    payload = _payload(protectedRanges=[[0, 30_000]])
    context = _context(**payload)
    outcome = await process_pass(context)
    assert outcome.result["items"] == []


async def test_music_pass_bpm_target_reflects_cut_cadence() -> None:
    tight = _payload(cutTimesMs=list(range(0, 30_000, 500)))
    loose = _payload(cutTimesMs=list(range(0, 30_000, 6_000)))
    tight_outcome = await process_pass(_context(**tight))
    loose_outcome = await process_pass(_context(**loose))
    assert tight_outcome.result["bpmTarget"] > loose_outcome.result["bpmTarget"]
