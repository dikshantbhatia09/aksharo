"""`ai.pass` (passType `sfx`) queue adapter — `processors/sfx_pass.py` (D04c)."""

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


def _catalogue_entry(asset_id: str, cue_type: str) -> dict[str, Any]:
    return {
        "id": asset_id,
        "packId": "fixture-pack",
        "cueType": cue_type,
        "tags": [cue_type],
        "embedding": StubEmbedder().embed_text(f"{cue_type} sound effect"),
        "licenceSnapshot": {"provider": "owned", "licenceRef": "fixtures/audio-pack"},
    }


def _payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "passType": "sfx",
        "passId": "01JPASS0000000000000000004",
        "mediaId": MEDIA_ID,
        "durationMs": 60_000,
        "sentences": [
            {"startMs": 0, "endMs": 3_000, "text": "welcome back to the channel"},
            {"startMs": 10_000, "endMs": 13_000, "text": "did you know that"},
        ],
        "emphasisWords": [{"tMs": 20_000, "text": "wow"}],
        "speechRanges": [[0, 3_000], [10_000, 13_000], [20_000, 23_000]],
        # A flat (zero-variance) RMS series carries no energy signal
        # (`detect_energy_cues` needs stdev > 0), so tests that only care
        # about the word/text-derived cue kinds can supply one here without
        # perturbing their assertions, while still exercising the "producer
        # already sampled" branch (`_needs_rms_sampling`) instead of the
        # "download the proxy" one — see `_needs_rms_sampling_*` tests below
        # for that branch.
        "rmsSamples": [[t, 0.01] for t in range(0, 60_000, 1_000)],
        "cutRanges": [],
        "protectedRanges": [],
        "catalogue": [
            _catalogue_entry("01JASSET0000000000000000A1", "notification"),
            _catalogue_entry("01JASSET0000000000000000A2", "ding"),
        ],
    }
    base.update(overrides)
    return base


async def test_sfx_pass_produces_items_from_emphasis_and_question_cues() -> None:
    context = _context(**_payload())
    outcome = await process_pass(context)
    assert outcome.result["passType"] == "sfx"
    items = outcome.result["items"]
    assert len(items) >= 1
    for item in items:
        assert item["assetId"]
        assert item["packId"] == "fixture-pack"
        assert item["gainDb"] < 0
        assert item["licenceSnapshot"]["provider"] == "owned"
        assert item["cueReason"]
        assert item["duck"] is None or set(item["duck"]) == {"depthDb", "attackMs", "releaseMs"}


async def test_sfx_pass_needs_a_catalogue() -> None:
    payload = _payload(catalogue=[])
    context = _context(**payload)
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/invalid_payload"


async def test_sfx_pass_drops_cues_inside_protected_ranges() -> None:
    payload = _payload(protectedRanges=[[0, 60_000]])
    context = _context(**payload)
    outcome = await process_pass(context)
    assert outcome.result["items"] == []


async def test_sfx_pass_samples_the_proxy_when_rms_samples_absent_and_needs_storage() -> None:
    """D04d: an absent/empty `rmsSamples` means the worker should sample the
    540p proxy itself (`_needs_rms_sampling`, generalised from B19b's
    `reframe_zoom_pass._payload_needs_sampling`), not that the audio carries
    no energy signal. The test environment has no R2 configured
    (`derived_store is None`), so the shared `download_proxy` helper fails
    with a clear, non-retryable storage error — mirroring
    `test_reframe_pass_empty_detections_samples_the_proxy_and_needs_storage`.
    """
    payload = _payload(rmsSamples=[])
    context = _context(**payload)
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/storage_unconfigured"
    assert raised.value.retryable is False


async def test_sfx_pass_samples_the_proxy_when_rms_samples_key_missing() -> None:
    """Same as above, but the producer omits the key entirely rather than
    sending `[]` — both must be treated as "not sampled yet"."""
    payload = _payload()
    del payload["rmsSamples"]
    context = _context(**payload)
    with pytest.raises(JobFailureError) as raised:
        await process_pass(context)
    assert raised.value.code == "worker/storage_unconfigured"


async def test_sfx_pass_fires_an_energy_cue_from_supplied_rms_samples() -> None:
    """When the producer (or, in production, the worker's own proxy
    sampling) supplies a genuine energy spike, `detect_energy_cues` fires and
    `build_sfx_items` places a `sfx` item for it, carrying the default duck
    curve (an energy cue is not a `silence_gap` transition)."""
    flat = [(t, 0.01) for t in range(0, 3_000, 100)]
    spike = [(3_000, 0.9)]
    rest = [(t, 0.01) for t in range(3_100, 60_000, 1_000)]
    payload = _payload(
        sentences=[],
        emphasisWords=[],
        speechRanges=[],
        rmsSamples=[[t, v] for t, v in [*flat, *spike, *rest]],
        catalogue=[_catalogue_entry("01JASSET0000000000000000A4", "impact")],
    )
    context = _context(**payload)
    outcome = await process_pass(context)
    items = outcome.result["items"]
    assert len(items) == 1
    assert items[0]["duck"] is not None
    assert "energy" in items[0]["cueReason"]


async def test_sfx_pass_never_ducks_a_silence_gap_transition_cue() -> None:
    # A gap of >= 600ms between two speech ranges cues a `whoosh` transition —
    # placed where there is no speech, so it should never carry a duck curve.
    payload = _payload(
        sentences=[],
        emphasisWords=[],
        speechRanges=[[0, 3_000], [4_000, 6_000]],
        catalogue=[_catalogue_entry("01JASSET0000000000000000A3", "whoosh")],
    )
    context = _context(**payload)
    outcome = await process_pass(context)
    items = outcome.result["items"]
    assert len(items) == 1
    assert items[0]["duck"] is None
