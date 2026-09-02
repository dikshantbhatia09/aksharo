"""The real model, on CPU, over the five-second fixture clip.

``RUN_SLOW=1`` only: this downloads faster-whisper ``tiny`` (~75 MB) the first
time it runs, and a suite that silently pulls weights on a fresh clone is a suite
everyone learns to skip.

## What this test can and cannot assert

``worker_ai/fixtures/speech-5s/clip.wav`` is a **synthesised** source-filter
signal, not speech: its own README says no ASR model will find words in it, and
that is deliberate — it proves the *pipeline*, not the *quality*. So the
assertions here are exactly the ones the brief names and no more: the request
completes, a language comes back, the timings are monotonic and inside the clip,
and the usage block adds up. Word accuracy needs the hand-labelled sets of
`09 §8`, which are A00-05's deliverable, and no routing weight may move on the
strength of this file.

The measured realtime factor is printed and recorded in ``cost.md``. It is a CPU
number on ``tiny``: it bounds nothing about a GPU running ``large-v3-turbo``, and
its only honest use is to prove the cost-accounting path produces a real figure
rather than a zero.
"""

from __future__ import annotations

import concurrent.futures
import os
import time
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from model_server.app import create_app
from model_server.metrics import Metrics
from model_server.models.registry import ModelRegistry
from model_server.models.whisper import FasterWhisperAsr
from tests.conftest import SPEECH_CLIP, TOKEN, build_settings

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(not SPEECH_CLIP.is_file(), reason="A10's speech-5s clip is not present"),
]

#: Small enough to download inside a test, real enough to exercise CTranslate2.
TINY = "tiny"

# huggingface_hub warns, on a Windows box without developer mode, that its cache
# cannot use symlinks. ``filterwarnings = ["error"]`` turns that into a failed
# model load, which is the registry behaving correctly about a warning that is
# not about this code at all. Silenced here rather than weakening the filter.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


@pytest.fixture(scope="module")
def cpu_client() -> Iterator[TestClient]:
    """A server with a real faster-whisper ``tiny`` resident on CPU."""
    pytest.importorskip("faster_whisper")
    settings = build_settings(
        device="cpu",
        whisper_model=TINY,
        compute_type="int8",
        preload=("asr",),
        batch_max_size=4,
        batch_window_ms=50,
        memory_budget_bytes=4 * 1024 * 1024 * 1024,
    )
    registry = ModelRegistry(
        asr=FasterWhisperAsr(TINY, device="cpu", compute_type="int8"),
        aligner=None,
        diariser=None,
        required=("asr",),
    )
    app = create_app(settings, registry=registry, metrics=Metrics.create(), configure_logs=False)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def auth_header() -> dict[str, str]:
    return {"authorization": "Bearer " + TOKEN}


def test_the_server_is_ready_with_the_tiny_model_resident(cpu_client: TestClient) -> None:
    body = cpu_client.get("/readyz").json()
    assert body["ready"] is True
    assert body["models"]["asr"]["model"] == TINY
    # Loading happened at startup, and it took a measurable amount of time.
    assert body["models"]["asr"]["loadSeconds"] > 0


def test_transcribe_on_the_five_second_clip(
    cpu_client: TestClient, auth_header: dict[str, str]
) -> None:
    started = time.perf_counter()
    response = cpu_client.post(
        "/transcribe",
        json={"audio": str(SPEECH_CLIP), "wordTimestamps": True, "beamSize": 1},
        headers=auth_header,
    )
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    body = response.json()

    assert 4.9 < body["durationS"] < 5.1
    assert body["language"], "a language must come back even for a synthetic clip"
    assert 0.0 <= body["languageProbability"] <= 1.0
    assert body["model"] == TINY
    assert body["requestId"]

    # The brief's two assertions: timings monotonic, and inside the clip.
    times: list[float] = []
    for word in body["words"]:
        assert 0.0 <= word["start"] <= word["end"] <= body["durationS"] + 0.5
        times.extend((word["start"], word["end"]))
    assert times == sorted(times), "word timings must be monotonic"

    usage = body["usage"]
    assert usage["audioSeconds"] == pytest.approx(body["durationS"], abs=0.01)
    assert usage["gpuSeconds"] > 0
    assert usage["batchSize"] == 1

    rtf = usage["gpuSeconds"] / usage["audioSeconds"]
    print(
        "\nCPU-tiny measurement: audio "
        + format(usage["audioSeconds"], ".2f")
        + " s, compute "
        + format(usage["gpuSeconds"], ".3f")
        + " s, RTF "
        + format(rtf, ".4f")
        + ", wall clock "
        + format(elapsed, ".2f")
        + " s"
    )
    # No performance threshold: a CI runner's CPU is not a benchmark, and an
    # assertion on speed here would be a flake generator.
    assert rtf > 0


def test_detect_language_on_the_five_second_clip(
    cpu_client: TestClient, auth_header: dict[str, str]
) -> None:
    response = cpu_client.post(
        "/detect-language",
        json={"audio": str(SPEECH_CLIP), "windows": [[0, 5000]]},
        headers=auth_header,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["language"], "LID must always name a language"
    assert 0.0 <= body["probability"] <= 1.0
    assert body["windows"][0]["startMs"] == 0
    assert body["windows"][0]["endMs"] == 5000
    assert body["usage"]["audioSeconds"] == pytest.approx(5.0, abs=0.05)
    print("\nCPU-tiny LID: " + body["language"] + " at " + format(body["probability"], ".3f"))


def test_the_default_lid_window_is_the_first_thirty_seconds(
    cpu_client: TestClient, auth_header: dict[str, str]
) -> None:
    body = cpu_client.post(
        "/detect-language", json={"audio": str(SPEECH_CLIP)}, headers=auth_header
    ).json()
    assert len(body["windows"]) == 1
    # The clip is shorter than 30 s, so the default window is the whole clip.
    assert body["windows"][0]["endMs"] == pytest.approx(5000, abs=50)


def test_concurrent_chunks_share_one_real_model_call(
    cpu_client: TestClient, auth_header: dict[str, str]
) -> None:
    """The same batching path as the fake test, but through CTranslate2."""

    def call(_: int) -> dict[str, Any]:
        response = cpu_client.post(
            "/transcribe",
            json={"audio": str(SPEECH_CLIP), "beamSize": 1},
            headers=auth_header,
        )
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        bodies = list(pool.map(call, range(3)))

    assert all(body["durationS"] > 4.9 for body in bodies)
    sizes = [body["usage"]["batchSize"] for body in bodies]
    assert max(sizes) >= 2, "three concurrent chunks produced batch sizes " + repr(sizes)
