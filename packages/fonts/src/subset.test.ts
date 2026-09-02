/**
 * The subsetting round trip.
 *
 * The claim under test is the one everything else rests on: **subsetting a face
 * does not change how text in the kept scripts is shaped.** Glyph *ids* do
 * change — `hb-subset` renumbers them — but the cluster structure, the advances
 * and the offsets are what layout measures and what the parity goldens hash, and
 * those must be identical.
 *
 * Shaping goes through the real HarfBuzz shaper out of `@montaj/render-core`,
 * not a fake, because a fake would agree with itself.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  createFontRegistry,
  createHarfBuzzShaper,
  type Shaper,
  type WordScript,
} from "@montaj/render-core";

import { SCRIPT_SAMPLES, type ScriptTag } from "./scripts.js";
import { DROPPED_TABLES, subsetFace, subsetToSfnt, subsetToWoff2 } from "./subset.js";
import { packFontBytes } from "./testing.js";
import { validateFont } from "./validate.js";

/** Everything about a shaped run except the glyph ids, which subsetting moves. */
function shapeSignature(shaper: Shaper, fontId: string, text: string, script: WordScript): string {
  const run = shaper.shape({ text, fontId, script });
  return JSON.stringify({
    upem: run.upem,
    advance: run.advance,
    glyphs: run.glyphs.map((glyph) => [
      glyph.cluster,
      glyph.xAdvance,
      glyph.yAdvance,
      glyph.xOffset,
      glyph.yOffset,
    ]),
  });
}

interface Case {
  readonly id: string;
  readonly tag: ScriptTag;
  readonly script: WordScript;
  readonly words: readonly string[];
}

const CASES: readonly Case[] = [
  {
    id: "noto-sans-devanagari-400",
    tag: "Deva",
    script: "devanagari",
    words: ["हिंदी", "क्षत्रिय", "श्रीमान्", "बारे", "क्रिकेट", SCRIPT_SAMPLES["Deva"]],
  },
  {
    id: "noto-sans-tamil-400",
    tag: "Taml",
    script: "tamil",
    words: ["தமிழ்", "பேசுவோம்", "க்ஷ", SCRIPT_SAMPLES["Taml"]],
  },
  {
    id: "noto-sans-400",
    tag: "Latn",
    script: "latin",
    words: ["Aksharo", "affix", "AVATAR", "1,234.50", SCRIPT_SAMPLES["Latn"]],
  },
];

describe("subsetting preserves shaping", () => {
  for (const testCase of CASES) {
    describe(testCase.tag, () => {
      let before: Shaper;
      let after: Shaper;
      let originalBytes: Uint8Array;
      let subsetBytes: Uint8Array;

      beforeAll(async () => {
        originalBytes = packFontBytes(testCase.id);
        subsetBytes = await subsetToSfnt(originalBytes, { scripts: [testCase.tag] });

        before = await createHarfBuzzShaper(
          createFontRegistry([
            {
              id: "original",
              family: "Original",
              weight: 400,
              italic: false,
              data: originalBytes,
            },
          ]),
        );
        after = await createHarfBuzzShaper(
          createFontRegistry([
            { id: "subset", family: "Subset", weight: 400, italic: false, data: subsetBytes },
          ]),
        );
      });

      it("shapes every sample to the same clusters, advances and offsets", () => {
        for (const word of testCase.words) {
          expect(
            shapeSignature(after, "subset", word, testCase.script),
            `${testCase.tag}: ${word}`,
          ).toBe(shapeSignature(before, "original", word, testCase.script));
        }
      });

      it("keeps the same vertical metrics", () => {
        expect(after.metrics("subset")).toEqual(before.metrics("original"));
      });

      it("still covers the script's own code points", () => {
        const validation = validateFont(subsetBytes);
        expect(validation.scripts).toContain(testCase.tag);
      });

      it("costs no more bytes than the face it came from", () => {
        expect(subsetBytes.byteLength).toBeLessThanOrEqual(originalBytes.byteLength);
      });
    });
  }
});

describe("the WOFF2 twin", () => {
  it("is markedly smaller and decompresses to a face that shapes the same", async () => {
    const original = packFontBytes("noto-sans-devanagari-400");
    const { sfnt, woff2 } = await subsetFace(original, { scripts: ["Deva"] });
    expect(woff2.byteLength).toBeLessThan(sfnt.byteLength * 0.6);
    expect(String.fromCharCode(...woff2.subarray(0, 4))).toBe("wOF2");

    const { default: decompress } = await import("woff2-encoder/decompress");
    const restored = await decompress(woff2);

    const sfntShaper = await createHarfBuzzShaper(
      createFontRegistry([{ id: "sfnt", family: "S", weight: 400, italic: false, data: sfnt }]),
    );
    const woff2Shaper = await createHarfBuzzShaper(
      createFontRegistry([
        { id: "woff2", family: "W", weight: 400, italic: false, data: restored },
      ]),
    );
    for (const word of ["हिंदी", "क्षत्रिय", "Aksharo"]) {
      expect(shapeSignature(woff2Shaper, "woff2", word, "devanagari")).toBe(
        shapeSignature(sfntShaper, "sfnt", word, "devanagari"),
      );
    }
  });

  it("is produced directly rather than by compressing the sfnt", async () => {
    const woff2 = await subsetToWoff2(packFontBytes("noto-sans-tamil-400"), { scripts: ["Taml"] });
    expect(String.fromCharCode(...woff2.subarray(0, 4))).toBe("wOF2");
  });
});

describe("subsetting drops what it should and keeps what it must", () => {
  it("throws away the scripts it was not asked for", async () => {
    // Poppins ships Devanagari as well as Latin; a Latin-only subset must lose it.
    const poppins = packFontBytes("poppins-700");
    expect(validateFont(poppins).scripts).toEqual(expect.arrayContaining(["Latn", "Deva"]));
    const latinOnly = await subsetToSfnt(poppins, { scripts: ["Latn"] });
    const after = validateFont(latinOnly);
    expect(after.scripts).toContain("Latn");
    expect(after.scripts).not.toContain("Deva");
    expect(latinOnly.byteLength).toBeLessThan(poppins.byteLength);
  });

  it("keeps extra characters when asked, and only those", async () => {
    const source = packFontBytes("noto-sans-devanagari-400");
    const bytes = await subsetToSfnt(source, { scripts: ["Latn"], extraText: "क" });
    const kept = validateFont(bytes).codePoints;
    expect(kept.has(0x0915)).toBe(true); // क, asked for by name
    expect(kept.has(0x0916)).toBe(false); // ख, in the same block and not asked for
  });

  it("names the tables it drops", () => {
    expect(DROPPED_TABLES).toContain("DSIG");
  });

  it("reports a source it cannot subset as fonts/subset_failed", async () => {
    await expect(
      subsetToSfnt(new Uint8Array([0, 1, 0, 0, 9, 9, 9, 9]), { scripts: ["Latn"] }),
    ).rejects.toMatchObject({ code: "fonts/subset_failed" });
  });
});
