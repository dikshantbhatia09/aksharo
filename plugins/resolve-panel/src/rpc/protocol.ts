/**
 * JSON-RPC 2.0 envelope for `aksharo_core`'s loopback server
 * (`plugins/resolve/aksharo_core_app/server.py`): `host.info`, `timeline.current`,
 * `apply.*`, `session.status`, `transcribe.start`, `passes.list`. Wire-compatible with that
 * module's `_dispatch` (`{jsonrpc, id, method, params}` -> `{jsonrpc, id, result|error}`).
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export class ResolveRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ResolveRpcError";
    this.code = code;
    this.data = data;
  }
}
