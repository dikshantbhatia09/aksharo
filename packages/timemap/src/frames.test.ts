import { describe, expect, it } from "vitest";

import { isTimeMapError } from "./errors.js";
import { frameAt, frameDurationMs, snapToFrame } from "./frames.js";

describe("frameDurationMs", () => {
  it("is exact for integer rates and fractional for broadcast rates", () => {
    expect(frameDurationMs(25)).toBe(40);
    expect(frameDurationMs(50)).toBe(20);
    expect(frameDurationMs(30000 / 1001)).toBeCloseTo(33.3667, 4);
  });

  it("rejects a rate that is not a finite number in (0, 1000]", () => {
    for (const fps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1001]) {
      expect(() => frameDurationMs(fps)).toThrowError(
        expect.objectContaining({ name: "TimeMapError" }),
      );
    }
    try {
      frameDurationMs(0);
    } catch (error) {
      expect(isTimeMapError(error, "invalid-fps")).toBe(true);
    }
  });
});

describe("frameAt", () => {
  it("counts frames from zero", () => {
    expect(frameAt(0, 25)).toBe(0);
    expect(frameAt(39, 25)).toBe(0);
    expect(frameAt(40, 25)).toBe(1);
    expect(frameAt(1000, 25)).toBe(25);
  });
});

describe("snapToFrame", () => {
  it("rounds to the nearest boundary by default", () => {
    expect(snapToFrame(0, 25)).toBe(0);
    expect(snapToFrame(19, 25)).toBe(0);
    expect(snapToFrame(21, 25)).toBe(40);
    expect(snapToFrame(1000, 25)).toBe(1000);
  });

  it("floors and ceils on request", () => {
    expect(snapToFrame(39, 25, "floor")).toBe(0);
    expect(snapToFrame(39, 25, "ceil")).toBe(40);
    expect(snapToFrame(40, 25, "floor")).toBe(40);
    expect(snapToFrame(40, 25, "ceil")).toBe(40);
  });

  it("uses the exact rate for 29.97 and 23.976", () => {
    const ntsc = 30000 / 1001;
    expect(snapToFrame(1001, ntsc)).toBe(1001);
    expect(snapToFrame(1000, ntsc)).toBe(1001);
    expect(snapToFrame(0, ntsc)).toBe(0);
    const film = 24000 / 1001;
    expect(snapToFrame(2085, film)).toBe(2085);
  });

  it("keeps whole seconds on the grid despite binary-float noise", () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      for (const seconds of [1, 7, 60, 3600]) {
        expect(snapToFrame(seconds * 1000, fps)).toBe(seconds * 1000);
      }
    }
  });

  it("rejects a non-finite time", () => {
    expect(() => snapToFrame(Number.NaN, 25)).toThrowError(
      expect.objectContaining({ name: "TimeMapError" }),
    );
  });
});
