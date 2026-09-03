import { afterEach, describe, expect, it, vi } from "vitest";

import { FetchHttpClient, HttpBridgeTransport } from "./httpTransport.js";

describe("HttpBridgeTransport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the JSON-RPC request with the required headers and returns the parsed response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: "1", result: { ok: true } }),
    });
    const transport = new HttpBridgeTransport({
      baseUrl: "https://127.0.0.1:47831",
      bearerToken: "tok-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await transport.send({ jsonrpc: "2.0", id: "1", method: "hello", params: {} });

    expect(response).toEqual({ jsonrpc: "2.0", id: "1", result: { ok: true } });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://127.0.0.1:47831/rpc");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok-1",
      "X-Montaj-Bridge": "1",
    });
  });

  it("throws on a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const transport = new HttpBridgeTransport({
      baseUrl: "https://127.0.0.1:47831",
      bearerToken: "tok-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      transport.send({ jsonrpc: "2.0", id: "1", method: "hello", params: {} }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("FetchHttpClient", () => {
  it("putBinary sends the content type and body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = new FetchHttpClient(fetchImpl as unknown as typeof fetch);
    const bytes = new Uint8Array([1, 2, 3]);

    await client.putBinary("https://r2.example/put", bytes, "audio/wav");

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ "Content-Type": "audio/wav" });
    expect(init.body).toBeInstanceOf(Blob);
    await expect((init.body as Blob).arrayBuffer()).resolves.toEqual(bytes.buffer);
  });

  it("putBinary throws on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = new FetchHttpClient(fetchImpl as unknown as typeof fetch);
    await expect(client.putBinary("u", new Uint8Array(), "audio/wav")).rejects.toThrow(/HTTP 500/);
  });

  it("postJson posts and parses JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "p1" }) });
    const client = new FetchHttpClient(fetchImpl as unknown as typeof fetch);

    const result = await client.postJson("https://api/x", { a: 1 }, { Authorization: "Bearer t" });

    expect(result).toEqual({ id: "p1" });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer t" });
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("postJson throws on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const client = new FetchHttpClient(fetchImpl as unknown as typeof fetch);
    await expect(client.postJson("u", {}, {})).rejects.toThrow(/HTTP 400/);
  });
});
