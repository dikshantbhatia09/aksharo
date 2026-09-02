"""The FastAPI application: auth, limits, metrics, health and the four routes.

## Order of the gates

A request passes, in this order: **size limit → draining check → auth →
validation → readiness → memory guard → model**. The order is the point. Auth
before validation means a bad token never reveals which fields a body was missing;
the size limit before auth means an unauthenticated 4 GB body is dropped without
being buffered; the memory guard last means a request is only refused for
capacity after everything cheaper has already accepted it.

## Health versus readiness

``/healthz`` answers from a static fact — the process is up — and touches no
model, so a worker mid-load is *alive* and does not get killed by a liveness
probe while its 3 GB of weights page in. ``/readyz`` is false until every backend
in ``MODEL_SERVER_PRELOAD`` is resident, and false again the instant SIGTERM
arrives, which is what takes a draining worker out of rotation before it starts
refusing.

## One implementation, two lanes

The route functions here are shells: they authenticate, validate, and hand the
request to ``model_server.service.ModelService``. ``runpod_handler.py`` calls the
same service object on the same app — so the HTTP lane (Modal, RunPod
load-balancing endpoints, local development) and the RunPod queue lane share one
batcher, one memory guard and one set of warm models rather than two
implementations of one contract.

## Metrics

``/metrics`` is unauthenticated on purpose: it carries no user data (the
cardinality rules in ``infra/observability/METRICS.md`` forbid every id that
could), and a scrape config that has to carry a bearer token is a scrape config
that silently stops working when the token rotates.
"""

from __future__ import annotations

import hmac
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware

from model_server.errors import (
    ModelServerError,
    PayloadTooLargeError,
    UnauthorizedError,
    error_body,
)
from model_server.logging_setup import configure_logging, get_logger
from model_server.metrics import Metrics
from model_server.models.registry import ModelRegistry
from model_server.schemas import (
    AlignRequest,
    AlignResponse,
    DetectLanguageRequest,
    DetectLanguageResponse,
    DiariseRequest,
    DiariseResponse,
    TranscribeRequest,
    TranscribeResponse,
)
from model_server.service import ModelService, new_request_id
from model_server.settings import Settings

__all__ = ["create_app"]

_log = get_logger(__name__)

#: Routes that need the bearer token. Health and metrics do not.
MODEL_ROUTES = ("/transcribe", "/align", "/diarise", "/detect-language")

_REQUEST_ID_HEADER = "x-request-id"


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _bearer(header: str) -> str:
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.strip().casefold() == "bearer" else ""


def require_token(request: Request) -> None:
    """Compare the bearer token in constant time, or refuse.

    Constant time because a token compared with ``==`` leaks its prefix to anyone
    willing to time the answer, and this token is the only thing between the
    internet and a GPU (THREAT-MODEL T21).
    """
    settings: Settings = request.app.state.settings
    metrics: Metrics = request.app.state.metrics
    if not settings.token:
        # Settings refuses to construct this state unless a human set
        # MODEL_SERVER_ALLOW_ANONYMOUS, so reaching here is intentional.
        return
    supplied = _bearer(request.headers.get("authorization", ""))
    if not supplied or not hmac.compare_digest(supplied, settings.token):
        metrics.rejected.labels(reason="auth").inc()
        raise UnauthorizedError("a valid GPU_PROVIDER_TOKEN bearer token is required")


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


class BodyLimitMiddleware(BaseHTTPMiddleware):
    """Refuse an oversized body before anything buffers it."""

    def __init__(self, app: Any, *, max_bytes: int, metrics: Metrics) -> None:
        super().__init__(app)
        self.max_bytes = max_bytes
        self.metrics = metrics

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > self.max_bytes:
            self.metrics.rejected.labels(reason="payload_too_large").inc()
            error = PayloadTooLargeError(
                "the request body is "
                + declared
                + " bytes; the limit is "
                + str(self.max_bytes)
                + ". Send the audio as an https URL rather than inline."
            )
            return JSONResponse(
                status_code=error.status_code,
                content=error_body(error, request.headers.get(_REQUEST_ID_HEADER, "")),
            )
        return await call_next(request)


class ObservabilityMiddleware(BaseHTTPMiddleware):
    """A request id, the duration histogram, the in-flight gauge and one log line."""

    def __init__(self, app: Any, *, metrics: Metrics) -> None:
        super().__init__(app)
        self.metrics = metrics

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get(_REQUEST_ID_HEADER) or new_request_id()
        request.state.request_id = request_id
        route = request.url.path
        tracked = route in MODEL_ROUTES
        if tracked:
            self.metrics.inflight.labels(route=route).inc()
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            if tracked:
                self.metrics.inflight.labels(route=route).dec()
        elapsed = time.perf_counter() - started
        response.headers[_REQUEST_ID_HEADER] = request_id
        if tracked:
            status = str(response.status_code)
            self.metrics.requests.labels(route=route, status=status).inc()
            self.metrics.request_duration.labels(route=route, status=status).observe(elapsed)
            _log.info(
                "request served",
                extra={
                    "route": route,
                    "status": response.status_code,
                    "durationMs": round(elapsed * 1000, 1),
                    "requestId": request_id,
                },
            )
        return response


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def _service(request: Request) -> ModelService:
    service: ModelService = request.app.state.service
    return service


#: The one place ``Depends`` is called, so no route has a call in a default argument.
Service = Annotated[ModelService, Depends(_service)]


def build_router() -> APIRouter:
    """The four model routes. Every one of them requires the bearer token."""
    router = APIRouter(dependencies=[Depends(require_token)])

    @router.post("/transcribe", response_model=TranscribeResponse)
    async def transcribe(body: TranscribeRequest, service: Service) -> TranscribeResponse:
        return await service.transcribe(body)

    @router.post("/align", response_model=AlignResponse)
    async def align(body: AlignRequest, service: Service) -> AlignResponse:
        return await service.align(body)

    @router.post("/diarise", response_model=DiariseResponse)
    async def diarise(body: DiariseRequest, service: Service) -> DiariseResponse:
        return await service.diarise(body)

    @router.post("/detect-language", response_model=DetectLanguageResponse)
    async def detect_language(
        body: DetectLanguageRequest, service: Service
    ) -> DetectLanguageResponse:
        return await service.detect_language(body)

    return router


def build_health_router() -> APIRouter:
    """Liveness, readiness and the Prometheus scrape. None of them authenticated."""
    router = APIRouter()

    @router.get("/healthz")
    async def healthz() -> dict[str, str]:
        """Alive. Deliberately touches no model: a loading worker is not a dead one."""
        return {"status": "ok"}

    @router.get("/readyz")
    async def readyz(request: Request, service: Service) -> Response:
        """Ready only when every preloaded model is resident and we are not draining."""
        payload = service.status()
        ready = bool(payload.get("ready")) and not service.draining
        payload["ready"] = ready
        if not ready and not service.draining:
            payload["reason"] = service.registry.not_ready_reason()
        del request
        return JSONResponse(status_code=200 if ready else 503, content=payload)

    @router.get("/metrics")
    async def metrics(request: Request) -> Response:
        registry = request.app.state.metrics.registry
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    return router


# ---------------------------------------------------------------------------
# The app
# ---------------------------------------------------------------------------


def create_app(
    settings: Settings | None = None,
    *,
    registry: ModelRegistry | None = None,
    metrics: Metrics | None = None,
    configure_logs: bool = True,
) -> FastAPI:
    """Build the app. ``registry`` is injectable so tests can hand it fakes."""
    resolved = settings or Settings.from_env()
    if configure_logs:
        configure_logging("model-server", resolved.log_level)
    resolved_metrics = metrics or Metrics.create()
    resolved_registry = registry or ModelRegistry.from_settings(resolved)
    resolved_registry.required = resolved.preload

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        _log.info("model server starting", extra=resolved.redacted())
        resolved_metrics.draining.set(0.0)
        # Loading blocks: the whole point is that no request is accepted until the
        # weights are resident, so this is not moved off the event loop.
        resolved_registry.load(device=resolved.device, metrics=resolved_metrics)
        service: ModelService = app.state.service
        service.start()
        _log.info("model server ready", extra={"ready": resolved_registry.ready()})
        try:
            yield
        finally:
            _log.info("model server draining")
            await service.aclose()
            resolved_metrics.draining.set(1.0)

    app = FastAPI(
        title="Aksharo model server",
        version="0.1.0",
        summary="Transcription, forced alignment, diarisation and language ID on one GPU.",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/openapi.json",
    )
    app.state.settings = resolved
    app.state.metrics = resolved_metrics
    app.state.registry = resolved_registry
    app.state.service = ModelService(resolved, resolved_registry, resolved_metrics)

    app.add_middleware(ObservabilityMiddleware, metrics=resolved_metrics)
    app.add_middleware(
        BodyLimitMiddleware, max_bytes=resolved.max_body_bytes, metrics=resolved_metrics
    )

    app.include_router(build_health_router())
    app.include_router(build_router())

    @app.exception_handler(ModelServerError)
    async def _model_server_error(request: Request, error: Exception) -> Response:
        assert isinstance(error, ModelServerError)  # noqa: S101 - the handler's own contract
        request_id = getattr(request.state, "request_id", "")
        if error.status_code == 503:
            reason = "draining" if "draining" in error.message else "memory_guard"
            if error.code == "model-server/model-unavailable":
                reason = "not_ready"
            resolved_metrics.rejected.labels(reason=reason).inc()
        elif error.code == "model-server/bad-audio":
            resolved_metrics.rejected.labels(reason="audio_too_long").inc()
        _log.warning(
            "request refused",
            extra={
                "route": request.url.path,
                "code": error.code,
                "status": error.status_code,
                "requestId": request_id,
            },
        )
        return JSONResponse(
            status_code=error.status_code,
            content=error_body(error, request_id),
            headers=error.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, error: Exception) -> Response:
        """422 in the CONTRACTS section 8 envelope, without echoing the body back."""
        del error
        request_id = getattr(request.state, "request_id", "")
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "model-server/invalid-request",
                    "message": "the request body does not match this route's schema",
                    "requestId": request_id,
                }
            },
        )

    @app.get("/", include_in_schema=False)
    async def root() -> PlainTextResponse:
        return PlainTextResponse("Aksharo model server\n")

    return app
