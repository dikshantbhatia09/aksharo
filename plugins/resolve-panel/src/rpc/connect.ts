/**
 * Discover -> bearer -> JSON-RPC connect to `aksharo_core`'s loopback server (brief item 1).
 * Pure orchestration: takes a `WorkflowIntegrationHost` (for the discovery file) and an
 * injectable transport factory, so it is fully testable without a real WebSocket or Resolve.
 */
import { ResolveRpcClient, type RpcTransport } from "./client.js";

import type { WorkflowIntegrationHost } from "../host/workflow-integration.js";

export type ConnectionState =
  | { readonly status: "disconnected" }
  | { readonly status: "waitingForScript" }
  | { readonly status: "connected"; readonly port: number }
  | { readonly status: "error"; readonly message: string };

export interface ConnectOptions {
  readonly host: WorkflowIntegrationHost;
  /** Builds the wire transport for a discovered port/bearer (the panel's own `WebSocket`
   * in production, `MockRpcTransport` in tests). `?token=` is used, not an `Authorization`
   * header, because a browser `WebSocket` cannot set request headers on the handshake —
   * see `plugins/resolve/aksharo_core_app/server.py`'s `_query_token` (this WP's addition). */
  readonly createTransport: (port: number, bearer: string) => RpcTransport;
}

export interface ConnectResult {
  readonly client: ResolveRpcClient;
  readonly port: number;
}

/** Looks for the discovery file once; callers poll this on an interval (the script may not
 * have started the loopback server yet — `aksharo_core.py` starts it from Workspace ▸
 * Scripts, independent of when the panel view opens). */
export async function tryConnect(options: ConnectOptions): Promise<ConnectResult | undefined> {
  const discovery = await options.host.readDiscoveryFile();
  if (!discovery) return undefined;
  const transport = options.createTransport(discovery.port, discovery.bearer);
  return { client: new ResolveRpcClient(transport), port: discovery.port };
}
