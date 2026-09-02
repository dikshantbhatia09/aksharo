"""RunPod serverless queue handler over the same app, batcher and warm models.

RunPod's classic serverless API is a queue, not an HTTP server: the platform hands
the worker ``{"input": {...}}`` and expects a JSON result back. Modal, and RunPod's
load-balancing endpoints, take the HTTP app instead. Both lanes must behave
identically, so this module does **not** re-implement anything — it builds the
same :class:`~model_server.app.create_app` application, runs its lifespan (which
is what loads the models and starts the batcher), and dispatches to the same
:class:`~model_server.service.ModelService`.

``MODEL_SERVER_MODE`` in the image picks the lane: ``http`` (the default) runs
uvicorn, ``runpod`` runs this.

## The event shape

```json
{ "input": { "route": "/transcribe", "body": { "audio": "https://…", "language": "hi" } } }
```

``route`` accepts the path with or without its leading slash. A body sent flat —
``{"input": {"audio": "…"}}`` with no ``route`` — is treated as ``/transcribe``,
because that is the only route with enough traffic to be worth the shorthand.

## Auth

RunPod authenticates the caller at the endpoint with its own API key, which is why
``input.token`` is **not** required by default. Set
``MODEL_SERVER_RUNPOD_REQUIRE_TOKEN=1`` to demand ``GPU_PROVIDER_TOKEN`` in the
event as well, so a leaked endpoint key alone is not enough to spend the GPU.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import sys
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from model_server.app import create_app
from model_server.errors import ModelServerError, UnauthorizedError
from model_server.logging_setup import configure_logging, get_logger
from model_server.models.registry import ModelRegistry
from model_server.schemas import (
    AlignRequest,
    DetectLanguageRequest,
    DiariseRequest,
    TranscribeRequest,
)
from model_server.settings import ConfigurationError, Settings

__all__ = ["RunPodWorker", "main"]

_log = get_logger(__name__)

_ROUTES: dict[str, type[BaseModel]] = {
    "transcribe": TranscribeRequest,
    "align": AlignRequest,
    "diarise": DiariseRequest,
    "detect-language": DetectLanguageRequest,
}


class RunPodWorker:
    """Holds the app and its lifespan for the life of the RunPod worker process."""

    def __init__(
        self, settings: Settings | None = None, *, registry: ModelRegistry | None = None
    ) -> None:
        self.settings = settings or Settings.from_env()
        self.app: FastAPI = create_app(self.settings, registry=registry)
        self._lifespan: Any = None

    async def start(self) -> None:
        """Run the app's startup: loads the models, starts the batch consumer."""
        self._lifespan = self.app.router.lifespan_context(self.app)
        await self._lifespan.__aenter__()

    async def stop(self) -> None:
        """Run the app's shutdown: drains the batcher, unloads the models."""
        if self._lifespan is not None:
            await self._lifespan.__aexit__(None, None, None)
            self._lifespan = None

    def _authorise(self, payload: dict[str, Any]) -> None:
        if not self.settings.runpod_require_token:
            return
        supplied = str(payload.get("token") or "")
        if not supplied or not hmac.compare_digest(supplied, self.settings.token):
            raise UnauthorizedError(
                "MODEL_SERVER_RUNPOD_REQUIRE_TOKEN is set, so the event must carry "
                "the GPU_PROVIDER_TOKEN in input.token"
            )

    async def handle(self, event: dict[str, Any]) -> dict[str, Any]:
        """One RunPod event to one JSON result."""
        payload = event.get("input")
        if not isinstance(payload, dict):
            return _failure("model-server/invalid-request", "the event carried no input object")

        route = str(payload.get("route") or payload.get("endpoint") or "transcribe").strip("/")
        model = _ROUTES.get(route)
        if model is None:
            return _failure(
                "model-server/unknown-route",
                "no route named " + route + "; expected one of " + ", ".join(_ROUTES),
            )

        body = payload.get("body")
        if not isinstance(body, dict):
            body = {
                key: value
                for key, value in payload.items()
                if key not in {"route", "endpoint", "token"}
            }

        service = self.app.state.service
        try:
            self._authorise(payload)
            request = model.model_validate(body)
            handler = getattr(service, route.replace("-", "_"))
            response: BaseModel = await handler(request)
        except ModelServerError as error:
            return _failure(error.code, error.message, retry_after_s=error.retry_after_s)
        except ValueError as error:
            return _failure("model-server/invalid-request", str(error))
        return {"output": response.model_dump(mode="json")}


def _failure(code: str, message: str, *, retry_after_s: int | None = None) -> dict[str, Any]:
    """RunPod surfaces ``error`` to the caller; the envelope mirrors CONTRACTS section 8."""
    body: dict[str, Any] = {"code": code, "message": message}
    if retry_after_s is not None:
        body["retryAfterSeconds"] = retry_after_s
    return {"error": body}


def main() -> int:
    """Boot the worker and hand ``handler`` to the RunPod SDK.

    The SDK is not a dependency of this app: it exists only inside the RunPod
    image, and importing it on a laptop would fail for no reason. A missing SDK
    here is a configuration error with a readable message, not a traceback.
    """
    try:
        settings = Settings.from_env()
    except ConfigurationError as error:
        configure_logging("model-server")
        _log.error("configuration is not servable", extra={"reason": str(error)})
        return 2

    worker = RunPodWorker(settings)
    loop = asyncio.new_event_loop()
    loop.run_until_complete(worker.start())

    async def handler(event: dict[str, Any]) -> dict[str, Any]:
        return await worker.handle(event)

    try:
        import runpod
    except ImportError:
        _log.error(
            "the runpod SDK is not installed in this image; "
            "install it in the runtime stage or run MODEL_SERVER_MODE=http"
        )
        loop.run_until_complete(worker.stop())
        return 2

    _log.info("runpod worker ready", extra={"pid": os.getpid()})
    runpod.serverless.start({"handler": handler})
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry point
    sys.exit(main())
