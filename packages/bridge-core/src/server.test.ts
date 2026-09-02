import { Agent, request as httpsRequest } from "node:https";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createTestCertificate } from "./cert.js";
import { generateBearerToken } from "./discovery.js";
import { MAX_MESSAGE_BYTES } from "./protocol.js";
import { startLoopbackServer, type BridgeServerHandle } from "./server.js";

const ALLOWED_ORIGIN = "https://app.aksharo.ai";

let handle: BridgeServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

function insecureAgent(): Agent {
  // The test cert is self-signed and clearly marked as such (cert.ts); tests
  // trust it explicitly rather than installing a real CA chain for loopback.
  return new Agent({ rejectUnauthorized: false });
}

async function postJson(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/rpc",
        agent: insecureAgent(),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function start(bearer: string): Promise<BridgeServerHandle> {
  const cert = createTestCertificate();
  const server = await startLoopbackServer({
    bearer,
    cert,
    handleRpc: (method) =>
      Promise.resolve(method === "hello" ? { bridgeVersion: 1, sessionId: "s" } : {}),
  });
  handle = server;
  return server;
}

describe("loopback HTTPS server — negative security tests", () => {
  it("binds to 127.0.0.1 on one of the documented ports", async () => {
    const server = await start(generateBearerToken());
    expect([47831, 47832, 47833]).toContain(server.port);
  });

  it("401s a request with no bearer", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const res = await postJson(
      server.port,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "hello",
        params: { bridgeVersion: 1, capabilities: [], hostApps: [] },
      },
      { host: `127.0.0.1:${String(server.port)}` },
    );
    expect(res.status).toBe(401);
  });

  it("401s a request with the wrong bearer", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const res = await postJson(
      server.port,
      { jsonrpc: "2.0", id: 1, method: "hello", params: {} },
      { host: `127.0.0.1:${String(server.port)}`, authorization: "Bearer wrong-token" },
    );
    expect(res.status).toBe(401);
  });

  it("400s a request with a disallowed Host header", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const res = await postJson(
      server.port,
      { jsonrpc: "2.0", id: 1, method: "hello", params: {} },
      { host: "evil.example.com", authorization: `Bearer ${bearer}` },
    );
    expect(res.status).toBe(400);
  });

  it("403s a request from a disallowed Origin", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const res = await postJson(
      server.port,
      { jsonrpc: "2.0", id: 1, method: "hello", params: {} },
      {
        host: `127.0.0.1:${String(server.port)}`,
        authorization: `Bearer ${bearer}`,
        origin: "https://evil.example.com",
      },
    );
    expect(res.status).toBe(403);
  });

  it("403s a request with a null Origin", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const res = await postJson(
      server.port,
      { jsonrpc: "2.0", id: 1, method: "hello", params: {} },
      {
        host: `127.0.0.1:${String(server.port)}`,
        authorization: `Bearer ${bearer}`,
        origin: "null",
      },
    );
    expect(res.status).toBe(403);
  });

  it("accepts a request from an allowlisted Origin with valid bearer/Host", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const res = await postJson(
      server.port,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "hello",
        params: { bridgeVersion: 1, capabilities: [], hostApps: [] },
      },
      {
        host: `127.0.0.1:${String(server.port)}`,
        authorization: `Bearer ${bearer}`,
        origin: ALLOWED_ORIGIN,
      },
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as { result?: { bridgeVersion: number } };
    expect(parsed.result?.bridgeVersion).toBe(1);
  });

  it("413s an oversized HTTP body", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const oversized = "x".repeat(MAX_MESSAGE_BYTES + 1024);
    const res = await postJson(server.port, oversized, {
      host: `127.0.0.1:${String(server.port)}`,
      authorization: `Bearer ${bearer}`,
    });
    expect(res.status).toBe(413);
  });

  it("rejects an unpaired call to an authenticated method with notPaired", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const res = await postJson(
      server.port,
      { jsonrpc: "2.0", id: 1, method: "engine.status", params: {} },
      { host: `127.0.0.1:${String(server.port)}`, authorization: `Bearer ${bearer}` },
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as { error?: { code: number } };
    expect(parsed.error?.code).toBe(-32002);
  });
});

describe("loopback WebSocket — negative security tests", () => {
  it("refuses the upgrade with no bearer", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const closed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${String(server.port)}/`, {
        rejectUnauthorized: false,
        headers: { host: `127.0.0.1:${String(server.port)}` },
      });
      ws.on("open", () => resolve(false));
      ws.on("unexpected-response", () => resolve(true));
      ws.on("error", () => resolve(true));
    });
    expect(closed).toBe(true);
  });

  it("closes a connection sending an oversized frame", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${String(server.port)}/`, {
        rejectUnauthorized: false,
        headers: {
          host: `127.0.0.1:${String(server.port)}`,
          authorization: `Bearer ${bearer}`,
          origin: ALLOWED_ORIGIN,
        },
      });
      ws.on("open", () => {
        ws.send("x".repeat(MAX_MESSAGE_BYTES + 1024));
      });
      ws.on("close", (code: number) => resolve(code));
      ws.on("error", reject);
    });
    expect(closeCode).toBe(1009);
  });

  it("round-trips hello over an authenticated, allowlisted connection", async () => {
    const bearer = generateBearerToken();
    const server = await start(bearer);
    const result = await new Promise<unknown>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${String(server.port)}/`, {
        rejectUnauthorized: false,
        headers: {
          host: `127.0.0.1:${String(server.port)}`,
          authorization: `Bearer ${bearer}`,
          origin: ALLOWED_ORIGIN,
        },
      });
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "hello",
            params: { bridgeVersion: 1, capabilities: [], hostApps: [] },
          }),
        );
      });
      ws.on("message", (data: Buffer) => {
        resolve(JSON.parse(data.toString("utf8")));
        ws.close();
      });
      ws.on("error", reject);
    });
    expect((result as { result?: { bridgeVersion: number } }).result?.bridgeVersion).toBe(1);
  });
});
