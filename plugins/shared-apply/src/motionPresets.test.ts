import { describe, expect, it } from "vitest";

import {
  defaultPresetForIntent,
  isMotionPresetSupported,
  resolveMotionPresetParams,
} from "./motionPresets.js";

import type { MotionPreset } from "./types.js";

const ALL_PRESETS: readonly MotionPreset[] = [
  "pop",
  "slide-up",
  "typewriter",
  "underline",
  "count-up",
  "fade",
];

describe("motionPresets", () => {
  it("supports every D06 preset (no overlay fallback needed today)", () => {
    for (const preset of ALL_PRESETS) {
      expect(isMotionPresetSupported(preset)).toBe(true);
    }
  });

  it("maps each intent to a sensible default preset", () => {
    expect(defaultPresetForIntent("title")).toBe("pop");
    expect(defaultPresetForIntent("stat")).toBe("count-up");
    expect(defaultPresetForIntent("quote")).toBe("fade");
    expect(defaultPresetForIntent("hook")).toBe("slide-up");
  });

  it("uses the preset's own PositionY when no layout hint is given", () => {
    const params = resolveMotionPresetParams("pop", undefined);
    expect(params.PositionY).toBe(20);
    expect(params.MotionPreset).toBe("pop");
  });

  it("lets the layout candidate's PositionY override the preset default", () => {
    const params = resolveMotionPresetParams("pop", "centre");
    expect(params.PositionY).toBe(50);
  });
});
