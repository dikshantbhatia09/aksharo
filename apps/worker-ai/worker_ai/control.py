"""FastAPI control app: probes and introspection for one worker pod.

Small on purpose — the worker's real work arrives over BullMQ. This app exists so
Kubernetes can probe the pod and so an operator can answer "why is this pod
routing to the mock?" without a redeploy.

It is bound to the pod network only and **must never be exposed publicly**: it has
no authentication, because inside the cluster the only caller is the kubelet.

| Route            | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| `GET /health`    | liveness; deliberately touches neither Redis nor a model      |
| `GET /providers` | every adapter with its enable flag, plus routing and aligners |
| `GET /metrics`   | Prometheus counters per provider, language and lane (`09 §1`) |
| `POST /evals/run`| stub; the eval harness runs from the CLI                      |
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import FastAPI, Response, status
from pydantic import BaseModel, Field

from worker_ai import __version__
from worker_ai.alignment import AlignerRegistry
from worker_ai.cache import NullResultCache, ResultCache
from worker_ai.diarisation import DiariserRegistry
from worker_ai.evals.manifest import available_sets
from worker_ai.lid import CODE_MIX_THRESHOLD, IndicLidClassifier
from worker_ai.metrics import METRICS
from worker_ai.providers.registry import ProviderRegistry, build_registry
from worker_ai.queues import IMPLEMENTED_AI_QUEUES
from worker_ai.routing import RoutingTable, load_routing_table
from worker_ai.runtime import build_routing_table, queues_for
from worker_ai.settings import Settings

__all__ = [
    "EvalRunRequest",
    "EvalRunResponse",
    "HealthResponse",
    "ProvidersResponse",
    "create_app",
]


class HealthResponse(BaseModel):
    """Body of ``GET /health``, matching the API's shape."""

    status: Literal["ok"]
    version: str
    queues: list[str]
    implemented: list[str]


class ProvidersResponse(BaseModel):
    """Body of ``GET /providers``: what this pod can actually do."""

    providers: list[dict[str, Any]]
    routing: dict[str, Any]
    aligners: list[dict[str, Any]]
    diarisers: list[dict[str, Any]]
    vad: dict[str, Any]
    lid: dict[str, Any]
    cache: dict[str, Any]
    metrics: dict[str, Any]


class EvalRunRequest(BaseModel):
    """Body of ``POST /evals/run``."""

    set: str = Field(min_length=1, description="An eval set under `fixtures/`.")
    provider: str = "mock"


class EvalRunResponse(BaseModel):
    """Stub reply: A09 ships the harness as a CLI, not as a background service."""

    status: Literal["not_implemented"]
    detail: str
    command: str
    availableSets: list[str]  # noqa: N815 - the wire is camelCase


def create_app(
    settings: Settings | None = None,
    *,
    providers: ProviderRegistry | None = None,
    routing: RoutingTable | None = None,
    aligners: AlignerRegistry | None = None,
    diarisers: DiariserRegistry | None = None,
    cache: ResultCache | None = None,
    vad_name: str = "unknown",
) -> FastAPI:
    """Build the control app.

    Every collaborator is injectable so a test can describe a pod that has, say,
    ElevenLabs configured, without touching the process environment.
    """
    app = FastAPI(
        title="Aksharo AI worker control",
        version=__version__,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    registry = (
        providers
        if providers is not None
        else (build_registry(settings) if settings is not None else None)
    )
    table = routing
    if table is None:
        table = build_routing_table(settings) if settings is not None else load_routing_table()
    aligner_registry = aligners or (
        AlignerRegistry.from_settings(settings)
        if settings is not None
        else AlignerRegistry.default()
    )
    diariser_registry = diarisers or (
        DiariserRegistry.from_settings(settings)
        if settings is not None
        else DiariserRegistry.default()
    )
    result_cache = cache or NullResultCache()
    classifier = IndicLidClassifier(settings.indiclid_dir if settings is not None else "")
    consumed = list(queues_for(settings)) if settings is not None else list(IMPLEMENTED_AI_QUEUES)

    @app.get("/health", response_model=HealthResponse, tags=["health"])
    async def health() -> HealthResponse:
        """Liveness probe. Deliberately does not touch Redis."""
        return HealthResponse(
            status="ok",
            version=__version__,
            queues=consumed,
            implemented=list(IMPLEMENTED_AI_QUEUES),
        )

    @app.get("/providers", response_model=ProvidersResponse, tags=["control"])
    async def list_providers() -> ProvidersResponse:
        """Every adapter and why it is or is not enabled here."""
        rows = [status_row.to_wire() for status_row in registry.describe()] if registry else []
        return ProvidersResponse(
            providers=rows,
            routing=table.to_wire(),
            aligners=[dict(item) for item in aligner_registry.describe()],
            diarisers=[dict(item) for item in diariser_registry.describe()],
            vad={"backend": vad_name},
            lid={
                "textClassifier": classifier.name,
                "backend": classifier.backend,
                "codeMixThreshold": CODE_MIX_THRESHOLD,
            },
            cache=result_cache.describe(),
            metrics=METRICS.snapshot(),
        )

    @app.get("/metrics", tags=["control"], response_class=Response)
    async def metrics() -> Response:
        """Prometheus text exposition: per provider, language and lane (`09 §1`)."""
        return Response(
            content=METRICS.render(),
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    @app.post(
        "/evals/run",
        response_model=EvalRunResponse,
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        tags=["control"],
    )
    async def run_evals(request: EvalRunRequest) -> EvalRunResponse:
        """Stub. The regression harness runs from the CLI until A10 schedules it."""
        return EvalRunResponse(
            status="not_implemented",
            detail=(
                "A09 ships the eval harness as a CLI; running it from the control "
                "app arrives with the nightly regression harness (`09 §8`)."
            ),
            command=(
                f"python -m worker_ai.evals run --set {request.set} --provider {request.provider}"
            ),
            availableSets=list(available_sets()),
        )

    return app


app = create_app()
