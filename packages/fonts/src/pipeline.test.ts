import { describe, expect, it } from "vitest";

import { createFontRegistry, createHarfBuzzShaper } from "@montaj/render-core";

import { processFont, sha256, variationInstance } from "./pipeline.js";
import {
  fakeTtfBytes,
  oversizeBytes,
  packFontBytes,
  sampleDevanagariFont,
  sampleLatinFont,
  withNoEmbedding,
} from "./testing.js";
import { validateFont, type FontValidation } from "./validate.js";

describe("processFont", () => {
  it("validates, subsets and compresses in one pass", async () => {
    const bytes = sampleDevanagariFont();
    const result = await processFont({ bytes, claimedScripts: ["Deva", "Latn"] });

    expect(result.validation.family).toBe("Noto Sans Devanagari");
    expect(result.scripts).toEqual(["Deva", "Latn"]);
    expect(result.wordScripts).toEqual(["latin", "devanagari"]);
    expect(result.subset).toBe(true);
    expect(result.sfnt.byteLength).toBeGreaterThan(1_000);
    expect(result.woff2.byteLength).toBeLessThan(result.sfnt.byteLength);
    expect(result.sha256Original).toBe(sha256(bytes));
    expect(result.sha256Sfnt).toBe(sha256(result.sfnt));
    expect(result.sha256Woff2).toBe(sha256(result.woff2));
  });

  it("produces a face the render registry can shape with", async () => {
    const result = await processFont({ bytes: sampleDevanagariFont(), claimedScripts: ["Deva"] });
    const registry = createFontRegistry([
      {
        id: "uploaded",
        family: result.validation.family,
        weight: result.validation.weight,
        italic: result.validation.italic,
        data: result.sfnt,
        scripts: result.wordScripts,
      },
    ]);
    const shaper = await createHarfBuzzShaper(registry);
    const run = shaper.shape({ text: "हिंदी", fontId: "uploaded", script: "devanagari" });
    expect(run.glyphs.length).toBeGreaterThan(0);
    expect(run.glyphs.every((glyph) => glyph.id !== 0)).toBe(true);
  });

  it("falls back to the scripts the font actually covers", async () => {
    const result = await processFont({ bytes: sampleLatinFont() });
    expect(result.scripts).toContain("Latn");
    expect(result.wordScripts).toContain("latin");
  });

  it("refuses before subsetting when the font is refused", async () => {
    await expect(processFont({ bytes: fakeTtfBytes() })).rejects.toMatchObject({
      code: "fonts/unparsable",
    });
    await expect(processFont({ bytes: withNoEmbedding(sampleLatinFont()) })).rejects.toMatchObject({
      code: "fonts/embedding_restricted",
    });
    await expect(
      processFont({ bytes: sampleLatinFont(), claimedScripts: ["Taml"] }),
    ).rejects.toMatchObject({ code: "fonts/script_not_covered" });
    await expect(processFont({ bytes: oversizeBytes(1_000), maxBytes: 100 })).rejects.toMatchObject(
      { code: "fonts/too_large" },
    );
  });

  it("keeps the extra characters a caller asks for", async () => {
    const result = await processFont({
      bytes: sampleDevanagariFont(),
      claimedScripts: ["Latn"],
      extraText: "क",
    });
    expect(validateFont(result.sfnt).codePoints.has(0x0915)).toBe(true);
  });

  it("is deterministic: the same bytes give the same digests", async () => {
    const bytes = packFontBytes("noto-sans-tamil-400");
    const [first, second] = await Promise.all([
      processFont({ bytes, claimedScripts: ["Taml"] }),
      processFont({ bytes, claimedScripts: ["Taml"] }),
    ]);
    expect(first.sha256Sfnt).toBe(second.sha256Sfnt);
    expect(first.sha256Woff2).toBe(second.sha256Woff2);
  });
});

describe("variable-font instancing", () => {
  const base: FontValidation = {
    ...validateFont(sampleLatinFont()),
  };

  it("does nothing for a static face", () => {
    expect(variationInstance({ ...base, variable: false, variationAxes: [] })).toBeUndefined();
  });

  it("pins weight from the OS/2 class, not from the axis default", () => {
    expect(
      variationInstance({ ...base, variable: true, variationAxes: ["wght"], weight: 800 }),
    ).toEqual({ wght: 800 });
  });

  it("pins width, slant and italic at their neutral values", () => {
    expect(
      variationInstance({
        ...base,
        variable: true,
        variationAxes: ["wght", "wdth", "slnt", "ital"],
        weight: 400,
        italic: true,
      }),
    ).toEqual({ wght: 400, wdth: 100, slnt: 0, ital: 1 });
  });

  it("leaves an axis it does not understand alone", () => {
    expect(variationInstance({ ...base, variable: true, variationAxes: ["opsz"] })).toBeUndefined();
  });

  it("leaves no axes on the shipped face", async () => {
    const result = await processFont({ bytes: sampleDevanagariFont(), claimedScripts: ["Deva"] });
    expect(validateFont(result.sfnt).variable).toBe(false);
  });
});
