import { describe, expect, it } from "vitest";

import {
  clampCropRect,
  cropRectFromCentre,
  cropRectFromZoom,
  FULL_FRAME,
  sampleCropWindow,
  type CropKeyframe,
} from "./crop-window.js";

describe("sampleCropWindow", () => {
  it("returns null with no keyframes: caller draws the full frame", () => {
    expect(sampleCropWindow([], 1000)).toBeNull();
  });

  it("holds the single keyframe's rect for its whole life", () => {
    const kf: CropKeyframe[] = [{ tMs: 500, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }];
    expect(sampleCropWindow(kf, 0)).toEqual(kf[0]?.rect);
    expect(sampleCropWindow(kf, 10_000)).toEqual(kf[0]?.rect);
  });

  it("linearly interpolates between two keyframes", () => {
    const kf: CropKeyframe[] = [
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, easing: "linear" },
      { tMs: 1000, rect: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } },
    ];
    const mid = sampleCropWindow(kf, 500);
    expect(mid?.x).toBeCloseTo(0.1, 5);
    expect(mid?.w).toBeCloseTo(0.8, 5);
  });

  it("holds before the first and after the last keyframe", () => {
    const kf: CropKeyframe[] = [
      { tMs: 1000, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { tMs: 2000, rect: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 } },
    ];
    expect(sampleCropWindow(kf, 0)).toEqual(kf[0]?.rect);
    expect(sampleCropWindow(kf, 5000)).toEqual(kf[1]?.rect);
  });

  it("eases with easeInOutCubic when the segment names it", () => {
    const kf: CropKeyframe[] = [
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, easing: "easeInOutCubic" },
      { tMs: 1000, rect: { x: 1, y: 0, w: 0, h: 0 } },
    ];
    const early = sampleCropWindow(kf, 100);
    const linearEquivalent = 0.1;
    // easeInOutCubic is slower than linear near the edges of the curve.
    expect(early?.x ?? 0).toBeLessThan(linearEquivalent);
  });

  it("clamps a rectangle that would run off the frame", () => {
    const clamped = clampCropRect({ x: 0.9, y: -0.2, w: 0.3, h: 0.3 });
    expect(clamped.x).toBeCloseTo(0.7, 5);
    expect(clamped.y).toBeCloseTo(0, 5);
  });

  it("FULL_FRAME is the identity window", () => {
    expect(FULL_FRAME).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("cropRectFromZoom", () => {
  it("shrinks the window as scale grows, centred on the target", () => {
    const target = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const rect = cropRectFromZoom(target, 2);
    expect(rect.w).toBeCloseTo(0.5, 5);
    expect(rect.h).toBeCloseTo(0.5, 5);
    expect(rect.x + rect.w / 2).toBeCloseTo(0.5, 5);
    expect(rect.y + rect.h / 2).toBeCloseTo(0.5, 5);
  });

  it("scale 1 is the full-frame window (no zoom)", () => {
    const rect = cropRectFromZoom({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 1);
    expect(rect.w).toBeCloseTo(1, 5);
    expect(rect.h).toBeCloseTo(1, 5);
  });
});

describe("cropRectFromCentre", () => {
  it("builds a window centred at (cx, cy) sized 1/zoom, B19's Keyframe shape", () => {
    const rect = cropRectFromCentre(0.4, 0.4, 2);
    expect(rect.w).toBeCloseTo(0.5, 5);
    expect(rect.h).toBeCloseTo(0.5, 5);
    expect(rect.x).toBeCloseTo(0.15, 5);
    expect(rect.y).toBeCloseTo(0.15, 5);
  });

  it("zoom 1 is the full frame", () => {
    const rect = cropRectFromCentre(0.5, 0.5, 1);
    expect(rect.w).toBeCloseTo(1, 5);
  });

  it("clamps a centre near the edge so the window stays inside [0,1]", () => {
    const rect = cropRectFromCentre(0.95, 0.05, 3);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
  });
});
