import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESET_BY_INTENT,
  TEXT_FX_MOTION_PRESETS,
  textFxPhase,
  textFxProgress,
} from "./presets.js";

describe("textFxProgress", () => {
  it("is 0 before the item starts and 1 at/after it ends", () => {
    expect(textFxProgress(0, 1000, 3000)).toBe(0);
    expect(textFxProgress(1000, 1000, 3000)).toBe(0);
    expect(textFxProgress(3000, 1000, 3000)).toBe(1);
    expect(textFxProgress(5000, 1000, 3000)).toBe(1);
  });

  it("is linear in between", () => {
    expect(textFxProgress(2000, 1000, 3000)).toBeCloseTo(0.5, 6);
  });
});

const OPACITY_DRIVEN_PRESETS = TEXT_FX_MOTION_PRESETS.filter((preset) => preset !== "typewriter");

describe("textFxPhase", () => {
  it.each(OPACITY_DRIVEN_PRESETS)("%s starts hidden and ends hidden (fade out)", (preset) => {
    const start = textFxPhase(preset, 0, 2000);
    const end = textFxPhase(preset, 1, 2000);
    expect(start.opacity).toBeLessThanOrEqual(0.01);
    expect(end.opacity).toBeLessThanOrEqual(0.01);
  });

  it.each(OPACITY_DRIVEN_PRESETS)("%s is fully visible in the middle", (preset) => {
    const mid = textFxPhase(preset, 0.5, 2000);
    expect(mid.opacity).toBeGreaterThan(0.9);
  });

  it("typewriter is invisible-by-reveal at the start, fully revealed mid-way, and fades on exit", () => {
    const start = textFxPhase("typewriter", 0, 2000);
    const mid = textFxPhase("typewriter", 0.5, 2000);
    const end = textFxPhase("typewriter", 1, 2000);
    expect(start.reveal).toBeCloseTo(0, 6);
    expect(mid.reveal).toBeCloseTo(1, 1);
    expect(end.opacity).toBeLessThanOrEqual(0.01);
  });

  it("pop overshoots scale on the way in (easeOutBack)", () => {
    const samples = [0.05, 0.1, 0.15, 0.2].map((p) => textFxPhase("pop", p, 2000).scale);
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it("slide-up starts displaced downward and settles to 0", () => {
    const early = textFxPhase("slide-up", 0.02, 2000);
    const mid = textFxPhase("slide-up", 0.5, 2000);
    expect(early.dy).toBeGreaterThan(0);
    expect(mid.dy).toBeCloseTo(0, 1);
  });

  it("typewriter reveals progressively then holds fully revealed", () => {
    const early = textFxPhase("typewriter", 0.02, 2000);
    const mid = textFxPhase("typewriter", 0.5, 2000);
    expect(early.reveal).toBeLessThan(1);
    expect(mid.reveal).toBeCloseTo(1, 1);
  });

  it("underline sweeps in then holds full width", () => {
    const early = textFxPhase("underline", 0.02, 2000);
    const mid = textFxPhase("underline", 0.5, 2000);
    expect(early.underline).toBeLessThan(1);
    expect(mid.underline).toBeCloseTo(1, 1);
  });

  it("count-up's countFraction rises to 1", () => {
    const early = textFxPhase("count-up", 0.02, 2000);
    const mid = textFxPhase("count-up", 0.5, 2000);
    expect(early.countFraction).toBeLessThan(1);
    expect(mid.countFraction).toBeCloseTo(1, 1);
  });

  it("is deterministic: same inputs, same output", () => {
    expect(textFxPhase("fade", 0.33, 1500)).toEqual(textFxPhase("fade", 0.33, 1500));
  });

  it("maps every intent to a preset in the fixed list", () => {
    for (const preset of Object.values(DEFAULT_PRESET_BY_INTENT)) {
      expect(TEXT_FX_MOTION_PRESETS).toContain(preset);
    }
  });
});
