/**
 * The ONLY file in this package allowed to construct a real `WebSocket`. Wires
 * `RpcTransport` (`src/rpc/client.ts`) to `ws://127.0.0.1:<port>?ticket=<ticket>` — a
 * one-time ticket, not the long-lived bearer, because the browser `WebSocket` constructor
 * cannot set request headers (see `connect.ts`'s note). The ticket itself is minted by a
 * plain `fetch()` GET to `/session/ws-ticket` with an `Authorization: Bearer <bearer>`
 * header — `fetch` *can* set that header, unlike `WebSocket` — on the same loopback port
 * (`plugins/resolve/aksharo_core_app/server.py`'s `_process_request`/`_issue_ws_ticket`,
 * C02c's replacement for C09's `?token=` fallback: docs/security/threat-model-audit-
 * 2026-09-03.md, T11 follow-up). One call in flight at a time, matching
 * `aksharo_core_app/bridge/client.py`'s "one call at a time" contract on the script side.
 */
import type { RpcTransport } from "./client.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export interface WebSocketTransportDeps {
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchTicket?: typeof fetch;
}

/** Exported for `wsTransport.test.ts`: the ticket exchange needs no live `WebSocket`
 * (jsdom has none to talk to; see vitest.config.ts's coverage exclude), only a mockable
 * `fetch`, so it is unit-tested directly rather than only "exercised manually". */
export async function requestWsTicket(
  port: number,
  bearer: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`http://127.0.0.1:${String(port)}/session/ws-ticket`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!response.ok) {
    throw new Error(`resolve-panel: ws-ticket request failed (${String(response.status)})`);
  }
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string" || body.ticket === "") {
    throw new Error("resolve-panel: ws-ticket response carried no ticket");
  }
  return body.ticket;
}

export function createWebSocketTransport(
  port: number,
  bearer: string,
  deps: WebSocketTransportDeps = {},
): RpcTransport {
  const fetchImpl = deps.fetchTicket ?? fetch;
  let ready: Promise<WebSocket> | undefined;

  function connect(): Promise<WebSocket> {
    if (ready) return ready;
    ready = (async () => {
      const ticket = await requestWsTicket(port, bearer, fetchImpl);
      return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${String(port)}?ticket=${encodeURIComponent(ticket)}`,
        );
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
    })();
    // A failed ticket fetch or handshake must not wedge `ready` forever — the
    // next `send()` should retry from scratch, same as a socket `close`.
    ready.catch(() => {
      ready = undefined;
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
