"""Bridge client: pairs with the local bridge (or the relay through the API
when no bridge is running) using the C01 protocol, over `websockets`.

Talks JSON-RPC 2.0 (`protocol.py`) to whichever transport is reachable:
1. loopback bridge (`wss://127.0.0.1:<port>/ws`, discovery file per C01) — tried
   first;
2. relay through the API (`bridge-relay`) when no loopback bridge answers —
   the "relay-first transport" T11 mitigation applies to the bridge itself,
   not this client, which simply falls back to whichever endpoint it is given.

Reconnects with exponential backoff and sends a `hello` heartbeat on an
interval so the bridge's `apply.progress`/`host.changed` events keep flowing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from aksharo_core_app.bridge.protocol import (
    BRIDGE_PROTOCOL_VERSION,
    HelloParams,
    JsonRpcRequest,
    JsonRpcResponse,
)

DEFAULT_MIN_BACKOFF_S = 1.0
DEFAULT_MAX_BACKOFF_S = 30.0
HEARTBEAT_INTERVAL_S = 20.0


@dataclass(slots=True)
class BridgeClientConfig:
    url: str
    bearer: str
    capabilities: list[str] = field(default_factory=lambda: ["captions", "cuts", "zooms"])
    min_backoff_s: float = DEFAULT_MIN_BACKOFF_S
    max_backoff_s: float = DEFAULT_MAX_BACKOFF_S
    heartbeat_interval_s: float = HEARTBEAT_INTERVAL_S


class BridgeClient:
    """A minimal JSON-RPC 2.0 request/response client over one WS connection.

    One call at a time (`call`) — this script issues apply-transaction and
    transcript-push calls sequentially, so no request multiplexing is needed.
    A background task answers/ignores server->client notifications
    (`event`, method with no `id`) via `on_notification`.
    """

    def __init__(
        self,
        config: BridgeClientConfig,
        on_notification: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._config = config
        self._on_notification = on_notification
        self._connection: ClientConnection | None = None
        self._next_id = 0
        self._last_heartbeat = 0.0

    async def connect(self) -> None:
        """Connect and run the C01 `hello` handshake once."""
        self._connection = await websockets.connect(
            self._config.url,
            additional_headers={"authorization": f"Bearer {self._config.bearer}"},
        )
        await self.call(
            "hello",
            HelloParams(
                bridge_version=BRIDGE_PROTOCOL_VERSION,
                capabilities=self._config.capabilities,
                host_apps=["resolve"],
            ).to_wire(),
        )
        self._last_heartbeat = time.monotonic()

    async def close(self) -> None:
        if self._connection is not None:
            await self._connection.close()
            self._connection = None

    async def call(self, method: str, params: dict[str, Any]) -> Any:
        if self._connection is None:
            raise RuntimeError("BridgeClient.call: not connected")
        self._next_id += 1
        request = JsonRpcRequest(method=method, params=params, id=self._next_id)
        await self._connection.send(request.dumps())
        while True:
            raw = await self._connection.recv()
            message = json.loads(raw)
            if message.get("id") is None and message.get("method") == "event":
                if self._on_notification is not None:
                    self._on_notification(message.get("params", {}))
                continue
            response = JsonRpcResponse.parse(raw if isinstance(raw, str) else raw.decode("utf-8"))
            response.raise_for_error()
            return response.result

    async def maybe_heartbeat(self) -> None:
        """Call this periodically from the caller's own loop; sends `hello`
        again once `heartbeat_interval_s` has elapsed since the last one."""
        if time.monotonic() - self._last_heartbeat < self._config.heartbeat_interval_s:
            return
        await self.call(
            "hello",
            HelloParams(
                bridge_version=BRIDGE_PROTOCOL_VERSION,
                capabilities=self._config.capabilities,
                host_apps=["resolve"],
            ).to_wire(),
        )
        self._last_heartbeat = time.monotonic()


async def run_with_reconnect(
    config: BridgeClientConfig,
    on_connected: Callable[[BridgeClient], Awaitable[None]],
    on_notification: Callable[[dict[str, Any]], None] | None = None,
    max_attempts: int | None = None,
) -> None:
    """Connect, run `on_connected`, and reconnect with exponential backoff on
    any failure/disconnect until `max_attempts` is exhausted (None = forever).
    """
    backoff = config.min_backoff_s
    attempt = 0
    while max_attempts is None or attempt < max_attempts:
        attempt += 1
        client = BridgeClient(config, on_notification)
        try:
            await client.connect()
            backoff = config.min_backoff_s
            await on_connected(client)
            return
        except (OSError, websockets.exceptions.WebSocketException, RuntimeError):
            with contextlib.suppress(Exception):
                await client.close()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, config.max_backoff_s)
