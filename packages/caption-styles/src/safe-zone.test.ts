import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "./registry.js";
import {
  clampBoxToSafeZone,
  DEFAULT_BOTTOM_CAPTION_Y,
  DEFAULT_BOTTOM_Y_NORMALIZED,
  enforceSafeZoneConstraints,
  getPlatformExclusions,
  getSafeZoneBounds,
  isWithinSafeZone,
  MAX_BOTTOM_BASELINE_Y_PX,
  MAX_SAFE_CAPTION_WIDTH_PCT,
  MAX_SAFE_CAPTION_WIDTH_PX,
  PLATFORM_SAFE_ZONES,
  REFERENCE_CANVAS,
  type SafeZonePlatform,
} from "./safe-zone.js";
import { type StyleDoc } from "./schema.js";

describe("Social Media Safe-Zone & UI Avoidance Engine (Pillar 3 §08)", () => {
  it("defines pixel-precise specs for TikTok, Reels, Shorts, and Universal on 1080x1920", () => {
    const platforms: SafeZonePlatform[] = ["tiktok", "reels", "shorts", "universal"];
    for (const p of platforms) {
      const spec = PLATFORM_SAFE_ZONES[p];
      expect(spec).toBeDefined();
      expect(spec.topMarginPx).toBeGreaterThanOrEqual(120);
      expect(spec.topMarginPx).toBeLessThanOrEqual(160);
      expect(spec.bottomMarginPx).toBeGreaterThanOrEqual(340);
      expect(spec.bottomMarginPx).toBeLessThanOrEqual(440);
      expect(spec.rightMarginPx).toBeGreaterThanOrEqual(110);
      expect(spec.rightMarginPx).toBeLessThanOrEqual(130);
      expect(spec.leftMarginPx).toBe(50);
      expect(spec.defaultCaptionY).toBeGreaterThanOrEqual(1380);
      expect(spec.defaultCaptionY).toBeLessThanOrEqual(1420);
    }

    // Verify Universal is the strict intersection (most conservative bounds)
    const u = PLATFORM_SAFE_ZONES.universal;
    expect(u.topMarginPx).toBe(160);
    expect(u.bottomMarginPx).toBe(440);
    expect(u.rightMarginPx).toBe(130);
    expect(u.leftMarginPx).toBe(50);
    expect(u.defaultCaptionY).toBe(DEFAULT_BOTTOM_CAPTION_Y);
  });

  it("calculates exact safe rectangle bounds on a 1080x1920 canvas", () => {
    const bounds = getSafeZoneBounds("universal", REFERENCE_CANVAS);
    expect(bounds.left).toBe(50);
    expect(bounds.top).toBe(160);
    expect(bounds.right).toBe(950);
    expect(bounds.bottom).toBe(1480); // 1920 - 440
    expect(bounds.width).toBe(900);
    expect(bounds.height).toBe(1320);
    expect(bounds.defaultCaptionY).toBe(1380);
    expect(bounds.maxBaselineY).toBe(MAX_BOTTOM_BASELINE_Y_PX);
  });

  it("calculates platform danger exclusion zones", () => {
    const exclusions = getPlatformExclusions("tiktok", REFERENCE_CANVAS);
    expect(exclusions.top).toEqual([0, 0, 1080, 160]);
    expect(exclusions.bottom).toEqual([0, 1480, 1080, 1920]);
    expect(exclusions.right).toEqual([950, 600, 1080, 1500]);
    expect(exclusions.left).toEqual([0, 0, 50, 1920]);
  });

  it("verifies ALL 66 registered system styles calculate bounds strictly within PLATFORM_SAFE_ZONES.universal", () => {
    const styles = loadSystemStyles();
    expect(styles).toHaveLength(66);

    for (const style of styles) {
      // 1. Check max width percentage: must not exceed 81.48% (880px on 1080 canvas)
      expect(
        style.layout.maxWidthPct,
        `Style ${style.id} maxWidthPct (${style.layout.maxWidthPct}) exceeds safe width limit ${MAX_SAFE_CAPTION_WIDTH_PCT}%`,
      ).toBeLessThanOrEqual(MAX_SAFE_CAPTION_WIDTH_PCT + 0.01);

      // 2. Check pixel width on 1080 canvas
      const widthPx = (style.layout.maxWidthPct / 100) * REFERENCE_CANVAS.width;
      expect(
        widthPx,
        `Style ${style.id} widthPx (${widthPx}) exceeds 880px safe width limit`,
      ).toBeLessThanOrEqual(MAX_SAFE_CAPTION_WIDTH_PX + 1);

      // 3. Check vertical positioning for bottom-anchored presets
      const isBottom = style.layout.anchor.startsWith("bottom");

      if (isBottom) {
        expect(
          style.layout.y,
          `Bottom-anchored style ${style.id} y (${style.layout.y}) sits below default safe baseline ${DEFAULT_BOTTOM_Y_NORMALIZED}`,
        ).toBeLessThanOrEqual(DEFAULT_BOTTOM_Y_NORMALIZED + 0.001);

        const captionYPx = style.layout.y * REFERENCE_CANVAS.height;
        expect(
          captionYPx,
          `Bottom-anchored style ${style.id} pixel Y (${captionYPx}) sits below safe baseline ${DEFAULT_BOTTOM_CAPTION_Y}px`,
        ).toBeLessThanOrEqual(DEFAULT_BOTTOM_CAPTION_Y + 1);
      }

      // 4. In all styles, Y coordinate must not exceed the danger baseline (1420 px / 0.7396)
      const maxBaselineYNormalized = MAX_BOTTOM_BASELINE_Y_PX / REFERENCE_CANVAS.height;
      expect(
        style.layout.y,
        `Style ${style.id} Y (${style.layout.y}) enters bottom danger zone (> ${maxBaselineYNormalized})`,
      ).toBeLessThanOrEqual(maxBaselineYNormalized + 0.001);
    }
  });

  it("enforces safe-zone constraints on non-compliant styles", () => {
    const unconstrainedStyle: StyleDoc = {
      id: "test-style",
      name: "Test Style",
      version: 2,
      category: "bold",
      minPlan: "free",
      typography: {
        fontFamily: "Inter",
        weight: 700,
        italic: false,
        sizePct: 4,
        lineHeight: 1.2,
        letterSpacingEm: 0,
        textTransform: "none",
      },
      colors: { text: "#ffffff" },
      box: { enabled: false, mode: "line", paddingPct: 0, radiusPct: 0, opacity: 1 },
      stroke: { enabled: false, widthPct: 0 },
      shadow: { enabled: false, offsetXPct: 0, offsetYPct: 0, blurPct: 0, opacity: 0 },
      layout: {
        anchor: "bottom-center",
        x: 0.5,
        y: 0.92, // Too low! Inside TikTok caption zone
        align: "center",
        maxWidthPct: 95, // Too wide! Runs under action buttons
        maxLines: 2,
      },
      animation: {
        in: { type: "none", durationMs: 0 },
        out: { type: "none", durationMs: 0 },
        wordHighlight: { type: "none", durationMs: 0 },
      },
      emphasisPresets: [{ id: "accent", color: "#ffff00" }],
    };

    const constrained = enforceSafeZoneConstraints(unconstrainedStyle);
    expect(constrained.layout.y).toBe(DEFAULT_BOTTOM_Y_NORMALIZED);
    expect(constrained.layout.maxWidthPct).toBe(MAX_SAFE_CAPTION_WIDTH_PCT);
  });

  it("clamps bounding boxes and verifies safe zone containment", () => {
    // Completely inside safe zone
    const insideBox: [number, number, number, number] = [100, 300, 800, 1200];
    expect(isWithinSafeZone(insideBox, "universal")).toBe(true);

    // Occluding right action buttons
    const rightOccluded: [number, number, number, number] = [100, 300, 1020, 1200];
    expect(isWithinSafeZone(rightOccluded, "universal")).toBe(false);

    // Occluding bottom TikTok username/audio
    const bottomOccluded: [number, number, number, number] = [100, 1300, 800, 1600];
    expect(isWithinSafeZone(bottomOccluded, "universal")).toBe(false);

    // Clamping brings it within bounds
    const clampedBottom = clampBoxToSafeZone(bottomOccluded, "universal");
    expect(isWithinSafeZone(clampedBottom, "universal")).toBe(true);
    expect(clampedBottom[3]).toBeLessThanOrEqual(1480);
  });
});
