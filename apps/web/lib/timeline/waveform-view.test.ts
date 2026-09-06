import { describe, expect, it } from "vitest";

import { reduceWaveform, waveformDrawWindow, type WaveformLike } from "./waveform-view";

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

describe("waveformDrawWindow", () => {
  // A 20s clip at the default 30 ms/px zoom on a 2000px canvas shows up to
  // 60s of ruler — exactly the "viewport wider than the media" case issue #4
  // reported (waveform drawn well past the 20s mark).
  const viewport = { scrollMs: 0, msPerPx: 30, widthPx: 2_000 };

  it("bounds the drawn width to the media's duration, not the full canvas", () => {
    const window = waveformDrawWindow(viewport, 20_000, { startMs: 0, endMs: 60_000 });
    expect(window).toBeDefined();
    // 20_000ms / 30ms-per-px = 666.67px, rounded up to cover the last partial pixel.
    expect(window?.pxStart).toBe(0);
    expect(window?.widthPx).toBe(667);
    expect(window?.widthPx).toBeLessThan(viewport.widthPx);
  });

  it("draws full width when the visible range already sits inside the duration", () => {
    // A long video, scrolled into the middle (scrollMs matches the visible
    // window's own start, as `visibleRange` always produces): nothing here
    // should clamp.
    const scrolledIn = { scrollMs: 10_000, msPerPx: 30, widthPx: 2_000 };
    const window = waveformDrawWindow(scrolledIn, 3_600_000, { startMs: 10_000, endMs: 70_000 });
    expect(window?.pxStart).toBe(0);
    expect(window?.widthPx).toBe(2_000);
    expect(window?.startMs).toBe(10_000);
    expect(window?.endMs).toBe(70_000);
  });

  it("offsets pxStart when scrolled so the visible range starts after 0", () => {
    const scrolled = { scrollMs: 6_000, msPerPx: 30, widthPx: 2_000 };
    const window = waveformDrawWindow(scrolled, 20_000, { startMs: 6_000, endMs: 66_000 });
    expect(window?.pxStart).toBe(0);
    // Remaining duration from 6s to 20s = 14_000ms / 30ms-per-px.
    expect(window?.widthPx).toBe(Math.ceil(14_000 / 30));
  });

  it("returns undefined once the visible range has scrolled entirely past the duration", () => {
    const window = waveformDrawWindow(viewport, 20_000, { startMs: 25_000, endMs: 85_000 });
    expect(window).toBeUndefined();
  });

  it("returns undefined for a zero or negative duration (no media loaded yet)", () => {
    expect(waveformDrawWindow(viewport, 0, { startMs: 0, endMs: 60_000 })).toBeUndefined();
  });
});
