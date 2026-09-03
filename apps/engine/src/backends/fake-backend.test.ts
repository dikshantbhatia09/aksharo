import { describe, expect, it } from "vitest";

import { FakeBackend } from "./fake-backend.js";

describe("FakeBackend", () => {
  it("transcribe returns the Hinglish fixture for a matching audio path", async () => {
    const backend = new FakeBackend();
    const result = await backend.transcribe({ audio: "file:///tmp/hinglish-sample.wav" });
    expect(result.language).toBe("hi");
    expect(result.words.length).toBeGreaterThan(0);
    expect(result.backend).toBe("fake");
  });

  it("transcribe falls back to the default fixture for an unmatched audio path", async () => {
    const backend = new FakeBackend();
    const result = await backend.transcribe({ audio: "file:///tmp/unknown.wav" });
    expect(result.language).toBe("en");
  });

  it("transcribe is deterministic across calls (same fixture, same words)", async () => {
    const backend = new FakeBackend();
    const a = await backend.transcribe({ audio: "hinglish-sample" });
    const b = await backend.transcribe({ audio: "hinglish-sample" });
    expect(a.words).toEqual(b.words);
  });

  it("transcribeStream yields partials then a done frame with the same requestId", async () => {
    const backend = new FakeBackend();
    const messages = [];
    for await (const message of backend.transcribeStream({ audio: "hinglish-sample" })) {
      messages.push(message);
    }
    expect(messages.at(-1)?.kind).toBe("done");
    const ids = new Set(messages.map((m) => m.requestId));
    expect(ids.size).toBe(1);
    expect(messages.filter((m) => m.kind === "partial").length).toBeGreaterThan(0);
  });

  it("align stretches the requested word list across the fixture duration, monotonically", async () => {
    const backend = new FakeBackend();
    const result = await backend.align({
      audio: "hinglish-sample",
      words: ["ek", "do", "teen"],
      language: "hi",
      startS: 0,
    });
    expect(result.words).toHaveLength(3);
    for (let i = 1; i < result.words.length; i++) {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      expect(result.words[i]!.start).toBeGreaterThanOrEqual(result.words[i - 1]!.end);
    }
  });

  it("clean returns the deep-filter contract shape at 48kHz", async () => {
    const backend = new FakeBackend();
    const result = await backend.clean({ audio: "/nonexistent/path.wav" });
    expect(result.model).toBe("deep-filter");
    expect(result.sampleRateHz).toBe(48_000);
  });

  it("render reports a frame count matching the draw-command file's array length", async () => {
    const backend = new FakeBackend();
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-render-"));
    const drawCommandsPath = path.join(dir, "frames.json");
    await fs.writeFile(drawCommandsPath, JSON.stringify([[], [], []]));

    const result = await backend.render({
      drawCommandsPath,
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: path.join(dir, "out.raw"),
    });
    expect(result.frameCount).toBe(3);
    expect(result.durationS).toBeCloseTo(0.1, 5);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("engineVersions reports a version string for every subsystem", () => {
    const backend = new FakeBackend();
    const versions = backend.engineVersions();
    expect(versions.asr).toBeDefined();
    expect(versions.vad).toBeDefined();
    expect(versions.denoise).toBeDefined();
    expect(versions.ffmpeg).toBeDefined();
  });
});
