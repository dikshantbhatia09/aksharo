import { describe, expect, it } from "vitest";

import {
  clampMsPerPx,
  clampScroll,
  MAX_MS_PER_PX,
  MIN_MS_PER_PX,
  msToPx,
  pxToMs,
  ruleTicks,
  tickStepMs,
  visibleRange,
  zoomAround,
} from "./coords";

describe("clampMsPerPx", () => {
  it("clamps into [MIN, MAX]", () => {
    expect(clampMsPerPx(0.1)).toBe(MIN_MS_PER_PX);
    expect(clampMsPerPx(10_000)).toBe(MAX_MS_PER_PX);
    expect(clampMsPerPx(100)).toBe(100);
  });
  it("falls back to MIN for non-finite or non-positive input", () => {
    expect(clampMsPerPx(0)).toBe(MIN_MS_PER_PX);
    expect(clampMsPerPx(-5)).toBe(MIN_MS_PER_PX);
    expect(clampMsPerPx(NaN)).toBe(MIN_MS_PER_PX);
  });
});

describe("msToPx / pxToMs", () => {
  const viewport = { scrollMs: 1000, msPerPx: 10, widthPx: 800 };
  it("round-trips", () => {
    for (const ms of [0, 500, 1000, 5000, 12345]) {
      const px = msToPx(ms, viewport);
      expect(pxToMs(px, viewport)).toBeCloseTo(ms, 6);
    }
  });
  it("scrollMs maps to px 0", () => {
    expect(msToPx(viewport.scrollMs, viewport)).toBe(0);
  });
});

describe("visibleRange", () => {
  it("covers the viewport plus padding", () => {
    const viewport = { scrollMs: 1000, msPerPx: 10, widthPx: 100 };
    const range = visibleRange(viewport, 20);
    expect(range.startMs).toBe(800);
    expect(range.endMs).toBe(1000 + 1200);
  });
  it("never returns a negative startMs", () => {
    const viewport = { scrollMs: 0, msPerPx: 10, widthPx: 100 };
    const range = visibleRange(viewport, 50);
    expect(range.startMs).toBe(0);
  });
});

describe("clampScroll", () => {
  it("clamps to [0, duration - viewportSpan]", () => {
    const viewport = { msPerPx: 10, widthPx: 100 }; // 1000ms span
    expect(clampScroll(-500, viewport, 5000)).toBe(0);
    expect(clampScroll(10_000, viewport, 5000)).toBe(4000);
    expect(clampScroll(2000, viewport, 5000)).toBe(2000);
  });
  it("never goes negative even when duration < viewport span", () => {
    const viewport = { msPerPx: 10, widthPx: 100 };
    expect(clampScroll(500, viewport, 100)).toBe(0);
  });
});

describe("zoomAround", () => {
  it("keeps the anchor time fixed under the anchor pixel", () => {
    const state = { msPerPx: 100, scrollMs: 1000 };
    const anchorPx = 50;
    const anchorMs = state.scrollMs + anchorPx * state.msPerPx; // 6000
    const zoomed = zoomAround(state, anchorPx, "in");
    const anchorMsAfter = zoomed.scrollMs + anchorPx * zoomed.msPerPx;
    expect(anchorMsAfter).toBeCloseTo(anchorMs, 6);
    expect(zoomed.msPerPx).toBeLessThan(state.msPerPx);
  });
  it("zooming out increases msPerPx and clamps at MAX", () => {
    const state = { msPerPx: MAX_MS_PER_PX, scrollMs: 0 };
    const zoomed = zoomAround(state, 0, "out");
    expect(zoomed.msPerPx).toBe(MAX_MS_PER_PX);
  });
  it("zooming in clamps at MIN", () => {
    const state = { msPerPx: MIN_MS_PER_PX, scrollMs: 0 };
    const zoomed = zoomAround(state, 0, "in");
    expect(zoomed.msPerPx).toBe(MIN_MS_PER_PX);
  });
});

describe("tickStepMs / ruleTicks", () => {
  it("picks a bigger step as msPerPx grows", () => {
    const fine = tickStepMs(1);
    const coarse = tickStepMs(1000);
    expect(coarse).toBeGreaterThan(fine);
  });
  it("produces ticks aligned to the step, within range", () => {
    const ticks = ruleTicks(0, 10_000, 20, 80); // minStep = 1600 -> step 2000
    expect(tickStepMs(20, 80)).toBe(2000);
    expect(ticks).toEqual([0, 2000, 4000, 6000, 8000, 10000]);
  });
});
