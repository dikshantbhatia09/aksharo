import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { FakeBackend } from "./backends/fake-backend.js";
import { detectBackend } from "./detection.js";
import { defaultManifest } from "./manifest.js";
import { ModelManager } from "./model-manager.js";
import { startEngineServer, type EngineServerHandle } from "./server.js";

const BEARER = "test-bearer-".padEnd(32, "0");

async function buildServer(modelsDir: string): Promise<EngineServerHandle> {
  const manifest = defaultManifest();
  const modelManager = new ModelManager({
    manifest,
    baseUrl: "https://models.example",
    modelsDir,
    diskBudgetBytes: 10_000_000_000,
  });
  const detection = detectBackend({ platform: "linux", cores: 8, ramGb: 16 });
  return startEngineServer({
    bearer: BEARER,
    backend: new FakeBackend(),
    modelManager,
    detection,
    startedAt: Date.now(),
  });
}

describe("engine server (contract tests against FakeBackend)", () => {
  let dir: string;
  let server: EngineServerHandle;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "engine-server-"));
    server = await buildServer(dir);
    base = `http://127.0.0.1:${String(server.port)}`;
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("/health is unauthenticated and reports modelsMissing true with no models on disk", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { modelsMissing: boolean; backend: string; tier: string };
    expect(body.modelsMissing).toBe(true);
    expect(body.backend).toBe("fake");
    expect(["A", "B", "C", "D"]).toContain(body.tier);
  });

  it("rejects every other route without a bearer", async () => {
    const response = await fetch(`${base}/models`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("engine/unauthorized");
  });

  it("rejects a wrong bearer", async () => {
    const response = await fetch(`${base}/models`, { headers: { authorization: "Bearer wrong-token-000000000000000" } });
    expect(response.status).toBe(401);
  });

  it("GET /models lists the manifest entries, all 'available' with nothing downloaded", async () => {
    const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${BEARER}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: { state: string }[]; defaultModel: string };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.every((m) => m.state === "available")).toBe(true);
    expect(body.defaultModel).toBe("ggml-large-v3-turbo-q5_0");
  });

  it("POST /transcribe returns a validated transcript from FakeBackend", async () => {
    const response = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ audio: "hinglish-sample" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { language: string; words: unknown[] };
    expect(body.language).toBe("hi");
    expect(body.words.length).toBeGreaterThan(0);
  });

  it("POST /transcribe with an invalid body returns 400 engine/invalid_request", async () => {
    const response = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ notAudio: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("engine/invalid_request");
  });

  it("POST /align returns monotonic word timings", async () => {
    const response = await fetch(`${base}/align`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ audio: "hinglish-sample", words: ["ek", "do"], language: "hi", startS: 0 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { words: { start: number; end: number }[] };
    expect(body.words).toHaveLength(2);
  });

  it("POST /clean returns the deep-filter 48kHz contract shape", async () => {
    const response = await fetch(`${base}/clean`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ audio: "/tmp/whatever.wav" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sampleRateHz: number };
    expect(body.sampleRateHz).toBe(48_000);
  });

  it("POST /render delegates to FakeBackend and returns a frame count", async () => {
    const fs = await import("node:fs/promises");
    const framesPath = join(dir, "frames.json");
    await fs.writeFile(framesPath, JSON.stringify([[], []]));
    const response = await fetch(`${base}/render`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ drawCommandsPath: framesPath, width: 100, height: 100, fps: 30, outputPath: join(dir, "out.raw") }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { frameCount: number };
    expect(body.frameCount).toBe(2);
  });

  it("POST /models/download for an unknown model id returns a structured 400, not a crash", async () => {
    const response = await fetch(`${base}/models/download`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ modelId: "does-not-exist-in-manifest" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("engine/not_found");
  });

  it("404s an unknown route", async () => {
    const response = await fetch(`${base}/no-such-route`, { headers: { authorization: `Bearer ${BEARER}` } });
    expect(response.status).toBe(404);
  });

  it("streams transcribe partials over WS, authenticated via the bearer query param", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/transcribe?bearer=${BEARER}`);
    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ audio: "hinglish-sample" })));
      ws.on("message", (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString("utf8")) as { kind: string };
        messages.push(parsed);
        if (parsed.kind === "done") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
    expect(messages.some((m) => (m as { kind: string }).kind === "partial")).toBe(true);
    expect(messages.at(-1)).toMatchObject({ kind: "done" });
  });

  it("rejects a WS upgrade with a bad bearer", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/transcribe?bearer=wrong`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("close", () => resolve(true));
    });
    expect(closed).toBe(true);
  });
});
