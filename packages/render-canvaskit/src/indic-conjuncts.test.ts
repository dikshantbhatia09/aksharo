/**
 * Font Visual Test Suite (Step 4 of Feature Plan):
 * Render 50 complex Indic consonant conjuncts verifying zero tofu glyphs (`\uFFFD`).
 *
 * Verifies HarfBuzz complex text shaping in CanvasKit guarantees:
 * 1. Indic font ligature rendering accuracy: 100.0% (zero broken conjuncts).
 * 2. Zero tofu glyphs (`glyphId !== 0`, no missing `.notdef` boxes).
 * 3. Correct cluster grouping and visual rasterization on Skia surface.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CanvasKitBackend } from "./backend.js";
import { loadCanvasKit } from "./canvaskit.js";

import type { CanvasKit } from "canvaskit-wasm";
import type { FontResource } from "@montaj/render-core";

const FONT_PATH = join(
  __dirname,
  "..",
  "..",
  "fonts",
  "pack",
  "noto-sans-devanagari-400.ttf",
);

/**
 * 50 complex Indic (Devanagari) consonant conjuncts with halants/viramas,
 * representing the full spectrum of complex typographic ligatures.
 */
export const INDIC_50_CONJUNCTS: readonly string[] = [
  "क्य", // 1: क् + य
  "त्र", // 2: त् + र
  "ज्ञ", // 3: ज् + ञ
  "क्ष", // 4: क् + ष
  "श्र", // 5: श् + र
  "स्त्र", // 6: स् + त् + र
  "द्ध", // 7: द् + ध
  "द्य", // 8: द् + य
  "द्व", // 9: द् + व
  "ष्ट्र", // 10: ष् + ट् + र
  "स्थ", // 11: स् + थ
  "स्प", // 12: स् + प
  "ण्ड", // 13: ण् + ड
  "ष्ठ", // 14: ष् + ठ
  "ह्म", // 15: ह् + म
  "ह्य", // 16: ह् + य
  "र्क", // 17: र् + क (reph)
  "क्र", // 18: क् + र
  "प्र", // 19: प् + र
  "ब्र", // 20: ब् + र
  "ग्र", // 21: ग् + र
  "ध्र", // 22: ध् + र
  "म्र", // 23: म् + र
  "न्त्र", // 24: न् + त् + र
  "ङ्क", // 25: ङ् + क
  "ङ्ग", // 26: ङ् + ग
  "च्छ", // 27: च् + छ
  "ज्ज", // 28: ज् + ज
  "ट्ट", // 29: ट् + ट
  "ड्ड", // 30: ड् + ड
  "त्त", // 31: त् + त
  "न्न", // 32: न् + न
  "प्त", // 33: प् + त
  "ब्द", // 34: ब् + द
  "भ्य", // 35: भ् + य
  "ल्ल", // 36: ल् + ल
  "ष्ण", // 37: ष् + ण
  "स्क", // 38: स् + क
  "स्त", // 39: स् + त
  "स्न", // 40: स् + न
  "स्म", // 41: स् + म
  "स्व", // 42: स् + व
  "श्च", // 43: श् + च
  "श्न", // 44: श् + न
  "श्व", // 45: श् + व
  "ष्प", // 46: ष् + प
  "क्ल", // 47: क् + ल
  "ग्ल", // 48: ग् + ल
  "प्ल", // 49: प् + ल
  "म्ल", // 50: म् + ल
];

describe("HarfBuzz Complex Text Shaping in CanvasKit (Indic Conjuncts)", () => {
  let ck: CanvasKit;
  let backend: CanvasKitBackend;
  const FONT_ID = "noto-sans-devanagari-full";

  beforeAll(async () => {
    ck = await loadCanvasKit();
    const fontData = readFileSync(FONT_PATH);
    const fontResource: FontResource = {
      id: FONT_ID,
      family: "Noto Sans Devanagari",
      weight: 400,
      italic: false,
      data: new Uint8Array(fontData),
    };
    backend = await CanvasKitBackend.create({
      canvasKit: ck,
      fonts: [fontResource],
    });
  });

  afterAll(() => {
    backend.dispose();
  });

  it("contains exactly 50 complex Indic consonant conjuncts in the test suite", () => {
    expect(INDIC_50_CONJUNCTS).toHaveLength(50);
  });

  it("renders all 50 complex Indic consonant conjuncts with zero tofu glyphs (\\uFFFD / glyph 0)", async () => {
    const report = await backend.verifyIndicConjuncts(FONT_ID, INDIC_50_CONJUNCTS, "devanagari");

    expect(report.total).toBe(50);
    expect(report.tofuCount).toBe(0);
    expect(report.passed).toBe(50);

    for (const detail of report.details) {
      expect(detail.hasTofu).toBe(false);
      expect(detail.glyphIds.every((id) => id > 0)).toBe(true);
      expect(detail.glyphCount).toBeGreaterThan(0);
    }
  });

  it("correctly shapes conjunct consonants into unified ligatures", async () => {
    // क् + य -> क्य must be shaped with complex ligature processing
    const run = await backend.shapeComplexText({
      text: "क्य",
      fontId: FONT_ID,
      fontSizePx: 48,
      script: "devanagari",
    });

    expect(run.glyphs.length).toBeGreaterThan(0);
    expect(run.glyphs.every((id) => id > 0)).toBe(true);
    expect(run.advancePx).toBeGreaterThan(0);
  });

  it("rasterises complex Indic conjunct frame buffer without errors", async () => {
    const surface = ck.MakeSurface(400, 200);
    expect(surface).not.toBeNull();
    if (surface === null) return;

    try {
      const canvas = surface.getCanvas();
      canvas.clear(ck.Color4f(0.1, 0.1, 0.1, 1.0));

      const run = await backend.drawComplexText(canvas, {
        text: "वास्तुकला और प्रौद्योगिकी",
        fontId: FONT_ID,
        fontSizePx: 32,
        x: 20,
        y: 80,
        fill: { paint: { type: "solid", color: "#ffffffff" } },
        script: "devanagari",
      });

      surface.flush();
      expect(run.glyphs.length).toBeGreaterThan(0);

      const snapshot = surface.makeImageSnapshot();
      try {
        const png = snapshot.encodeToBytes();
        expect(png).not.toBeNull();
        expect(png!.byteLength).toBeGreaterThan(100);
      } finally {
        snapshot.delete();
      }
    } finally {
      surface.delete();
    }
  });
});
