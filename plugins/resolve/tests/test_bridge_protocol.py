from __future__ import annotations

import json

import pytest

from aksharo_core_app.bridge.protocol import (
    ApplyBeginParams,
    ApplyStepParams,
    BridgeRpcError,
    HelloParams,
    JsonRpcRequest,
    JsonRpcResponse,
    TranscriptPushParams,
)


def test_hello_params_to_wire_matches_ts_camel_case() -> None:
    params = HelloParams(bridge_version=1, capabilities=["captions"], host_apps=["resolve"])
    assert params.to_wire() == {
        "bridgeVersion": 1,
        "capabilities": ["captions"],
        "hostApps": ["resolve"],
    }


def test_apply_begin_params_to_wire() -> None:
    params = ApplyBeginParams(project_id="p1", host_app="resolve", item_ids=["i1", "i2"])
    assert params.to_wire() == {"projectId": "p1", "hostApp": "resolve", "itemIds": ["i1", "i2"]}


def test_apply_step_params_to_wire() -> None:
    params = ApplyStepParams(transaction_id="t1", step=0, payload={"a": 1})
    assert params.to_wire() == {"transactionId": "t1", "step": 0, "payload": {"a": 1}}


def test_transcript_push_params_to_wire() -> None:
    params = TranscriptPushParams(project_id="p1", transcript_id="tr1", revision=3)
    assert params.to_wire() == {"projectId": "p1", "transcriptId": "tr1", "revision": 3}


def test_json_rpc_request_dumps_is_valid_json_rpc_2() -> None:
    request = JsonRpcRequest(method="hello", params={"x": 1}, id=1)
    wire = json.loads(request.dumps())
    assert wire == {"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {"x": 1}}


def test_json_rpc_response_parse_success() -> None:
    raw = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
    response = JsonRpcResponse.parse(raw)
    response.raise_for_error()  # must not raise
    assert response.result == {"ok": True}


def test_json_rpc_response_parse_error_raises_bridge_rpc_error() -> None:
    raw = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "unauthorized"}}
    )
    response = JsonRpcResponse.parse(raw)
    with pytest.raises(BridgeRpcError) as exc_info:
        response.raise_for_error()
    assert exc_info.value.code == -32000


def test_json_rpc_response_parse_rejects_non_json_rpc_message() -> None:
    with pytest.raises(BridgeRpcError):
        JsonRpcResponse.parse(json.dumps({"foo": "bar"}))
