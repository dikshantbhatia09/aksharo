"""B10: ``ai.clean`` job-level behaviour — fetch, upload, payload validation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from worker_ai.audio import Pcm, write_wav
from worker_ai.clean.processor import process_clean
from worker_ai.processors import JobFailureError, Services
from worker_ai.storage import ObjectStore

from .conftest import MEDIA_ID, PROJECT_ID, WORKSPACE_ID
from .test_processors import build_services, context_for, recorder

CLEAN_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VE"
SAMPLE_RATE = 48_000


def _noisy_48k(seconds: float = 2.0) -> Pcm:
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    rng = np.random.default_rng(0)
    speech = 0.3 * np.sin(2 * np.pi * 220 * t)
    noise = 0.05 * rng.standard_normal(len(t))
    return Pcm(samples=(speech + noise).astype(np.float32), sample_rate=SAMPLE_RATE)


class _FakeS3:
    """Copies a fixed local source on download; records every upload."""

    def __init__(self, source: Path) -> None:
        self.source = source
        self.downloaded_keys: list[str] = []
        self.uploaded: dict[str, Path] = {}

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
        self.downloaded_keys.append(Key)
        Path(Filename).write_bytes(self.source.read_bytes())

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        return {"ContentLength": self.source.stat().st_size}

    def upload_file(self, Filename: str, Bucket: str, Key: str) -> None:  # noqa: N803
        self.uploaded[Key] = Path(Filename)


@pytest.fixture
def audio48k(tmp_path: Path) -> Path:
    return write_wav(tmp_path / "audio48k.wav", _noisy_48k())


def _clean_context(services: Services, **extra: Any) -> Any:
    return context_for(
        "ai.clean",
        services,
        mediaId=MEDIA_ID,
        cleanId=CLEAN_ID,
        strength="medium",
        target="social",
        **extra,
    )


async def test_downloads_audio48k_and_uploads_three_outputs(audio48k: Path) -> None:
    client = _FakeS3(audio48k)
    services = build_services(store=ObjectStore(bucket="derived", client=client))
    context = _clean_context(services)

    outcome = await process_clean(context)
    context.cleanup()

    assert client.downloaded_keys == [
        f"ws/{WORKSPACE_ID}/p/{PROJECT_ID}/media/{MEDIA_ID}/audio48k.wav"
    ]
    assert set(client.uploaded) == {
        f"ws/{WORKSPACE_ID}/p/{PROJECT_ID}/media/{MEDIA_ID}/clean48k-{CLEAN_ID}.wav",
        f"ws/{WORKSPACE_ID}/p/{PROJECT_ID}/media/{MEDIA_ID}/preview-{CLEAN_ID}-original.mp3",
        f"ws/{WORKSPACE_ID}/p/{PROJECT_ID}/media/{MEDIA_ID}/preview-{CLEAN_ID}-cleaned.mp3",
    }
    assert outcome.result["cleanId"] == CLEAN_ID
    assert outcome.result["strength"] == "medium"
    assert "inputLufs" in outcome.result["metrics"]
    assert outcome.result["storageKeys"]["cleanedAudioUrl"].endswith(f"clean48k-{CLEAN_ID}.wav")
    assert outcome.usage is not None
    assert outcome.usage.provider == "worker-ai/clean"


async def test_reports_progress_through_completion(audio48k: Path) -> None:
    client = _FakeS3(audio48k)
    services = build_services(store=ObjectStore(bucket="derived", client=client))
    context = _clean_context(services)

    await process_clean(context)
    context.cleanup()

    calls = recorder(services).progress_calls
    percentages = [percent for percent, _message in calls]
    assert percentages == sorted(percentages)
    assert percentages[-1] == 100


async def test_unknown_strength_is_not_retryable(audio48k: Path) -> None:
    client = _FakeS3(audio48k)
    services = build_services(store=ObjectStore(bucket="derived", client=client))
    context = context_for(
        "ai.clean",
        services,
        mediaId=MEDIA_ID,
        cleanId=CLEAN_ID,
        strength="extreme",
        target="social",
    )

    with pytest.raises(JobFailureError) as raised:
        await process_clean(context)
    assert raised.value.code == "worker/invalid_payload"
    assert raised.value.retryable is False


async def test_missing_clean_id_fails_fast(audio48k: Path) -> None:
    client = _FakeS3(audio48k)
    services = build_services(store=ObjectStore(bucket="derived", client=client))
    context = context_for(
        "ai.clean", services, mediaId=MEDIA_ID, strength="medium", target="social"
    )

    with pytest.raises(JobFailureError) as raised:
        await process_clean(context)
    assert raised.value.code == "worker/invalid_payload"


async def test_missing_store_completes_without_upload(audio48k: Path) -> None:
    """No derived bucket configured: the job still completes (local-only), and
    the storage keys stay empty rather than the job crashing.
    """
    services = build_services(store=None)
    context = _clean_context(services, audioUri=str(audio48k))

    outcome = await process_clean(context)
    context.cleanup()

    assert outcome.result["storageKeys"] == {}


async def test_dereverb_and_deesser_flags_pass_through(audio48k: Path) -> None:
    client = _FakeS3(audio48k)
    services = build_services(store=ObjectStore(bucket="derived", client=client))
    context = _clean_context(services, dereverb=True, deesser=True)

    outcome = await process_clean(context)
    context.cleanup()

    assert outcome.result["dereverb"] is True
    assert outcome.result["deesser"] is True
