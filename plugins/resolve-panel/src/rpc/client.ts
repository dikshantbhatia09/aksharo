/**
 * A thin typed JSON-RPC caller over `aksharo_core`'s loopback server, mirroring
 * `plugins/premiere-uxp/src/bridge/client.ts`'s shape: this package only *calls* the
 * protocol, the wire transport is owned by whatever the host gives it (the panel's own
 * production `WebSocket`; see `src/rpc/wsTransport.ts`), so this client takes an injectable
 * `RpcTransport` and never imports `ws` or a browser `WebSocket` itself.
 */
import { ResolveRpcError } from "./protocol.js";

import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export interface RpcTransport {
  /** Sends one JSON-RPC request and resolves with its response. */
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

export class ResolveRpcClient {
  private nextId = 1;

  constructor(private readonly transport: RpcTransport) {}

  async call<TResult = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<TResult> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId,
      method,
      params,
    };
    this.nextId += 1;
    const response = await this.transport.send(request);
    if (response.error) {
      throw new ResolveRpcError(response.error.code, response.error.message, response.error.data);
    }
    return response.result as TResult;
  }
}

/**
 * Deterministic in-memory transport for tests: a map of method -> handler (or a fixed
 * response), and a call log for assertions. Mirrors `MockBridgeTransport`.
 */
export class MockRpcTransport implements RpcTransport {
  readonly calls: JsonRpcRequest[] = [];
  private readonly handlers = new Map<
    string,
    (params: Record<string, unknown> | undefined) => Promise<unknown> | unknown
  >();

  on(
    method: string,
    handler: (params: Record<string, unknown> | undefined) => Promise<unknown> | unknown,
  ): void {
    this.handlers.set(method, handler);
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.calls.push(request);
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `no mock handler registered for "${request.method}"` },
      };
    }
    try {
      const result = await handler(request.params);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}
