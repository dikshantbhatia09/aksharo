import { describe, expect, it } from "vitest";

import { reduceWaveform, type WaveformLike } from "./waveform-view";

function makeWaveform(): WaveformLike {
  // 10s of audio: peaks at 100/s (1000 samples), rms at 10/s (100 samples).
  const peaks = Array.from({ length: 1000 }, (_, i) => (i % 100) / 100);
  const rms = Array.from({ length: 100 }, (_, i) => (i % 10) / 10);
  return { peakRate: 100, peaks, rms: { rate: 10, values: rms }, durationMs: 10_000 };
}

describe("reduceWaveform", () => {
  it("returns exactly widthPx buckets", () => {
    const waveform = makeWaveform();
    const buckets = reduceWaveform(waveform, 0, 10_000, 400);
    expect(buckets).toHaveLength(400);
  });

  it("returns an empty array for a degenerate range", () => {
    const waveform = makeWaveform();
    expect(reduceWaveform(waveform, 1000, 1000, 100)).toEqual([]);
    expect(reduceWaveform(waveform, 0, 10_000, 0)).toEqual([]);
  });

  it("each bucket amplitude stays within [0, 1]", () => {
    const waveform = makeWaveform();
    const buckets = reduceWaveform(waveform, 0, 10_000, 50);
    for (const bucket of buckets) {
      expect(bucket.peak).toBeGreaterThanOrEqual(0);
      expect(bucket.peak).toBeLessThanOrEqual(1);
      expect(bucket.energy).toBeGreaterThanOrEqual(0);
      expect(bucket.energy).toBeLessThanOrEqual(1);
    }
  });

  it("zoomed in past sample resolution still returns one value per pixel (nearest sample)", () => {
    const waveform = makeWaveform();
    // 100 pixels covering just 10ms — far below the 10ms-per-peak-sample resolution.
    const buckets = reduceWaveform(waveform, 0, 10, 100);
    expect(buckets).toHaveLength(100);
    expect(buckets.every((b) => Number.isFinite(b.peak))).toBe(true);
  });

  it("draw-call count (bucket count) equals the viewport width regardless of source length", () => {
    const waveform: WaveformLike = {
      peakRate: 100,
      // 3 hours of peaks: 3*3600*100 = 1,080,000 samples.
      peaks: new Array(1_080_000).fill(0.5),
      rms: { rate: 10, values: new Array(108_000).fill(0.3) },
      durationMs: 3 * 3600 * 1000,
    };
    const buckets = reduceWaveform(waveform, 0, waveform.durationMs, 1920);
    expect(buckets).toHaveLength(1920);
  });
});
