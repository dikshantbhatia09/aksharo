"""Entry point: the BullMQ consumer plus the FastAPI control app.

Run with::

    python -m worker_ai

Both live in one process because the control app exists to describe *this*
worker — its queues, its model cache, its routing state (A09).
"""

from __future__ import annotations

import asyncio
import os

import uvicorn
from bullmq import Worker

from worker_ai import __version__
from worker_ai.control import app as control_app
from worker_ai.logging_setup import configure_logging, get_logger
from worker_ai.processors import process_transcribe
from worker_ai.queues import AI_TRANSCRIBE_QUEUE
from worker_ai.settings import load_repo_dotenv, load_settings

__all__ = ["main", "run"]

_log = get_logger("worker_ai")

#: Concurrent jobs. A09 tunes this against the serverless-GPU pool.
DEFAULT_CONCURRENCY = 4
#: Control app port; pod-internal only, never exposed publicly.
#: 8091 rather than the more common 8081, which collides on many dev machines.
DEFAULT_CONTROL_PORT = 8091


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        _log.warning("ignoring non-numeric value", extra={"var": name})
        return default


async def main() -> int:
    """Start the worker and the control app; return the process exit code."""
    configure_logging()
    load_repo_dotenv()
    settings = load_settings()

    concurrency = _int_env("WORKER_AI_CONCURRENCY", DEFAULT_CONCURRENCY)
    port = _int_env("WORKER_AI_PORT", DEFAULT_CONTROL_PORT)

    worker = Worker(
        AI_TRANSCRIBE_QUEUE,
        process_transcribe,
        {"connection": settings.redis_url, "concurrency": concurrency},
    )

    _log.info(
        f"worker-ai ready — waiting for jobs on {AI_TRANSCRIBE_QUEUE}",
        extra={
            "queue": AI_TRANSCRIBE_QUEUE,
            "concurrency": concurrency,
            "version": __version__,
            "llmProvider": settings.llm_provider,
            "gpuProvider": settings.gpu_provider,
            "asrProviderConfigured": settings.has_any_asr_provider,
            "controlPort": port,
        },
    )

    # uvicorn owns SIGINT/SIGTERM (it handles Windows and POSIX correctly); when
    # it returns we drain the worker so no in-flight job is orphaned.
    server = uvicorn.Server(
        uvicorn.Config(
            control_app,
            host="0.0.0.0",  # noqa: S104 - pod-internal; the service is not published
            port=port,
            log_config=None,
            access_log=False,
        )
    )
    try:
        await server.serve()
    finally:
        _log.info("shutting down", extra={"queue": AI_TRANSCRIBE_QUEUE})
        await worker.close()

    return 0


def run() -> None:
    """Console-script wrapper (`montaj-worker-ai`)."""
    raise SystemExit(asyncio.run(main()))


if __name__ == "__main__":
    run()
