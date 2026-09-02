import { describe, expect, it } from "vitest";

import {
  contrastingInk,
  formatColour,
  luminance,
  mixColours,
  normaliseColour,
  parseColour,
  setAlpha,
  withAlpha,
} from "./colour.js";
import { RenderError } from "./errors.js";

describe("parseColour", () => {
  it("reads six- and eight-digit hex", () => {
    expect(parseColour("#ff2e63")).toEqual({ r: 255, g: 46, b: 99, a: 1 });
    expect(parseColour("#ffffff66").a).toBeCloseTo(0x66 / 255, 6);
  });

  it("accepts upper case", () => {
    expect(parseColour("#FF2E63")).toEqual(parseColour("#ff2e63"));
  });

  it.each(["ff2e63", "#fff", "#ff2e6", "#ff2e63ffff", "rgb(1,2,3)"])("rejects %s", (colour) => {
    expect(() => parseColour(colour)).toThrow(RenderError);
  });
});

describe("normaliseColour", () => {
  it("always produces eight digits so hashes are stable", () => {
    expect(normaliseColour("#ff2e63")).toBe("#ff2e63ff");
    expect(normaliseColour("#FF2E6380")).toBe("#ff2e6380");
  });
});

describe("alpha", () => {
  it("multiplies an existing alpha rather than replacing it", () => {
    expect(withAlpha("#ffffff80", 0.5)).toBe(formatColour({ r: 255, g: 255, b: 255, a: (0x80 / 255) * 0.5 }));
  });

  it("replaces the alpha outright when asked", () => {
    expect(setAlpha("#ffffff80", 1)).toBe("#ffffffff");
    expect(setAlpha("#ffffffff", 0)).toBe("#ffffff00");
  });

  it("clamps out-of-range alphas", () => {
    expect(withAlpha("#ffffffff", 5)).toBe("#ffffffff");
    expect(setAlpha("#ffffffff", -2)).toBe("#ffffff00");
  });
});

describe("mixColours", () => {
  it("interpolates each channel", () => {
    expect(mixColours("#000000", "#ffffff", 0.5)).toBe("#808080ff");
  });

  it("clamps the parameter", () => {
    expect(mixColours("#000000", "#ffffff", -1)).toBe("#000000ff");
    expect(mixColours("#000000", "#ffffff", 2)).toBe("#ffffffff");
  });
});

describe("luminance and contrast", () => {
  it("ranks white above black", () => {
    expect(luminance("#ffffff")).toBeGreaterThan(luminance("#000000"));
  });

  it("picks ink that reads on the ground", () => {
    expect(contrastingInk("#ffe14d")).toBe("#000000ff");
    expect(contrastingInk("#101018")).toBe("#ffffffff");
  });
});
