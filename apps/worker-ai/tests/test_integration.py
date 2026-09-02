"""End to end against the real stack: BullMQ → this worker → the real API.

This is the test that proves the three things unit tests cannot:

1. the envelope the **Node** producer writes parses here, byte for byte;
2. a `bullmq.Worker` (the real one, on the real Redis) hands us that job;
3. the signature this worker computes is accepted by the **real**
   `InternalSignatureGuard`, and the completion moves the real `jobs` row.

It is skipped unless ``RUN_INTEGRATION=1`` because it needs the compose stack and
a running API. What it needs, and why each piece:

```
docker compose up -d                       # Redis + Postgres, from 05-build/montaj
pnpm --filter @montaj/api build            # the harness imports apps/api/dist
$env:DATABASE_URL      = "...montaj_a09"   # a database of this WP's own
$env:MONTAJ_QUEUE_PREFIX = "a09"           # queues nobody else reads
pnpm --filter @montaj/api db:migrate
pnpm --filter @montaj/api start            # or `dev`
$env:RUN_INTEGRATION = "1"
python -m pytest tests/test_integration.py -q --no-cov
```

The API and this test must agree on `MONTAJ_QUEUE_PREFIX` and
`INTERNAL_CALLBACK_SECRET`; both are read from the environment, so exporting them
once covers both processes.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess  # a fixed node script, argv list, never a shell
from pathlib import Path
from typing import Any

import httpx2
import pytest

from worker_ai.audio import write_wav
from worker_ai.policies import worker_options
from worker_ai.runtime import build_services, close_services, make_handler
from worker_ai.settings import load_repo_dotenv, load_settings

from .conftest import clip

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("RUN_INTEGRATION") != "1",
        reason="needs the compose stack and a running API; set RUN_INTEGRATION=1",
    ),
]

APP_DIR = Path(__file__).resolve().parents[1]
HARNESS = APP_DIR / "scripts" / "integration-job.mjs"
API_DIST = APP_DIR.parents[0] / "api" / "dist" / "jobs" / "contracts" / "job-envelope.js"


def _node(*args: str) -> dict[str, Any]:
    """Run the Node harness and parse its single line of JSON."""
    node = shutil.which("node")
    if node is None:  # pragma: no cover - node is a repo-wide prerequisite
        pytest.skip("node is not on PATH")
    completed = subprocess.run(  # noqa: S603 - fixed script, argv list, shell=False
        [node, str(HARNESS), *args],
        capture_output=True,
        text=True,
        cwd=APP_DIR,
        check=False,
        timeout=120,
    )
    if completed.returncode != 0:
        pytest.fail(f"harness {args[0]} failed:\n{completed.stderr}")
    parsed: dict[str, Any] = json.loads(completed.stdout.strip().splitlines()[-1])
    return parsed


@pytest.fixture(scope="module")
def settings() -> Any:
    load_repo_dotenv(APP_DIR)
    if not API_DIST.is_file():
        pytest.skip("run `pnpm --filter @montaj/api build` first")
    return load_settings()


@pytest.fixture(scope="module")
def api_is_up(settings: Any) -> None:
    try:
        response = httpx2.get(f"{settings.api_origin}/health", timeout=5)
    except httpx2.HTTPError as error:
        pytest.skip(f"the API is not reachable at {settings.api_origin}: {error}")
    if response.status_code != 200:
        pytest.skip(f"the API answered {response.status_code} on /health")


@pytest.fixture
def audio_file(tmp_path: Path) -> Path:
    """A clip with two silences, so the plan and the regions are both non-trivial."""
    return write_wav(
        tmp_path / "audio16k.wav",
        clip(
            ("speech", 1_200),
            ("silence", 700),
            ("speech", 1_400),
            ("silence", 600),
            ("speech", 1_100),
        ),
    )


async def _consume_one(settings: Any, queue: str, bull_job_id: str) -> dict[str, Any]:
    """Run a real BullMQ worker until it has processed ``bull_job_id``."""
    from bullmq import Worker

    services = build_services(settings)
    handler = make_handler(queue, services)
    finished: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

    async def process(job: Any, token: str | None = None) -> dict[str, Any]:
        try:
            result = await handler(job, token)
        except Exception as error:  # surface the failure to the test, then to BullMQ
            if not finished.done() and job.id == bull_job_id:
                finished.set_exception(error)
            raise
        if job.id == bull_job_id and not finished.done():
            finished.set_result(result)
        return result

    worker = Worker(
        queue,
        process,
        # The same A08b policy options `__main__` uses, so the integration run
        # exercises the real lock and stall settings.
        worker_options(
            queue, redis_url=settings.redis_url, concurrency=1, prefix=settings.queue_prefix
        ),
    )
    try:
        return await asyncio.wait_for(finished, timeout=120)
    finally:
        await worker.close()
        await close_services(services)


async def test_a_transcribe_job_runs_end_to_end(
    settings: Any, api_is_up: None, audio_file: Path
) -> None:
    """Producer → Redis → this worker → signed completion → the real `jobs` row."""
    seeded = _node(
        "seed",
        "--type",
        "ai.transcribe",
        "--payload",
        json.dumps({"mediaId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VD", "audioUri": str(audio_file)}),
    )
    assert seeded["prefix"] == settings.queue_prefix, (
        "the harness and this worker must share MONTAJ_QUEUE_PREFIX"
    )

    result = await _consume_one(settings, "ai.transcribe", seeded["bullJobId"])

    # The worker's own result.
    assert result["chunks"], result
    assert result["chunks"][0]["words"][0]["wid"] == "0:0"
    assert result["provider"] == "mock"
    assert result["providerSubmissions"]

    # What the API actually recorded, through the real guard and service.
    row = _node("check", "--job", seeded["jobId"])
    assert row["found"] is True
    assert row["status"] == "succeeded", row
    assert row["progress"] == 100
    assert row["provider"] == "mock"
    assert row["result"]["chunks"][0]["chunkIdx"] == 0
    # progress(0) flipped the row to running before the completion settled it.
    assert "job.started" in row["events"]
    assert "job.succeeded" in row["events"]


async def test_a_completion_replay_is_accepted_and_changes_nothing(
    settings: Any, api_is_up: None, audio_file: Path
) -> None:
    """CONTRACTS §3: replays return 200 without side effects."""
    from worker_ai.callbacks import CallbackClient, JobCompletion

    seeded = _node(
        "seed",
        "--type",
        "ai.vad",
        "--payload",
        json.dumps({"mediaId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VD", "audioUri": str(audio_file)}),
    )
    await _consume_one(settings, "ai.vad", seeded["bullJobId"])

    async with CallbackClient(settings.api_origin, settings.internal_callback_secret) as client:
        replay = await client.complete(
            seeded["jobId"],
            seeded["attemptId"],
            JobCompletion(status="succeeded", result={"replayed": True}),
        )

    assert replay.applied is False
    assert replay.reason == "already_completed"

    row = _node("check", "--job", seeded["jobId"])
    assert row["status"] == "succeeded"
    assert "replayed" not in row["result"]


async def test_a_wrong_signature_is_refused_by_the_real_guard(
    settings: Any, api_is_up: None
) -> None:
    """The other half of THREAT-MODEL T8: a forged callback never lands."""
    from worker_ai.callbacks import CallbackClient, CallbackError, JobCompletion

    seeded = _node("seed", "--type", "ai.vad", "--payload", "{}")

    async with CallbackClient(settings.api_origin, "f" * 64) as client:
        with pytest.raises(CallbackError) as raised:
            await client.complete(
                seeded["jobId"], seeded["attemptId"], JobCompletion(status="succeeded")
            )

    assert raised.value.status_code == 401
    assert _node("check", "--job", seeded["jobId"])["status"] == "queued"


async def test_an_unimplemented_queue_dead_letters_with_its_reason(
    settings: Any, api_is_up: None
) -> None:
    seeded = _node("seed", "--type", "ai.translate", "--payload", "{}")

    with pytest.raises(Exception, match="not implemented"):
        await _consume_one(settings, "ai.translate", seeded["bullJobId"])

    row = _node("check", "--job", seeded["jobId"])
    assert row["status"] == "failed"
    assert row["error"]["code"] == "worker/not_implemented"
    assert row["error"]["retryable"] is False
    # `retryable: false` is what A08's `markDeadLetterIfFinal` reads.
    assert "job.dead_lettered" in row["events"]


def test_the_harness_uses_the_apis_own_contract_modules() -> None:
    """A re-implemented envelope would pass this suite and fail in production."""
    source = HARNESS.read_text(encoding="utf-8")
    assert "buildJobEnvelope" in source
    assert "bullJobId" in source
    assert "queuePolicyFor" in source
