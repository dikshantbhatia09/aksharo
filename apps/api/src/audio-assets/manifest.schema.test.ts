import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { manifestAssetSchema, validateManifest } from "./manifest.schema.js";

// Same `__dirname`-relative convention `test/audio-assets.e2e-spec.ts` uses
// for this fixture (this package builds to CommonJS, so `__dirname` — not
// `import.meta.url` — is the portable way to find it).
const FIXTURE_MANIFEST_PATH = resolve(__dirname, "../../../../fixtures/audio-pack/manifest.json");

describe("validateManifest", () => {
  it("accepts the fixture pack manifest, sfx and music assets alike (D05)", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8")) as unknown;
    const manifest = validateManifest(raw);
    const sfxAssets = manifest.assets.filter((asset) => asset.kind === "sfx");
    const musicAssets = manifest.assets.filter((asset) => asset.kind === "music");
    expect(sfxAssets.length).toBeGreaterThan(0);
    expect(musicAssets.length).toBeGreaterThan(0);
    for (const asset of musicAssets) {
      expect(asset.bpm).toBeGreaterThan(0);
      expect(asset.mood.length).toBeGreaterThan(0);
      expect(asset.introMs).toBeGreaterThanOrEqual(0);
      expect(asset.outroMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects a duplicate asset id within one manifest", () => {
    expect(() =>
      validateManifest({
        pack: {
          id: "p",
          owner: "o",
          licenceRef: "r",
          version: "1",
          kind: "sfx",
        },
        assets: [
          {
            id: "dup",
            kind: "sfx",
            title: "one",
            filePath: "a.wav",
          },
          {
            id: "dup",
            kind: "sfx",
            title: "two",
            filePath: "b.wav",
          },
        ],
      }),
    ).toThrow(/duplicate asset id/);
  });
});

describe("manifestAssetSchema — D05's introMs/outroMs fields", () => {
  it("accepts a music asset's loop-point offsets", () => {
    const parsed = manifestAssetSchema.parse({
      id: "music-a",
      kind: "music",
      title: "bed",
      filePath: "a.wav",
      mood: ["calm"],
      bpm: 92,
      introMs: 200,
      outroMs: 300,
    });
    expect(parsed.introMs).toBe(200);
    expect(parsed.outroMs).toBe(300);
  });

  it("leaves introMs/outroMs unset for a plain sfx cue", () => {
    const parsed = manifestAssetSchema.parse({
      id: "sfx-a",
      kind: "sfx",
      title: "cue",
      filePath: "a.wav",
    });
    expect(parsed.introMs).toBeUndefined();
    expect(parsed.outroMs).toBeUndefined();
  });

  it("refuses a negative introMs/outroMs", () => {
    expect(() =>
      manifestAssetSchema.parse({
        id: "music-a",
        kind: "music",
        title: "bed",
        filePath: "a.wav",
        introMs: -1,
      }),
    ).toThrow();
  });
});
