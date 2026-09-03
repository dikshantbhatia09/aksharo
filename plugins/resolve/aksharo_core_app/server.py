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

C09 addition, replaced by C02c (2026-09-03): the Studio panel is an HTML/JS
app hosted by Resolve's embedded Chromium (no Node/`ws`), and the browser
`WebSocket` constructor cannot set an `Authorization` header on the
handshake — only `bridge/client.py` (a real Python `websockets` client) can.
C09 worked around this with a `?token=` query-parameter bearer fallback,
flagged in its own report as a deviation (the long-lived bearer could end up
in browser history/devtools). X01's audit
(docs/security/threat-model-audit-2026-09-03.md, T11) recommended replacing
it with a one-time ticket exchange; this is that replacement.

`?token=` is gone. Instead: `session.ws_ticket_endpoint()` (a plain HTTP
request to this same loopback port, intercepted by `_process_request` before
the WebSocket handshake) accepts an `Authorization: Bearer <token>` header —
unlike the `WebSocket` constructor, the panel's own `fetch()` *can* set that
header — and returns a 30-second, single-use ticket. The panel then opens its
WebSocket with `?ticket=<ticket>`; `_handle_connection` consumes it exactly
once. A leaked ticket (browser history, devtools network log — the same
exposure `?token=` had) is worthless after its first use or after 30 seconds,
where a leaked `?token=` was the long-lived discovery-file bearer itself.

Deviation from the brief's literal "`POST` /session/ws-ticket": the
`websockets` library's opening-handshake parser
(`websockets.http11.Request.parse`) hard-rejects any request whose method
isn't `GET` or that carries a body (`Content-Length` at all) before
`process_request` ever runs — the same constraint that forced C09's `?token=`
fallback in the first place, one layer lower. A bodyless `GET` with an
`Authorization` header parses like any other opening handshake and reaches
`process_request` normally, so the ticket endpoint is `GET`, still
header-authenticated, still on this one port — no second listener, no
discovery-file schema change (out of this WP's file boundary). Documented
here rather than silently done; see the WP report for the full reasoning.
"""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from aksharo_core_app.discovery import LOOPBACK_PORT_RANGE
from aksharo_core_app.host.resolve import ResolveHost
from aksharo_core_app.session import SessionState

WS_TICKET_PATH = "/session/ws-ticket"
WS_TICKET_TTL_SECONDS = 30.0

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
        # ticket -> monotonic expiry; popped on first use (single-use) or once
        # expired (pruned opportunistically, both on issue and on redemption).
        self._tickets: dict[str, float] = {}

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

    @staticmethod
    def _json_response(status: HTTPStatus, payload: dict[str, Any]) -> Response:
        body = json.dumps(payload).encode("utf-8")
        headers = Headers(
            [
                ("Connection", "close"),
                ("Content-Length", str(len(body))),
                ("Content-Type", "application/json"),
            ]
        )
        return Response(status.value, status.phrase, headers, body)

    def _prune_expired_tickets(self, now: float) -> None:
        expired = [ticket for ticket, expires_at in self._tickets.items() if expires_at <= now]
        for ticket in expired:
            del self._tickets[ticket]

    def _issue_ws_ticket(self, request: Request) -> Response:
        header = request.headers.get("authorization", "")
        if header != f"Bearer {self._config.bearer}":
            return self._json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        now = time.monotonic()
        self._prune_expired_tickets(now)
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = now + WS_TICKET_TTL_SECONDS
        return self._json_response(
            HTTPStatus.OK, {"ticket": ticket, "expiresInMs": int(WS_TICKET_TTL_SECONDS * 1000)}
        )

    def _process_request(self, connection: ServerConnection, request: Request) -> Response | None:
        """`websockets`' opening-handshake hook: a bodyless `GET` to
        `WS_TICKET_PATH` is answered directly (never becomes a WebSocket
        connection); anything else proceeds to the normal handshake in
        `_handle_connection`. See the module docstring for why this is `GET`
        rather than the brief's literal `POST`."""
        if urlsplit(request.path).path == WS_TICKET_PATH:
            return self._issue_ws_ticket(request)
        return None

    def _consume_ws_ticket(self, connection: ServerConnection) -> bool:
        """Pops and validates the `?ticket=` on the connection URL. Popping
        unconditionally (found-but-expired included) is what makes it
        single-use: a replay of the same ticket always finds nothing."""
        if connection.request is None:
            return False
        query = parse_qs(urlsplit(connection.request.path).query)
        values = query.get("ticket")
        if not values:
            return False
        expires_at = self._tickets.pop(values[0], None)
        return expires_at is not None and expires_at > time.monotonic()

    async def _handle_connection(self, connection: ServerConnection) -> None:
        header = connection.request.headers.get("authorization", "") if connection.request else ""
        authorized = header == f"Bearer {self._config.bearer}" or self._consume_ws_ticket(
            connection
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
                self._server = await serve(
                    self._handle_connection,
                    self._config.host,
                    port,
                    process_request=self._process_request,
                )
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
    "WS_TICKET_PATH",
    "WS_TICKET_TTL_SECONDS",
    "LoopbackServer",
    "LoopbackServerConfig",
    "MethodNotFoundError",
    "PanelDeps",
    "UnauthorizedError",
]
