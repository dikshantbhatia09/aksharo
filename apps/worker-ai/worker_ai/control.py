"""FastAPI control app.

Small on purpose: the worker's real work arrives over BullMQ, and this app exists
so Kubernetes can probe the pod and so A09 can expose model-cache and routing
introspection. It is bound to the pod network only and must never be exposed
publicly.
"""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from worker_ai import __version__
from worker_ai.queues import AI_TRANSCRIBE_QUEUE

__all__ = ["HealthResponse", "create_app"]


class HealthResponse(BaseModel):
    """Body of ``GET /health``, matching the API's shape."""

    status: Literal["ok"]
    version: str
    queues: list[str]


def create_app() -> FastAPI:
    """Build the control app."""
    app = FastAPI(
        title="Aksharo AI worker control",
        version=__version__,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    @app.get("/health", response_model=HealthResponse, tags=["health"])
    async def health() -> HealthResponse:
        """Liveness probe. Deliberately does not touch Redis."""
        return HealthResponse(
            status="ok",
            version=__version__,
            queues=[AI_TRANSCRIBE_QUEUE],
        )

    return app


app = create_app()
