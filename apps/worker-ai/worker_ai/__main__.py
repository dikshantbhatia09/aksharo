"""Entry point: the BullMQ consumers plus the FastAPI control app.

Run with::

    python -m worker_ai

One process runs one :class:`bullmq.Worker` per ``ai.*`` queue and one uvicorn
server for the control app. They share a process because the control app exists to
describe *this* worker — its queues, its providers, its routing state — and because
Kubernetes probes a pod, not a queue.

**Shutdown.** uvicorn owns SIGINT and SIGTERM (it handles Windows and POSIX
correctly). When it returns, the workers are drained: BullMQ stops taking new jobs
and waits for the in-flight ones, bounded, so a stuck job cannot hold the pod past
its termination grace period.
"""

from __future__ import annotations

import asyncio
from typing import Any

import uvicorn
from bullmq import Worker

from worker_ai import __version__
from worker_ai.control import create_app
from worker_ai.logging_setup import configure_logging, get_logger
from worker_ai.policies import heartbeat_interval_ms, worker_options
from worker_ai.runtime import build_services, close_services, drain, make_handler, queues_for
from worker_ai.settings import load_repo_dotenv, load_settings

__all__ = ["main", "run"]

_log = get_logger("worker_ai")


async def main() -> int:
    """Start the workers and the control app; return the process exit code."""
    configure_logging()
    load_repo_dotenv()
    settings = load_settings()

    services = build_services(settings)
    queues = queues_for(settings)

    # `list[Any]`, not `list[Worker]`: bullmq ships no type information and
    # `disallow_any_unimported` refuses a variable whose type comes from it.
    workers: list[Any] = [
        Worker(
            queue,
            make_handler(queue, services),
            # Lock, stall interval and max stalled count come from A08b's table
            # (`apps/api/src/jobs/jobs.config.ts`), mirrored in `policies.py` and
            # held there by a parity test.
            worker_options(
                queue,
                redis_url=settings.redis_url,
                # `ai.faces` is background preparation (CPU decode + ONNX):
                # one at a time, so a backfill never crowds out transcription.
                concurrency=1 if queue == "ai.faces" else settings.concurrency,
                prefix=settings.queue_prefix,
            ),
        )
        for queue in queues
    ]

    _log.info(
        "worker-ai ready",
        extra={
            "queues": list(queues),
            "concurrency": settings.concurrency,
            "prefix": settings.queue_prefix,
            "version": __version__,
            "vad": services.vad.name,
            "heartbeatMs": {queue: heartbeat_interval_ms(queue) for queue in queues},
            "routing": services.routing.source,
            "providers": [row.name for row in services.providers.describe() if row.enabled],
            "controlPort": settings.control_port,
        },
    )

    server = uvicorn.Server(
        uvicorn.Config(
            create_app(
                settings,
                providers=services.providers,
                routing=services.routing,
                vad_name=services.vad.name,
            ),
            host="0.0.0.0",  # noqa: S104 - pod-internal; the service is not published
            port=settings.control_port,
            log_config=None,
            access_log=False,
        )
    )
    try:
        await server.serve()
    finally:
        _log.info("draining", extra={"queues": list(queues)})
        await drain(workers)
        await close_services(services)

    return 0


def run() -> None:
    """Console-script wrapper (``montaj-worker-ai``)."""
    raise SystemExit(asyncio.run(main()))


if __name__ == "__main__":
    run()
