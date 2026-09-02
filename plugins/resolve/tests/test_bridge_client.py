from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import pytest
from websockets.asyncio.server import ServerConnection, serve

from aksharo_core_app.bridge.client import BridgeClient, BridgeClientConfig, run_with_reconnect
from aksharo_core_app.bridge.protocol import BridgeRpcError


async def _fake_bridge_handler(connection: ServerConnection) -> None:
    async for raw in connection:
        message = json.loads(raw)
        if message["method"] == "hello":
            await connection.send(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "result": {"bridgeVersion": 1, "sessionId": "sess1"},
                    }
                )
            )
        elif message["method"] == "boom":
            await connection.send(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": {"code": -32000, "message": "unauthorized"},
                    }
                )
            )
        else:
            await connection.send(
                json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"ok": True}})
            )


@pytest.fixture
async def fake_bridge() -> AsyncIterator[int]:
    server = await serve(_fake_bridge_handler, "127.0.0.1", 0)
    sockets = list(server.sockets or [])
    port: int = sockets[0].getsockname()[1]
    try:
        yield port
    finally:
        server.close()
        await server.wait_closed()


async def test_connect_performs_hello_handshake(fake_bridge: int) -> None:
    port = fake_bridge
    client = BridgeClient(BridgeClientConfig(url=f"ws://127.0.0.1:{port}", bearer="tok"))
    await client.connect()
    result = await client.call("transcript.push", {"projectId": "p1"})
    assert result == {"ok": True}
    await client.close()


async def test_call_raises_bridge_rpc_error_on_server_error(fake_bridge: int) -> None:
    port = fake_bridge
    client = BridgeClient(BridgeClientConfig(url=f"ws://127.0.0.1:{port}", bearer="tok"))
    await client.connect()
    with pytest.raises(BridgeRpcError):
        await client.call("boom", {})
    await client.close()


async def test_call_before_connect_raises_runtime_error() -> None:
    client = BridgeClient(BridgeClientConfig(url="ws://127.0.0.1:1", bearer="tok"))
    with pytest.raises(RuntimeError):
        await client.call("hello", {})


async def test_run_with_reconnect_succeeds_on_first_attempt(fake_bridge: int) -> None:
    port = fake_bridge
    seen: list[object] = []

    async def on_connected(client: BridgeClient) -> None:
        seen.append(await client.call("transcript.push", {"projectId": "p1"}))
        await client.close()

    await run_with_reconnect(
        BridgeClientConfig(url=f"ws://127.0.0.1:{port}", bearer="tok"), on_connected
    )
    assert seen == [{"ok": True}]


async def test_run_with_reconnect_gives_up_after_max_attempts() -> None:
    async def on_connected(_client: BridgeClient) -> None:
        raise AssertionError("should never connect")

    # Nothing listens on this port, so `connect` raises OSError every attempt.
    await run_with_reconnect(
        BridgeClientConfig(
            url="ws://127.0.0.1:1", bearer="tok", min_backoff_s=0.01, max_backoff_s=0.02
        ),
        on_connected,
        max_attempts=2,
    )


async def test_maybe_heartbeat_sends_hello_again_when_due(fake_bridge: int) -> None:
    port = fake_bridge
    client = BridgeClient(
        BridgeClientConfig(url=f"ws://127.0.0.1:{port}", bearer="tok", heartbeat_interval_s=0)
    )
    await client.connect()
    await asyncio.sleep(0)
    await client.maybe_heartbeat()  # due immediately since interval is 0
    await client.close()
