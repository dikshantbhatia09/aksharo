import { describe, expect, it } from "vitest";

import { defaultManifest, entriesForPlatform, ManifestError, parseManifest } from "./manifest.js";

describe("manifest", () => {
  it("the default manifest names the default and fallback ASR models as real entries", () => {
    const manifest = defaultManifest();
    expect(manifest.entries.some((e) => e.id === manifest.defaultAsrModel)).toBe(true);
    expect(manifest.entries.some((e) => e.id === manifest.fallbackAsrModel)).toBe(true);
  });

  it("includes ffmpeg, Silero VAD, deep-filter, and a CoreML variant (brief §1/§3)", () => {
    const manifest = defaultManifest();
    const kinds = manifest.entries.map((e) => e.kind);
    expect(kinds).toContain("vad");
    expect(kinds).toContain("denoise");
    expect(kinds).toContain("ffmpeg");
    expect(kinds).toContain("asr-coreml");
  });

  it("rejects a manifest with a duplicate entry id", () => {
    expect(() =>
      parseManifest({
        v: 1,
        generatedAt: "x",
        defaultAsrModel: "a",
        fallbackAsrModel: "a",
        entries: [
          { id: "a", kind: "asr", version: "1", path: "p", sizeBytes: 1, sha256: "0".repeat(64) },
          { id: "a", kind: "asr", version: "1", path: "p2", sizeBytes: 1, sha256: "0".repeat(64) },
        ],
      }),
    ).toThrow(ManifestError);
  });

  it("rejects a manifest whose defaultAsrModel is not a listed entry", () => {
    expect(() =>
      parseManifest({
        v: 1,
        generatedAt: "x",
        defaultAsrModel: "missing",
        fallbackAsrModel: "a",
        entries: [
          { id: "a", kind: "asr", version: "1", path: "p", sizeBytes: 1, sha256: "0".repeat(64) },
        ],
      }),
    ).toThrow(/defaultAsrModel/);
  });

  it("rejects a bad sha256", () => {
    expect(() =>
      parseManifest({
        v: 1,
        generatedAt: "x",
        defaultAsrModel: "a",
        fallbackAsrModel: "a",
        entries: [
          { id: "a", kind: "asr", version: "1", path: "p", sizeBytes: 1, sha256: "not-a-hash" },
        ],
      }),
    ).toThrow();
  });

  it("filters platform-specific entries: the CoreML variant is darwin-only", () => {
    const manifest = defaultManifest();
    const win = entriesForPlatform(manifest, "win32");
    const mac = entriesForPlatform(manifest, "darwin");
    expect(win.some((e) => e.id === "ggml-large-v3-turbo-encoder-coreml")).toBe(false);
    expect(mac.some((e) => e.id === "ggml-large-v3-turbo-encoder-coreml")).toBe(true);
  });
});
