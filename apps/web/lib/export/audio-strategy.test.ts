import { describe, expect, it } from "vitest";

import type { RenderManifest, UnsignedRenderManifest } from "@montaj/render-manifest";
import { signedFixtureManifest } from "@montaj/render-manifest/testing";

import { decideAudioStrategy, isAudioUnmodified, timemapModifiesAudio } from "./audio-strategy";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

const SECRET = "test-secret";

function manifestWith(overrides: DeepPartial<UnsignedRenderManifest>): RenderManifest {
  return signedFixtureManifest(SECRET, overrides);
}

describe("timemapModifiesAudio / isAudioUnmodified", () => {
  it("is unmodified with no edits and passthrough audio", () => {
    const manifest = manifestWith({
      timemap: { sourceDurationMs: 10_000, edits: [], snapCutsToFrames: false },
    });
    expect(timemapModifiesAudio(manifest)).toBe(false);
    expect(isAudioUnmodified(manifest)).toBe(true);
  });

  it("is modified when a cut exists", () => {
    const manifest = manifestWith({
      timemap: {
        sourceDurationMs: 10_000,
        edits: [{ kind: "cut", startMs: 1000, endMs: 2000 }],
        snapCutsToFrames: false,
      },
    });
    expect(timemapModifiesAudio(manifest)).toBe(true);
    expect(isAudioUnmodified(manifest)).toBe(false);
  });

  it("is modified when the manifest asks to replace the audio, even with no edits", () => {
    const manifest = manifestWith({
      audio: { strategy: "replace", cleanKey: "ws/x/clean.wav", codec: "aac", bitrateKbps: 192 },
    });
    expect(isAudioUnmodified(manifest)).toBe(false);
  });
});

describe("decideAudioStrategy", () => {
  it("copies packets for unmodified audio, regardless of AAC availability", () => {
    const manifest = manifestWith({
      timemap: { sourceDurationMs: 10_000, edits: [], snapCutsToFrames: false },
    });
    expect(
      decideAudioStrategy({ manifest, aacEncodable: false, aacPolyfillAvailable: false }),
    ).toEqual({
      kind: "copy",
    });
  });

  it("encodes natively when audio is modified and AAC is encodable", () => {
    const manifest = manifestWith({
      timemap: {
        sourceDurationMs: 10_000,
        edits: [{ kind: "cut", startMs: 0, endMs: 500 }],
        snapCutsToFrames: false,
      },
    });
    expect(
      decideAudioStrategy({ manifest, aacEncodable: true, aacPolyfillAvailable: false }),
    ).toEqual({
      kind: "encode",
      codec: "aac",
    });
  });

  it("falls back to the polyfill when AAC is not natively encodable", () => {
    const manifest = manifestWith({
      timemap: {
        sourceDurationMs: 10_000,
        edits: [{ kind: "cut", startMs: 0, endMs: 500 }],
        snapCutsToFrames: false,
      },
    });
    expect(
      decideAudioStrategy({ manifest, aacEncodable: false, aacPolyfillAvailable: true }),
    ).toEqual({
      kind: "polyfill",
      codec: "aac",
    });
  });

  it("requires the cloud when neither native AAC nor the polyfill is available", () => {
    const manifest = manifestWith({
      timemap: {
        sourceDurationMs: 10_000,
        edits: [{ kind: "cut", startMs: 0, endMs: 500 }],
        snapCutsToFrames: false,
      },
    });
    const decision = decideAudioStrategy({
      manifest,
      aacEncodable: false,
      aacPolyfillAvailable: false,
    });
    expect(decision.kind).toBe("cloud-required");
  });

  it("reports none when the manifest carries no audio track", () => {
    const manifest = manifestWith({ audio: { strategy: "none", codec: "aac", bitrateKbps: 192 } });
    expect(
      decideAudioStrategy({ manifest, aacEncodable: true, aacPolyfillAvailable: true }),
    ).toEqual({
      kind: "none",
    });
  });

  it("requires the cloud for a non-AAC codec request", () => {
    const manifest = manifestWith({
      audio: { strategy: "replace", cleanKey: "k", codec: "opus", bitrateKbps: 192 },
    });
    const decision = decideAudioStrategy({
      manifest,
      aacEncodable: true,
      aacPolyfillAvailable: true,
    });
    expect(decision.kind).toBe("cloud-required");
  });
});
