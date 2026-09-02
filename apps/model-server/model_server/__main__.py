"""``python -m model_server`` — uvicorn, plus an early SIGTERM drain.

Why the signal handler exists when uvicorn already has one: uvicorn's graceful
shutdown begins by refusing *new connections*, and only then runs the lifespan's
shutdown. On a serverless worker behind a load balancer, that window is long
enough to route a request to a worker that is about to stop; the balancer only
stops sending when readiness turns false. So this handler flips the drain flag —
which makes ``/readyz`` return 503 immediately — and then lets uvicorn's own
handler run the ordinary shutdown. In-flight work finishes; new work goes
elsewhere.
"""

from __future__ import annotations

import signal
import sys
from typing import Any

import uvicorn

from model_server.app import create_app
from model_server.logging_setup import configure_logging, get_logger
from model_server.settings import ConfigurationError, Settings

__all__ = ["run"]

_log = get_logger(__name__)


def _install_drain_handler(app: Any) -> None:
    """Turn readiness off the moment SIGTERM lands, before uvicorn winds down."""
    previous = signal.getsignal(signal.SIGTERM)

    def handler(signum: int, frame: Any) -> None:
        service = getattr(app.state, "service", None)
        if service is not None:
            service.draining = True
            app.state.metrics.draining.set(1.0)
        _log.info("SIGTERM received; readiness is off, finishing in-flight work")
        if callable(previous):
            previous(signum, frame)

    try:
        signal.signal(signal.SIGTERM, handler)
    except (ValueError, OSError):  # pragma: no cover - not the main thread
        _log.warning("could not install the SIGTERM drain handler")


def run() -> int:
    """Entry point for ``montaj-model-server`` and ``python -m model_server``."""
    try:
        settings = Settings.from_env()
    except ConfigurationError as error:
        configure_logging("model-server")
        _log.error("configuration is not servable", extra={"reason": str(error)})
        return 2

    app = create_app(settings)
    _install_drain_handler(app)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_config=None,
        access_log=False,
        timeout_graceful_shutdown=int(settings.drain_timeout_s),
    )
    return 0


if __name__ == "__main__":
    sys.exit(run())
