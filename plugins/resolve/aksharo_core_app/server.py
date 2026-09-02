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

C09 addition: the Studio panel is an HTML/JS app hosted by Resolve's embedded
Chromium (no Node/`ws`), and the browser `WebSocket` constructor cannot set
an `Authorization` header on the handshake — only `bridge/client.py`
(a real Python `websockets` client) can. So the bearer may also arrive as a
`?token=` query parameter on the connection URL; this is strictly weaker
(it can end up in a browser history/devtools network log) but the whole
surface is loopback-only (127.0.0.1) and the token is scoped to this one
Resolve session (discovery file, mode 0600). Flagged in the C09 report as a
brief/threat-model deviation, not found elsewhere in this repo; the header
form remains preferred and is tried first.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import Server, ServerConnection, serve

from aksharo_core_app.discovery import LOOPBACK_PORT_RANGE
from aksharo_core_app.host.resolve import ResolveHost
from aksharo_core_app.session import SessionState

Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]] | dict[str, Any]]


@dataclass(slots=True)
class LoopbackServerConfig:
    bearer: str
    host: str = "127.0.0.1"
    ports: range = LOOPBACK_PORT_RANGE


@dataclass(slots=True)
class PanelDeps:
    """C09 Studio panel methods: `session.status`, `transcribe.start`,
    `passes.list`. Unlike `apply.*` (still wired in by the caller via
    `register`, since it owns the Resolve transaction state machine), these
    three never touch the Resolve object model — they proxy this script's
    own bridge session (`session.py`) and the cloud API
    (`transcribe.py`/`passes.py`) — so `LoopbackServer` wires them itself
    when a `PanelDeps` is supplied."""

    session: SessionState
    transcribe_start: Handler
    list_passes: Handler


class UnauthorizedError(Exception):
    pass


class MethodNotFoundError(Exception):
    pass


class LoopbackServer:
    """Dispatches `host.info`, `timeline.current`, `apply.*` JSON-RPC calls."""

    def __init__(
        self,
        config: LoopbackServerConfig,
        resolve_host: ResolveHost,
        panel_deps: PanelDeps | None = None,
    ) -> None:
        self._config = config
        self._resolve_host = resolve_host
        self._handlers: dict[str, Handler] = {
            "host.info": self._host_info,
            "timeline.current": self._timeline_current,
        }
        if panel_deps is not None:
            self._handlers["session.status"] = lambda _params: panel_deps.session.to_wire()
            self._handlers["transcribe.start"] = panel_deps.transcribe_start
            self._handlers["passes.list"] = panel_deps.list_passes
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

    def _query_token(self, connection: ServerConnection) -> str | None:
        if connection.request is None:
            return None
        query = parse_qs(urlsplit(connection.request.path).query)
        values = query.get("token")
        return values[0] if values else None

    async def _handle_connection(self, connection: ServerConnection) -> None:
        header = connection.request.headers.get("authorization", "") if connection.request else ""
        authorized = (
            header == f"Bearer {self._config.bearer}"
            or self._query_token(connection) == self._config.bearer
        )
        if not authorized:
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


__all__ = [
    "LoopbackServer",
    "LoopbackServerConfig",
    "MethodNotFoundError",
    "PanelDeps",
    "UnauthorizedError",
]
