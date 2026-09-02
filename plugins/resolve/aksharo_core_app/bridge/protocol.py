"""JSON-RPC 2.0 envelope + the bridge methods this Resolve script uses.

Wire-compatible with `packages/bridge-core/src/protocol.ts`
(`BRIDGE_PROTOCOL_VERSION`, `BRIDGE_ERROR_CODES`, `BRIDGE_METHODS`). This
client only ever calls the subset of methods C08's brief names: `hello`,
`transcript.push`, `apply.begin`, `apply.step`, `apply.commit`, `apply.abort`,
`events.subscribe`. Pairing (`pair.request`/`pair.confirm`/`session.exchange`)
is B08b's device-code flow (`device_auth.py`), not this module.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

BRIDGE_PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 512 * 1024

JsonRpcId = str | int | None

BRIDGE_ERROR_CODES: dict[str, int] = {
    "parseError": -32700,
    "invalidRequest": -32600,
    "methodNotFound": -32601,
    "invalidParams": -32602,
    "internalError": -32603,
    "unauthorized": -32000,
    "forbidden": -32001,
    "notPaired": -32002,
    "pairingExpired": -32003,
    "pairingDenied": -32004,
    "rateLimited": -32005,
    "messageTooLarge": -32006,
    "unsupportedVersion": -32007,
}

HostAppKind = Literal["premiere", "ae", "resolve"]


class BridgeRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


@dataclass(frozen=True, slots=True)
class JsonRpcRequest:
    method: str
    params: dict[str, Any] | None = None
    id: JsonRpcId = None

    def to_wire(self) -> dict[str, Any]:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": self.method}
        if self.params is not None:
            message["params"] = self.params
        if self.id is not None:
            message["id"] = self.id
        return message

    def dumps(self) -> str:
        return json.dumps(self.to_wire())


@dataclass(frozen=True, slots=True)
class JsonRpcResponse:
    id: JsonRpcId
    result: Any = None
    error: dict[str, Any] | None = None

    @staticmethod
    def parse(raw: str) -> JsonRpcResponse:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0":
            raise BridgeRpcError(BRIDGE_ERROR_CODES["parseError"], "not a JSON-RPC 2.0 message")
        return JsonRpcResponse(
            id=payload.get("id"), result=payload.get("result"), error=payload.get("error")
        )

    def raise_for_error(self) -> None:
        if self.error is not None:
            raise BridgeRpcError(
                int(self.error.get("code", BRIDGE_ERROR_CODES["internalError"])),
                str(self.error.get("message", "bridge error")),
                self.error.get("data"),
            )


@dataclass(frozen=True, slots=True)
class HelloParams:
    bridge_version: int
    capabilities: list[str]
    host_apps: list[HostAppKind] = field(default_factory=lambda: ["resolve"])

    def to_wire(self) -> dict[str, Any]:
        return {
            "bridgeVersion": self.bridge_version,
            "capabilities": self.capabilities,
            "hostApps": self.host_apps,
        }


@dataclass(frozen=True, slots=True)
class ApplyBeginParams:
    project_id: str
    host_app: HostAppKind
    item_ids: list[str]

    def to_wire(self) -> dict[str, Any]:
        return {"projectId": self.project_id, "hostApp": self.host_app, "itemIds": self.item_ids}


@dataclass(frozen=True, slots=True)
class ApplyStepParams:
    transaction_id: str
    step: int
    payload: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return {"transactionId": self.transaction_id, "step": self.step, "payload": self.payload}


@dataclass(frozen=True, slots=True)
class ApplyCommitParams:
    transaction_id: str

    def to_wire(self) -> dict[str, Any]:
        return {"transactionId": self.transaction_id}


@dataclass(frozen=True, slots=True)
class ApplyAbortParams:
    transaction_id: str
    reason: str | None = None

    def to_wire(self) -> dict[str, Any]:
        message: dict[str, Any] = {"transactionId": self.transaction_id}
        if self.reason is not None:
            message["reason"] = self.reason
        return message


@dataclass(frozen=True, slots=True)
class TranscriptPushParams:
    project_id: str
    transcript_id: str
    revision: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "projectId": self.project_id,
            "transcriptId": self.transcript_id,
            "revision": self.revision,
        }
