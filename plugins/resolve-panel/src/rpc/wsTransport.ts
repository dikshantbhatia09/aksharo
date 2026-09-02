/**
 * The ONLY file in this package allowed to construct a real `WebSocket`. Wires
 * `RpcTransport` (`src/rpc/client.ts`) to `ws://127.0.0.1:<port>?token=<bearer>` — a query
 * param, not an `Authorization` header, because the browser `WebSocket` constructor cannot
 * set request headers (see `connect.ts`'s note and
 * `plugins/resolve/aksharo_core_app/server.py`'s `_query_token`, this WP's server-side
 * addition for exactly this caller). One call in flight at a time, matching
 * `aksharo_core_app/bridge/client.py`'s "one call at a time" contract on the script side.
 */
import type { RpcTransport } from "./client.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export function createWebSocketTransport(port: number, bearer: string): RpcTransport {
  let ready: Promise<WebSocket> | undefined;

  function connect(): Promise<WebSocket> {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(bearer)}`);
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener(
        "error",
        () => reject(new Error("resolve-panel: loopback WebSocket connection failed")),
        { once: true },
      );
      ws.addEventListener(
        "close",
        () => {
          ready = undefined;
        },
        { once: true },
      );
    });
    return ready;
  }

  return {
    async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
      const ws = await connect();
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        function onMessage(event: MessageEvent): void {
          const data = typeof event.data === "string" ? event.data : String(event.data);
          let parsed: JsonRpcResponse;
          try {
            parsed = JSON.parse(data) as JsonRpcResponse;
          } catch {
            return; // not JSON for this request; keep waiting
          }
          if (parsed.id !== request.id) return; // another in-flight response; keep waiting
          ws.removeEventListener("message", onMessage);
          resolve(parsed);
        }
        ws.addEventListener("message", onMessage);
        try {
          ws.send(JSON.stringify(request));
        } catch (error) {
          ws.removeEventListener("message", onMessage);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}
