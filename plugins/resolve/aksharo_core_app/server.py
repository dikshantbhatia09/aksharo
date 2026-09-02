"""In-Resolve loopback server (brief §1): starts on 47841-47843, exposes
`host.info`, `timeline.current`, `apply.*` over JSON-RPC/WebSocket, bearer
token from the discovery file. No Tk status window (out of scope); status
goes to the Resolve console (`console.py`) and to the bridge via
`apply.progress` events.

T11 mitigation (docs/THREAT-MODEL.md): every route requires the bearer token
from the discovery file; `Origin` is not checked here directly because this
server is consumed only by this process's own bridge client and, later, C09's
docked panel — both loopback, first-party callers — but the same bearer gate
that protects the desktop bridge is applied uniformly.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from websockets.asyncio.server import Server, ServerConnection, serve

from aksharo_core_app.discovery import LOOPBACK_PORT_RANGE
from aksharo_core_app.host.resolve import ResolveHost

Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]] | dict[str, Any]]


@dataclass(slots=True)
class LoopbackServerConfig:
    bearer: str
    host: str = "127.0.0.1"
    ports: range = LOOPBACK_PORT_RANGE


class UnauthorizedError(Exception):
    pass


class MethodNotFoundError(Exception):
    pass


class LoopbackServer:
    """Dispatches `host.info`, `timeline.current`, `apply.*` JSON-RPC calls."""

    def __init__(self, config: LoopbackServerConfig, resolve_host: ResolveHost) -> None:
        self._config = config
        self._resolve_host = resolve_host
        self._handlers: dict[str, Handler] = {
            "host.info": self._host_info,
            "timeline.current": self._timeline_current,
        }
        self._server: Server | None = None
        self.bound_port: int | None = None

    def register(self, method: str, handler: Handler) -> None:
        """Lets `apply.begin`/`apply.step`/`apply.commit`/`apply.abort` be wired
        in by the caller, which owns the transaction state machine."""
        self._handlers[method] = handler

    async def _host_info(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "hostApp": "resolve",
            "connected": self._resolve_host.current_timeline() is not None,
        }

    async def _timeline_current(self, _params: dict[str, Any]) -> dict[str, Any]:
        timeline = self._resolve_host.current_timeline()
        if timeline is None:
            return {"timeline": None}
        return {"timeline": {"name": timeline.name, "fps": timeline.fps}}

    async def _dispatch(self, raw_message: str) -> str:
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            return json.dumps(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
            )
        method = message.get("method")
        request_id = message.get("id")
        handler = self._handlers.get(method)
        if handler is None:
            return json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": f"method not found: {method}"},
                }
            )
        try:
            result = handler(message.get("params", {}) or {})
            if hasattr(result, "__await__"):
                result = await result
        except Exception as exc:
            return json.dumps(
                {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": str(exc)}}
            )
        return json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result})

    async def _handle_connection(self, connection: ServerConnection) -> None:
        header = connection.request.headers.get("authorization", "") if connection.request else ""
        if header != f"Bearer {self._config.bearer}":
            await connection.close(code=4401, reason="unauthorized")
            return
        async for raw_message in connection:
            text = raw_message if isinstance(raw_message, str) else raw_message.decode("utf-8")
            await connection.send(await self._dispatch(text))

    async def start(self) -> int:
        """Binds the first free port in 47841-47843 and returns it."""
        last_error: Exception | None = None
        for port in self._config.ports:
            try:
                self._server = await serve(self._handle_connection, self._config.host, port)
                self.bound_port = port
                return port
            except OSError as exc:  # port already in use
                last_error = exc
                continue
        raise RuntimeError(
            f"no free loopback port in {self._config.ports.start}-{self._config.ports.stop - 1}"
        ) from last_error

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None


__all__ = ["LoopbackServer", "LoopbackServerConfig", "MethodNotFoundError", "UnauthorizedError"]
