import { describe, expect, it } from "vitest";

import { fixtureManifest } from "@montaj/render-manifest/testing";

import { computeAudioParity } from "./audio-parity";

const CLEAN_KEY = "clean/01JA20SNDTRACK000000000000.wav";
const SIGNED_URL = "https://storage.example.test/clean/01JA20SNDTRACK000000000000.wav?sig=abc";

/** A tiny fake object store keyed by storage key, standing in for R2/S3. */
function store(objects: Record<string, Uint8Array>) {
  return {
    async resolveCloudSource(key: string): Promise<Uint8Array> {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const bytes = objects[key];
      if (bytes === undefined) throw new Error(`no object at ${key}`);
      return bytes;
    },
    async fetchBrowserSource(url: string): Promise<Uint8Array> {
      // The browser fetches by signed URL; this fake resolves it back to the
      // same key the signer started from (as a real signed-URL scheme would).
      const key = url === SIGNED_URL ? CLEAN_KEY : undefined;
      if (key === undefined) throw new Error(`no object signed for ${url}`);
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const bytes = objects[key];
      if (bytes === undefined) throw new Error(`no object at ${key}`);
      return bytes;
    },
  };
}

describe("computeAudioParity", () => {
  it("is vacuously a match when the manifest does not replace audio", async () => {
    const manifest = fixtureManifest({ audio: { strategy: "passthrough" } });
    const result = await computeAudioParity({
      manifest,
      cleanedAudioUrl: SIGNED_URL,
      ...store({}),
    });
    expect(result).toEqual({ strategy: "passthrough", skipped: true, match: true });
  });

  it("matches when both lanes resolve the same object key to the same bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const manifest = fixtureManifest({ audio: { strategy: "replace", cleanKey: CLEAN_KEY } });

    const result = await computeAudioParity({
      manifest,
      cleanedAudioUrl: SIGNED_URL,
      ...store({ [CLEAN_KEY]: bytes }),
    });

    expect(result.skipped).toBe(false);
    expect(result.match).toBe(true);
    expect(result.browserHash).toBe(result.cloudHash);
    expect(result.byteLength).toBe(bytes.byteLength);
  });

  it("catches the two lanes drifting onto different bytes for the same key", async () => {
    const manifest = fixtureManifest({ audio: { strategy: "replace", cleanKey: CLEAN_KEY } });

    const result = await computeAudioParity({
      manifest,
      cleanedAudioUrl: SIGNED_URL,
      resolveCloudSource: () => Promise.resolve(new Uint8Array([9, 9, 9])),
      fetchBrowserSource: () => Promise.resolve(new Uint8Array([1, 1, 1])),
    });

    expect(result.skipped).toBe(false);
    expect(result.match).toBe(false);
    expect(result.browserHash).not.toBe(result.cloudHash);
  });

  it("refuses a replace strategy with no cleanKey rather than silently skipping", async () => {
    const manifest = fixtureManifest({ audio: { strategy: "replace", cleanKey: undefined } });
    await expect(
      computeAudioParity({ manifest, cleanedAudioUrl: SIGNED_URL, ...store({}) }),
    ).rejects.toThrow(/no cleanKey/);
  });
});
