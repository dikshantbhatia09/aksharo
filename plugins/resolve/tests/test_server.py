from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest
import websockets

from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle
from aksharo_core_app.server import LoopbackServer, LoopbackServerConfig, PanelDeps
from aksharo_core_app.session import SessionState

RunningServer = tuple[LoopbackServer, int]


@pytest.fixture
async def running_server() -> AsyncIterator[RunningServer]:
    host = FakeResolveHost(TimelineHandle(name="Timeline 1", fps=25.0))
    config = LoopbackServerConfig(bearer="secret-token")
    server = LoopbackServer(config, host)
    port = await server.start()
    try:
        yield server, port
    finally:
        await server.stop()


async def test_start_binds_a_port_in_the_documented_range(running_server: RunningServer) -> None:
    _server, port = running_server
    assert port in range(47841, 47844)


async def test_host_info_requires_bearer_token(running_server: RunningServer) -> None:
    _server, port = running_server
    async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
        with pytest.raises(websockets.exceptions.ConnectionClosed):
            await ws.recv()


async def test_host_info_and_timeline_current_over_ws(running_server: RunningServer) -> None:
    _server, port = running_server
    async with websockets.connect(
        f"ws://127.0.0.1:{port}", additional_headers={"authorization": "Bearer secret-token"}
    ) as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "host.info"}))
        response = json.loads(await ws.recv())
        assert response["result"] == {"hostApp": "resolve", "connected": True}

        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "timeline.current"}))
        response = json.loads(await ws.recv())
        assert response["result"]["timeline"]["name"] == "Timeline 1"


async def test_unknown_method_returns_method_not_found_error(
    running_server: RunningServer,
) -> None:
    _server, port = running_server
    async with websockets.connect(
        f"ws://127.0.0.1:{port}", additional_headers={"authorization": "Bearer secret-token"}
    ) as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "nope"}))
        response = json.loads(await ws.recv())
        assert response["error"]["code"] == -32601


async def test_host_info_accepts_bearer_as_query_token(running_server: RunningServer) -> None:
    """C09: a browser `WebSocket` cannot set an `Authorization` header, so the panel
    authenticates with `?token=` instead (`server.py`'s `_query_token`)."""
    _server, port = running_server
    async with websockets.connect(f"ws://127.0.0.1:{port}?token=secret-token") as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "host.info"}))
        response = json.loads(await ws.recv())
        assert response["result"] == {"hostApp": "resolve", "connected": True}


async def test_query_token_must_match_the_configured_bearer(
    running_server: RunningServer,
) -> None:
    _server, port = running_server
    async with websockets.connect(f"ws://127.0.0.1:{port}?token=wrong-token") as ws:
        with pytest.raises(websockets.exceptions.ConnectionClosed):
            await ws.recv()


async def test_registered_handler_is_dispatched(running_server: RunningServer) -> None:
    server, port = running_server
    server.register("apply.begin", lambda _params: {"transactionId": "t1"})
    async with websockets.connect(
        f"ws://127.0.0.1:{port}", additional_headers={"authorization": "Bearer secret-token"}
    ) as ws:
        await ws.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "apply.begin",
                    "params": {"projectId": "p1", "hostApp": "resolve", "itemIds": ["i1"]},
                }
            )
        )
        response = json.loads(await ws.recv())
        assert response["result"] == {"transactionId": "t1"}


async def test_malformed_json_returns_parse_error(running_server: RunningServer) -> None:
    _server, port = running_server
    async with websockets.connect(
        f"ws://127.0.0.1:{port}", additional_headers={"authorization": "Bearer secret-token"}
    ) as ws:
        await ws.send("not json")
        response = json.loads(await ws.recv())
        assert response["error"]["code"] == -32700


async def test_panel_deps_wires_session_status_transcribe_and_passes() -> None:
    host = FakeResolveHost(TimelineHandle(name="Timeline 1", fps=25.0))
    session = SessionState()
    session.mark_signed_in("ws_1", "creator@example.com")
    panel_deps = PanelDeps(
        session=session,
        transcribe_start=lambda _params: {"projectId": "proj_1"},
        list_passes=lambda _params: {"passes": []},
    )
    config = LoopbackServerConfig(bearer="secret-token")
    server = LoopbackServer(config, host, panel_deps)
    port = await server.start()
    try:
        async with websockets.connect(
            f"ws://127.0.0.1:{port}", additional_headers={"authorization": "Bearer secret-token"}
        ) as ws:
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "session.status"}))
            response = json.loads(await ws.recv())
            assert response["result"]["signedIn"] is True
            assert response["result"]["workspaceId"] == "ws_1"

            await ws.send(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "transcribe.start"}))
            response = json.loads(await ws.recv())
            assert response["result"] == {"projectId": "proj_1"}

            await ws.send(json.dumps({"jsonrpc": "2.0", "id": 3, "method": "passes.list"}))
            response = json.loads(await ws.recv())
            assert response["result"] == {"passes": []}
    finally:
        await server.stop()
