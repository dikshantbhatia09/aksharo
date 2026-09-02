import { describe, expect, it } from "vitest";

import { RenderError } from "./errors.js";
import {
  assertCanvas,
  blurRadiusToSigma,
  clamp,
  clamp01,
  COORDINATE_DECIMALS,
  ofCanvasHeight,
  ofCanvasWidth,
  ofFontSize,
  q,
  qRect,
} from "./units.js";

describe("relative sizing", () => {
  it("reads type size off the canvas height, never the width", () => {
    expect(ofCanvasHeight(6.4, { width: 1080, height: 1920 })).toBeCloseTo(122.88, 5);
    expect(ofCanvasHeight(6.4, { width: 1920, height: 1080 })).toBeCloseTo(69.12, 5);
  });

  it("reads the caption's own width off the canvas width", () => {
    expect(ofCanvasWidth(86, { width: 1080, height: 1920 })).toBeCloseTo(928.8, 5);
  });

  it("reads stroke, shadow and padding off the type size", () => {
    expect(ofFontSize(9, 100)).toBeCloseTo(9, 5);
    expect(ofFontSize(0, 100)).toBe(0);
  });

  it("scales a document identically at 1080p and at the 540p proxy", () => {
    const master = ofCanvasHeight(6.4, { width: 1080, height: 1920 });
    const proxy = ofCanvasHeight(6.4, { width: 540, height: 960 });
    expect(master / proxy).toBeCloseTo(2, 10);
  });
});

describe("assertCanvas", () => {
  it("returns a valid canvas unchanged", () => {
    const canvas = { width: 1080, height: 1920 };
    expect(assertCanvas(canvas)).toBe(canvas);
  });

  it.each([
    { width: 0, height: 100 },
    { width: 100, height: -1 },
    { width: Number.NaN, height: 100 },
    { width: Number.POSITIVE_INFINITY, height: 100 },
  ])("rejects %o", (canvas) => {
    expect(() => assertCanvas(canvas)).toThrow(RenderError);
  });
});

describe("blurRadiusToSigma", () => {
  it("matches Skia's own conversion", () => {
    expect(blurRadiusToSigma(10)).toBeCloseTo(10 * 0.57735 + 0.5, 9);
  });

  it("is zero for a zero or negative radius", () => {
    expect(blurRadiusToSigma(0)).toBe(0);
    expect(blurRadiusToSigma(-4)).toBe(0);
  });
});

describe("clamp", () => {
  it("clamps into range", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it("collapses NaN to the minimum rather than propagating it", () => {
    expect(clamp(Number.NaN, 3, 9)).toBe(3);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("quantisation", () => {
  it("rounds to the documented number of decimals", () => {
    expect(COORDINATE_DECIMALS).toBe(3);
    expect(q(1.000_49)).toBe(1);
    expect(q(1.000_51)).toBe(1.001);
  });

  it("normalises negative zero so two runs hash the same", () => {
    expect(Object.is(q(-0), 0)).toBe(true);
    expect(Object.is(q(-0.000_1), 0)).toBe(true);
  });

  it("refuses a non-finite coordinate instead of writing NaN into a command", () => {
    expect(() => q(Number.NaN)).toThrow(RenderError);
    expect(() => q(Number.POSITIVE_INFINITY)).toThrow(/not finite/);
  });

  it("quantises a whole rectangle", () => {
    expect(qRect(1.0001, 2.0006, 3, 4)).toEqual([1, 2.001, 3, 4]);
  });
});
