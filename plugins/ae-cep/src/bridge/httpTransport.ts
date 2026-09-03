/**
 * Production `BridgeTransport`/`HttpClient` over the loopback HTTPS bridge server
 * (CONTRACTS §5 / `07-api-and-contracts.md` "Local bridge protocol (v2)": bearer token on
 * every route, `X-Montaj-Bridge: 1` to force a CORS preflight, no cookies). Uses `fetch`,
 * which a CEP panel's Chromium 99 context implements as a standard web-platform API (a CEP
 * panel is a Chromium tab, not a sandboxed UXP-style runtime — see the CEP Cookbook cited in
 * `src/host/ae.ts`'s header), so this file is fine outside `src/host/ae.ts`.
 */
import type { BridgeTransport } from "./client.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";
import type { HttpClient } from "../upload/mixdown.js";

export interface HttpBridgeTransportOptions {
  readonly baseUrl: string; // e.g. "https://127.0.0.1:47831"
  readonly bearerToken: string;
  readonly fetchImpl?: typeof fetch;
}

export class HttpBridgeTransport implements BridgeTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpBridgeTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.bearerToken}`,
        "X-Montaj-Bridge": "1",
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`bridge request failed: HTTP ${response.status}`);
    }
    return (await response.json()) as JsonRpcResponse;
  }
}

export class FetchHttpClient implements HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  async putBinary(url: string, body: Uint8Array, contentType: string): Promise<void> {
    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      // Wrapped in a Blob: TS's DOM lib types `BodyInit`/`BlobPart` against
      // `Uint8Array<ArrayBuffer>`, not the wider `Uint8Array<ArrayBufferLike>` this method
      // accepts (a `SharedArrayBuffer`-backed view is vanishingly unlikely here — this is a
      // local mixdown file's bytes — so the cast is safe); a Blob sidesteps the mismatch
      // without narrowing this method's own signature.
      body: new Blob([body as Uint8Array<ArrayBuffer>]),
    });
    if (!response.ok) {
      throw new Error(`upload PUT failed: HTTP ${response.status}`);
    }
  }

  async postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${url} failed: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
