import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { EngineClient, EngineClientError } from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("EngineClient", () => {
  it("parses a valid /health response", async () => {
    const health = {
      status: "ok",
      backend: "fake",
      tier: "A",
      tierReason: "fake backend for tests",
      engineVersions: { asr: "fake-1.0" },
      modelsMissing: false,
      uptimeS: 1.2,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, health));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });

    const result = await client.health();
    expect(result).toEqual(health);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:47901/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects a malformed response instead of returning bad data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: "ok" }));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });

    await expect(client.health()).rejects.toThrow();
  });

  it("wraps a non-2xx error envelope in EngineClientError", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { error: { code: "engine/unauthorized", message: "bad bearer" } }),
      );
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });

    await expect(client.health()).rejects.toMatchObject({
      code: "engine/unauthorized",
      status: 401,
    });
  });

  it("sends the bearer as an Authorization header on POST requests with a body", async () => {
    const transcribeResult = {
      language: "hi",
      languageProbability: 0.9,
      durationS: 1,
      model: "fake",
      requestId: "01J000",
      words: [],
      segments: [],
      engineVersions: {},
      usage: { audioSeconds: 1, model: "fake" },
      backend: "fake",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, transcribeResult));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "secret-token-1234567890123456",
      fetchImpl,
    });

    await client.transcribe({ audio: "file:///tmp/a.wav" });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-token-1234567890123456",
    );
  });

  it("throws EngineClientError instance", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });
    try {
      await client.health();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EngineClientError);
    }
  });

  it("models() parses the /models response", async () => {
    const modelsResponse = {
      models: [],
      diskUsageBytes: 0,
      diskBudgetBytes: 1,
      defaultModel: "a",
      fallbackModel: "b",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, modelsResponse));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });
    expect(await client.models()).toEqual(modelsResponse);
  });

  it("downloadModel and deleteModel POST to their routes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });
    await client.downloadModel("ggml-large-v3-turbo-q5_0");
    await client.deleteModel("ggml-large-v3-turbo-q5_0");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:47901/models/download",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:47901/models/delete",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("align() and clean() parse their responses", async () => {
    const alignResponse = {
      language: "hi",
      model: "fake",
      licence: "MIT",
      durationS: 1,
      requestId: "r1",
      words: [],
      skipped: [],
      engineVersions: {},
      usage: { audioSeconds: 1, model: "fake" },
      backend: "fake",
    };
    const cleanResponse = {
      audio: "out.wav",
      model: "deep-filter",
      sampleRateHz: 48_000,
      durationS: 1,
      requestId: "r2",
      engineVersions: {},
      backend: "fake",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, alignResponse))
      .mockResolvedValueOnce(jsonResponse(200, cleanResponse));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });

    expect(await client.align({ audio: "a", words: ["a"], language: "hi", startS: 0 })).toEqual(
      alignResponse,
    );
    expect(await client.clean({ audio: "a" })).toEqual(cleanResponse);
  });

  it("render() parses its response", async () => {
    const renderResponse = {
      outputPath: "out.raw",
      frameCount: 2,
      durationS: 0.1,
      requestId: "r3",
      engineVersions: {},
      backend: "fake",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, renderResponse));
    const client = new EngineClient({
      baseUrl: "http://127.0.0.1:47901",
      bearer: "x".repeat(32),
      fetchImpl,
    });
    expect(
      await client.render({
        drawCommandsPath: "f.json",
        width: 10,
        height: 10,
        fps: 30,
        outputPath: "out.raw",
      }),
    ).toEqual(renderResponse);
  });

  it("transcribeStream authenticates over the WS query param and yields partial/done frames", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    wss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      expect(url.searchParams.get("bearer")).toBe("stream-bearer-0000000000000000");
      socket.on("message", () => {
        socket.send(
          JSON.stringify({
            requestId: "r1",
            kind: "partial",
            words: [],
            segment: { start: 0, end: 1, text: "hi" },
          }),
        );
        socket.send(
          JSON.stringify({
            requestId: "r1",
            kind: "done",
            result: {
              language: "en",
              languageProbability: 1,
              durationS: 1,
              model: "fake",
              requestId: "r1",
              words: [],
              segments: [],
              engineVersions: {},
              usage: { audioSeconds: 1, model: "fake" },
              backend: "fake",
            },
          }),
        );
      });
    });

    try {
      const client = new EngineClient({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        bearer: "stream-bearer-0000000000000000",
      });
      const messages = [];
      for await (const message of client.transcribeStream({ audio: "a" })) {
        messages.push(message);
      }
      expect(messages[0]?.kind).toBe("partial");
      expect(messages[1]?.kind).toBe("done");
    } finally {
      wss.close();
    }
  });
});
