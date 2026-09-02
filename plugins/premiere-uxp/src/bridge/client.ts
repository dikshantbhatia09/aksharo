/**
 * A thin typed JSON-RPC caller over the bridge protocol (`@montaj/bridge-core`'s
 * `protocol.ts`, CONTRACTS §5, `03-architecture/07-api-and-contracts.md` "Local bridge
 * protocol (v2)"). This package only *calls* the protocol — the wire transport (relay WSS or
 * loopback HTTPS/WS) is owned by `@montaj/bridge-core` / `apps/bridge`; the panel talks to it
 * through whatever UXP gives it (`fetch`/`WebSocket`), so this client takes an injectable
 * `BridgeTransport` and never imports `ws` or Node net APIs — see `src/host/premiere.ts`'s
 * rule that only that file touches host/runtime-specific globals (here: only `index.tsx`'s
 * production wiring touches the real `fetch`/`WebSocket`; everything else takes the
 * transport as a parameter).
 */
import { ulid } from "ulid";

import {
  BRIDGE_METHODS,
  BridgeRpcError,
  toJsonRpcError,
  type BridgeMethod,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";

import type { z } from "zod";

export interface BridgeTransport {
  /** Sends one JSON-RPC request and resolves with its response (relay or loopback, C01). */
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

export type BridgeMethodParams<M extends BridgeMethod> = z.infer<
  (typeof BRIDGE_METHODS)[M]["params"]
>;

export type BridgeMethodResult<M extends BridgeMethod> = z.infer<
  (typeof BRIDGE_METHODS)[M]["result"]
>;

/**
 * Validates params/result against the shared zod schemas from `@montaj/bridge-core` so a
 * protocol drift between this plugin and the bridge fails at the call site, not deep inside a
 * React component.
 */
export class BridgeClient {
  constructor(private readonly transport: BridgeTransport) {}

  async call<M extends BridgeMethod>(
    method: M,
    params: BridgeMethodParams<M>,
  ): Promise<BridgeMethodResult<M>> {
    const spec = BRIDGE_METHODS[method];
    const parsedParams = spec.params.parse(params);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ulid(),
      method,
      params: parsedParams,
    };

    const response = await this.transport.send(request);
    if (response.error) {
      throw new BridgeRpcError(response.error.code, response.error.message, response.error.data);
    }
    return spec.result.parse(response.result) as BridgeMethodResult<M>;
  }
}

/**
 * Deterministic in-memory transport for tests: a map of method -> handler (or a fixed
 * response), and a call log for assertions.
 */
export class MockBridgeTransport implements BridgeTransport {
  readonly calls: JsonRpcRequest[] = [];
  private readonly handlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();

  on(method: BridgeMethod, handler: (params: unknown) => Promise<unknown> | unknown): void {
    this.handlers.set(method, handler);
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.calls.push(request);
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: toJsonRpcError(new Error(`no mock handler registered for "${request.method}"`)),
      };
    }
    try {
      const result = await handler(request.params);
      return { jsonrpc: "2.0", id: request.id ?? null, result };
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id ?? null, error: toJsonRpcError(error) };
    }
  }
}
