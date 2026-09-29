import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { answerLookup, pinnedTransport } from "./safe-fetch.js";

import type { AddressInfo } from "node:net";

/**
 * The real transport, not a fake (2026-09-29). Every other test of `safeFetch`
 * injects its own transport, which is how a pinned lookup that answered Node
 * 20+'s `{ all: true }` form wrongly failed every real request in production
 * ("Invalid IP address: undefined") with the whole suite green.
 */
describe("pinnedTransport", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`hello from ${request.headers.host ?? "?"}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to the pinned address, whatever the name would resolve to", async () => {
    // A name that resolves nowhere: only the pinned address can reach the server.
    const response = await pinnedTransport({
      url: new URL(`http://pinned.invalid:${String(port)}/hello`),
      address: "127.0.0.1",
      family: 4,
      headers: {},
      timeoutMs: 5_000,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    expect(response.status).toBe(200);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      `hello from pinned.invalid:${String(port)}`,
    );
  });
});

describe("answerLookup", () => {
  it("answers an `all` lookup with an array, and any other with one address", () => {
    const all = vi.fn();
    answerLookup({ all: true }, all, "203.0.113.7", 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: "203.0.113.7", family: 4 }]);

    const one = vi.fn();
    answerLookup({}, one, "2001:db8::1", 6);
    expect(one).toHaveBeenCalledWith(null, "2001:db8::1", 6);
  });
});
