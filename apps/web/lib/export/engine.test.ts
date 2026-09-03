import { describe, expect, it } from "vitest";

import type { RenderManifest } from "@montaj/render-manifest";
import { fixtureManifest } from "@montaj/render-manifest/testing";

import {
  applySfxDucking,
  applySpliceFades,
  dbToLinear,
  decodeSfxCues,
  duckGainAt,
  retainedSourceRangesMs,
  SFX_DUCK_DB,
  SFX_DUCK_RAMP_MS,
  SPLICE_FADE_MS,
} from "./engine";

/** A minimal duck-typed stand-in for `AudioBuffer` — Node has no such global. */
function fakeAudioBuffer(samples: number, sampleRate: number, value = 1): AudioBuffer {
  const data = new Float32Array(samples).fill(value);
  return {
    length: samples,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

describe("retainedSourceRangesMs", () => {
  it("returns the whole range when there are no cuts", () => {
    expect(retainedSourceRangesMs(10_000, [])).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });

  it("removes a single cut in the middle", () => {
    expect(retainedSourceRangesMs(10_000, [{ kind: "cut", startMs: 2_000, endMs: 3_000 }])).toEqual(
      [
        { startMs: 0, endMs: 2_000 },
        { startMs: 3_000, endMs: 10_000 },
      ],
    );
  });

  it("merges overlapping and touching cuts", () => {
    expect(
      retainedSourceRangesMs(10_000, [
        { kind: "cut", startMs: 2_000, endMs: 3_500 },
        { kind: "cut", startMs: 3_000, endMs: 4_000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 2_000 },
      { startMs: 4_000, endMs: 10_000 },
    ]);
  });

  it("drops a leading cut down to zero and a trailing cut to the end", () => {
    expect(
      retainedSourceRangesMs(10_000, [
        { kind: "cut", startMs: 0, endMs: 1_000 },
        { kind: "cut", startMs: 9_000, endMs: 10_000 },
      ]),
    ).toEqual([{ startMs: 1_000, endMs: 9_000 }]);
  });

  it("clamps a cut that runs past the source duration", () => {
    expect(
      retainedSourceRangesMs(10_000, [{ kind: "cut", startMs: 8_000, endMs: 12_000 }]),
    ).toEqual([{ startMs: 0, endMs: 8_000 }]);
  });

  it("returns nothing retained when a single cut covers the whole source", () => {
    expect(retainedSourceRangesMs(10_000, [{ kind: "cut", startMs: 0, endMs: 10_000 }])).toEqual(
      [],
    );
  });

  it("ignores non-cut edits (speed/hold), which the caller refuses before calling this", () => {
    expect(
      retainedSourceRangesMs(10_000, [
        { kind: "speed", startMs: 1_000, endMs: 2_000, factor: 2 },
        { kind: "cut", startMs: 5_000, endMs: 6_000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 5_000 },
      { startMs: 6_000, endMs: 10_000 },
    ]);
  });
});

describe("applySpliceFades (A19c brief §4: 5ms splice fades at cut boundaries)", () => {
  const SAMPLE_RATE = 48_000;

  it("is a no-op when neither fade applies", () => {
    const buffer = fakeAudioBuffer(100, SAMPLE_RATE);
    applySpliceFades(buffer, 1_000, 5_000, 0, 0);
    expect([...buffer.getChannelData(0)]).toEqual(new Array<number>(100).fill(1));
  });

  it("ramps a chunk at the very start of a range from 0 to 1 over the fade-in window", () => {
    const samples = Math.round((SPLICE_FADE_MS / 1000) * SAMPLE_RATE) * 2; // spans past the fade window
    const buffer = fakeAudioBuffer(samples, SAMPLE_RATE);
    applySpliceFades(buffer, 0, 10_000, SPLICE_FADE_MS, 0);
    const data = buffer.getChannelData(0);
    expect(data[0]).toBeCloseTo(0, 5);
    // Past the fade window, the gain is back to full.
    expect(data[samples - 1]).toBeCloseTo(1, 5);
    // Monotonically non-decreasing through the ramp.
    for (let i = 1; i < samples; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      expect(data[i]).toBeGreaterThanOrEqual(data[i - 1] ?? 0);
    }
  });

  it("ramps a chunk at the very end of a range from 1 down to 0 over the fade-out window", () => {
    const rangeDurationMs = 1_000;
    const fadeSamples = Math.round((SPLICE_FADE_MS / 1000) * SAMPLE_RATE);
    const chunkStartMs = rangeDurationMs - (fadeSamples / SAMPLE_RATE) * 1000;
    const buffer = fakeAudioBuffer(fadeSamples, SAMPLE_RATE);
    applySpliceFades(buffer, chunkStartMs, rangeDurationMs, 0, SPLICE_FADE_MS);
    const data = buffer.getChannelData(0);
    expect(data[0]).toBeCloseTo(1, 1);
    expect(data[fadeSamples - 1]).toBeCloseTo(0, 1);
  });

  it("leaves a chunk in the steady middle of a range untouched", () => {
    const buffer = fakeAudioBuffer(100, SAMPLE_RATE, 0.5);
    applySpliceFades(buffer, 5_000, 10_000, SPLICE_FADE_MS, SPLICE_FADE_MS);
    expect([...buffer.getChannelData(0)]).toEqual(new Array<number>(100).fill(0.5));
  });

  it("does not fade the outer edge of the very first or very last retained range (fadeIn/fadeOut = 0)", () => {
    const buffer = fakeAudioBuffer(100, SAMPLE_RATE);
    // rangeIndex === 0 -> fadeInMs 0; rangeIndex === last -> fadeOutMs 0, per engine.ts's call site.
    applySpliceFades(buffer, 0, 10_000, 0, 0);
    expect([...buffer.getChannelData(0)]).toEqual(new Array<number>(100).fill(1));
  });
});

describe("duckGainAt (D04a: -12dB SFX duck under speech, 150ms ramps)", () => {
  it("is unity gain far from every speech range", () => {
    expect(duckGainAt(10_000, [{ startMs: 1_000, endMs: 2_000 }])).toBe(1);
  });

  it("is unity gain with no speech ranges at all", () => {
    expect(duckGainAt(1_500, [])).toBe(1);
  });

  it("reaches the full duck at the centre of a range at least 2*rampMs long", () => {
    const gain = duckGainAt(1_500, [{ startMs: 1_000, endMs: 2_000 }]);
    expect(gain).toBeCloseTo(dbToLinear(SFX_DUCK_DB), 5);
  });

  it("ramps down linearly on approach to a range's start", () => {
    const range = [{ startMs: 1_000, endMs: 2_000 }];
    const halfwayIn = duckGainAt(1_000 - SFX_DUCK_RAMP_MS / 2, range);
    const atEdge = duckGainAt(1_000, range);
    const beforeRamp = duckGainAt(1_000 - SFX_DUCK_RAMP_MS - 1, range);
    expect(beforeRamp).toBe(1);
    expect(halfwayIn).toBeLessThan(1);
    expect(halfwayIn).toBeGreaterThan(atEdge);
  });

  it("ramps back up linearly leaving a range's end", () => {
    const range = [{ startMs: 1_000, endMs: 2_000 }];
    const atEdge = duckGainAt(2_000, range);
    const halfwayOut = duckGainAt(2_000 + SFX_DUCK_RAMP_MS / 2, range);
    const afterRamp = duckGainAt(2_000 + SFX_DUCK_RAMP_MS + 1, range);
    expect(halfwayOut).toBeGreaterThan(atEdge);
    expect(afterRamp).toBe(1);
  });

  it("never overshoots past the duck floor in a very short speech range", () => {
    const gain = duckGainAt(1_010, [{ startMs: 1_000, endMs: 1_020 }]);
    expect(gain).toBeGreaterThanOrEqual(dbToLinear(SFX_DUCK_DB) - 1e-9);
  });

  it("takes the deepest duck when speech ranges overlap", () => {
    const gain = duckGainAt(1_500, [
      { startMs: 1_000, endMs: 2_000 },
      { startMs: 1_400, endMs: 1_600 },
    ]);
    expect(gain).toBeCloseTo(dbToLinear(SFX_DUCK_DB), 5);
  });
});

describe("applySfxDucking (D04a)", () => {
  const SAMPLE_RATE = 48_000;

  it("is a no-op with no speech ranges", () => {
    const buffer = fakeAudioBuffer(100, SAMPLE_RATE);
    applySfxDucking(buffer, 0, []);
    expect([...buffer.getChannelData(0)]).toEqual(new Array<number>(100).fill(1));
  });

  it("attenuates samples that fall inside a speech range toward the duck floor", () => {
    const buffer = fakeAudioBuffer(SAMPLE_RATE, SAMPLE_RATE); // 1000ms of samples
    applySfxDucking(buffer, 0, [{ startMs: 200, endMs: 800 }]); // long enough to reach the floor
    const data = buffer.getChannelData(0);
    const centreIndex = Math.round(0.5 * SAMPLE_RATE);
    // eslint-disable-next-line security/detect-object-injection -- centreIndex is a bounded numeric index derived from a fixed sample rate, not attacker-controlled -- reviewed for D04a
    expect(data[centreIndex]).toBeCloseTo(dbToLinear(SFX_DUCK_DB), 3);
    expect(data[0]).toBe(1);
  });
});

describe("decodeSfxCues (D04e-2: browser cue mixer wiring)", () => {
  function manifestWithSfx(overrides: Parameters<typeof fixtureManifest>[0] = {}): RenderManifest {
    const unsigned = fixtureManifest({
      timemap: {
        sourceDurationMs: 10_000,
        edits: [],
        snapCutsToFrames: false,
        audio: {
          sfx: [
            {
              itemId: "01JD04ECFX0000000000000000",
              startMs: 1_000,
              endMs: 1_500,
              assetId: "fixture-ding",
              packId: "fixture",
              storageKey: "packs/fixture/ding.wav",
              gainDb: 0,
              fadeInMs: 10,
              fadeOutMs: 10,
              duck: null,
            },
          ],
        },
      },
      ...overrides,
    });
    return unsigned as unknown as RenderManifest;
  }

  it("returns an empty array without requiring fetchCueAsset when the manifest carries no sfx cues", async () => {
    const manifest = fixtureManifest() as unknown as RenderManifest;
    const cues = await decodeSfxCues(manifest, undefined, () => {
      throw new Error("should not decode when there is nothing to decode");
    });
    expect(cues).toEqual([]);
  });

  it("throws when the manifest carries accepted sfx cues but no fetchCueAsset was supplied", async () => {
    const manifest = manifestWithSfx();
    await expect(
      decodeSfxCues(manifest, undefined, () => {
        throw new Error("unreachable");
      }),
    ).rejects.toThrow(/fetchCueAsset/);
  });

  it("fetches and decodes each track's asset, carrying every manifest field through", async () => {
    const manifest = manifestWithSfx();
    const fakeBuffer = { length: 100, sampleRate: 48_000, numberOfChannels: 1 } as AudioBuffer;
    const fetched: string[] = [];
    const cues = await decodeSfxCues(
      manifest,
      (assetId) => {
        fetched.push(assetId);
        return Promise.resolve(new Uint8Array([1, 2, 3]));
      },
      () => Promise.resolve(fakeBuffer),
    );
    expect(fetched).toEqual(["fixture-ding"]);
    expect(cues).toEqual([
      {
        itemId: "01JD04ECFX0000000000000000",
        startMs: 1_000,
        endMs: 1_500,
        gainDb: 0,
        fadeInMs: 10,
        fadeOutMs: 10,
        duck: null,
        buffer: fakeBuffer,
      },
    ]);
  });

  it("fetches an asset only once even when two accepted cues share it", async () => {
    const manifest = manifestWithSfx({
      timemap: {
        sourceDurationMs: 10_000,
        edits: [],
        snapCutsToFrames: false,
        audio: {
          sfx: [
            {
              itemId: "01JD04ECFX0000000000000000",
              startMs: 1_000,
              endMs: 1_500,
              assetId: "fixture-ding",
              packId: "fixture",
              storageKey: "packs/fixture/ding.wav",
              gainDb: 0,
              fadeInMs: 0,
              fadeOutMs: 0,
              duck: null,
            },
            {
              itemId: "01JD04ECF20000000000000000",
              startMs: 3_000,
              endMs: 3_500,
              assetId: "fixture-ding",
              packId: "fixture",
              storageKey: "packs/fixture/ding.wav",
              gainDb: -6,
              fadeInMs: 0,
              fadeOutMs: 0,
              duck: null,
            },
          ],
        },
      },
    });
    const fakeBuffer = { length: 100, sampleRate: 48_000, numberOfChannels: 1 } as AudioBuffer;
    let fetchCount = 0;
    const cues = await decodeSfxCues(
      manifest,
      () => {
        fetchCount += 1;
        return Promise.resolve(new Uint8Array([1]));
      },
      () => Promise.resolve(fakeBuffer),
    );
    expect(fetchCount).toBe(1);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.buffer).toBe(cues[1]?.buffer);
  });
});
