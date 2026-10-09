import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "./registry.js";
import {
  ASPECT_BASE_FONT_SIZE_PX,
  CAPTION_ASPECT_RATIOS,
  computeAspectTypographyScaling,
  inferCaptionAspectRatio,
  scaleStyleDocForAspect,
} from "./scaling.js";
import { StyleDocSchema } from "./schema.js";

describe("Dynamic Typography Scaling per Aspect Ratio (Pillar 3 §06 Step 2)", () => {
  it("computes the exact base font sizes for 9:16 (54px), 4:5 (48px), 1:1 (42px), and 16:9 (44px) at 1080p", () => {
    const s9x16 = computeAspectTypographyScaling({
      aspect: "9:16",
      canvasWidth: 1080,
      canvasHeight: 1920,
    });
    expect(s9x16.fontSizePx).toBe(54);
    expect(s9x16.baseFontSizePx).toBe(ASPECT_BASE_FONT_SIZE_PX["9:16"]);
    expect(s9x16.yOffset).toBeGreaterThanOrEqual(s9x16.safeBottomPx);

    const s4x5 = computeAspectTypographyScaling({
      aspect: "4:5",
      canvasWidth: 1080,
      canvasHeight: 1350,
    });
    expect(s4x5.fontSizePx).toBe(48);
    expect(s4x5.baseFontSizePx).toBe(ASPECT_BASE_FONT_SIZE_PX["4:5"]);
    expect(s4x5.yOffset).toBeGreaterThanOrEqual(s4x5.safeBottomPx);

    const s1x1 = computeAspectTypographyScaling({
      aspect: "1:1",
      canvasWidth: 1080,
      canvasHeight: 1080,
    });
    expect(s1x1.fontSizePx).toBe(42);
    expect(s1x1.baseFontSizePx).toBe(ASPECT_BASE_FONT_SIZE_PX["1:1"]);
    expect(s1x1.yOffset).toBeGreaterThanOrEqual(s1x1.safeBottomPx);

    const s16x9 = computeAspectTypographyScaling({
      aspect: "16:9",
      canvasWidth: 1920,
      canvasHeight: 1080,
    });
    expect(s16x9.fontSizePx).toBe(44);
    expect(s16x9.baseFontSizePx).toBe(ASPECT_BASE_FONT_SIZE_PX["16:9"]);
    expect(s16x9.yOffset).toBeGreaterThanOrEqual(s16x9.safeBottomPx);
  });

  it("scales font size and line height proportionally across 720p, 1080p, and 4k resolutions", () => {
    const res720p = computeAspectTypographyScaling({
      aspect: "9:16",
      canvasWidth: 720,
      canvasHeight: 1280,
    });
    expect(res720p.fontSizePx).toBe(36); // 54 * (720 / 1080)
    expect(res720p.lineHeightPx).toBe(Math.round(36 * res720p.lineHeight));

    const res4k = computeAspectTypographyScaling({
      aspect: "1:1",
      canvasWidth: 2160,
      canvasHeight: 2160,
    });
    expect(res4k.fontSizePx).toBe(84); // 42 * (2160 / 1080)
    expect(res4k.lineHeightPx).toBe(Math.round(84 * res4k.lineHeight));
  });

  it("automatically adjusts yOffset to prevent captions from hitting bottom letterboxes or platform UI", () => {
    // Requesting a very low Y (0.96, inside bottom platform UI zone) clamps up to safeBottomPx
    const clampedToUiSafeZone = computeAspectTypographyScaling({
      aspect: "1:1",
      canvasWidth: 1080,
      canvasHeight: 1080,
      requestedYNormalized: 0.96,
    });
    expect(clampedToUiSafeZone.yOffset).toBeGreaterThanOrEqual(151);
    expect(clampedToUiSafeZone.captionY).toBeLessThanOrEqual(1080 - 151);

    // When a bottom letterbox (e.g. 320px tall) is present, yOffset raises above the letterbox bar
    const withLetterbox = computeAspectTypographyScaling({
      aspect: "4:5",
      canvasWidth: 1080,
      canvasHeight: 1350,
      requestedYNormalized: 0.85,
      letterboxBottomPx: 320,
    });
    expect(withLetterbox.yOffset).toBeGreaterThan(320);
    expect(withLetterbox.captionY).toBeLessThan(1350 - 320);
  });

  it("infers the closest aspect ratio from arbitrary canvas dimensions", () => {
    expect(inferCaptionAspectRatio(1080, 1920)).toBe("9:16");
    expect(inferCaptionAspectRatio(1080, 1350)).toBe("4:5");
    expect(inferCaptionAspectRatio(1080, 1080)).toBe("1:1");
    expect(inferCaptionAspectRatio(1920, 1080)).toBe("16:9");
  });

  it("scales a StyleDoc across all 4 aspect ratios while preserving schema validity", () => {
    const catalogue = loadSystemStyles();
    const firstStyle = catalogue[0];
    expect(firstStyle).toBeDefined();
    if (firstStyle === undefined) return;

    for (const aspect of CAPTION_ASPECT_RATIOS) {
      const scaled = scaleStyleDocForAspect(firstStyle, aspect);
      const parsed = StyleDocSchema.safeParse(scaled);
      expect(parsed.success).toBe(true);
      expect(scaled.layout.y).toBeGreaterThan(0);
      expect(scaled.layout.y).toBeLessThan(0.9);
    }
  });
});
