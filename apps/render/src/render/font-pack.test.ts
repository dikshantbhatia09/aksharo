/**
 * The render node against the **real** font pack A18b builds.
 *
 * `fonts.ts` describes a v1 font pack it will one day be given and falls back to
 * three OFL test subsets with a warning until then. This is the test that closes
 * that loop: the pack `@montaj/fonts` commits is read through the shipped
 * `readFontPack`/`loadFonts`, registered into `FontRegistry`, and used to shape
 * Devanagari, Tamil and Latin — with the fallback warning asserted **absent**,
 * because a production render that quietly drew the fixture subsets would draw
 * the right layout in the wrong typeface.
 *
 * It is `apps/render`'s test rather than `@montaj/fonts`' because the thing under
 * test is the *contract between them*: the schema this app parses, the file
 * names it resolves and the `scripts` hints its registry resolves by.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { bundledPackDirectory } from "@montaj/fonts/node";
import {
  createHarfBuzzShaper,
  resolveFontOrThrow,
  type Shaper,
  type FontRegistry,
} from "@montaj/render-core";

import {
  FONT_PACK_MANIFEST,
  FontPackSchema,
  fontFilesIn,
  loadFonts,
  readFontPack,
} from "./fonts.js";

const PACK = bundledPackDirectory();

let registry: FontRegistry;
let shaper: Shaper;
const warnings: string[] = [];

beforeAll(async () => {
  const loaded = await loadFonts({
    directory: PACK,
    onWarning: (message) => warnings.push(message),
  });
  registry = loaded.registry;
  shaper = await createHarfBuzzShaper(registry);
  expect(loaded.source).toBe("pack");
}, 180_000);

describe("the bundled pack as a v1 font pack", () => {
  it("parses under the schema this app ships", async () => {
    const fonts = await readFontPack(PACK);
    expect(fonts.length).toBeGreaterThan(20);
    for (const font of fonts) {
      expect(font.id).toBeTruthy();
      expect(font.family).toBeTruthy();
      expect(font.weight).toBeGreaterThanOrEqual(100);
      expect(font.data.byteLength).toBeGreaterThan(0);
      expect(font.scripts?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("names its manifest what this app looks for", () => {
    expect(FONT_PACK_MANIFEST).toBe("fonts.json");
  });

  it("ships only sfnt files this app can read, beside the WOFF2 the browser takes", async () => {
    // `readFontPack` returns `FontResource[]` for the registry, which carries no
    // `file` field — this is the pack's own manifest read straight off disk, the
    // only place the two file lists can be compared.
    const sfnt = await fontFilesIn(PACK);
    const manifest = FontPackSchema.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      JSON.parse(readFileSync(join(PACK, FONT_PACK_MANIFEST), "utf8")),
    );
    expect(new Set(sfnt)).toEqual(new Set(manifest.fonts.map((font) => font.file)));
  });

  it("loads without the fixture-fallback warning", () => {
    expect(warnings).toEqual([]);
  });

  it("warns, and falls back, only when no directory is configured", async () => {
    const seen: string[] = [];
    const loaded = await loadFonts({ onWarning: (message) => seen.push(message) });
    expect(loaded.source).toBe("fixtures");
    expect(seen[0]).toContain("RENDER_FONT_DIR");
  });
});

describe("shaping through the pack", () => {
  const cases = [
    { family: "Noto Sans Devanagari", script: "devanagari", text: "हिंदी में कैप्शन" },
    { family: "Noto Sans Tamil", script: "tamil", text: "தமிழ் வசனம்" },
    { family: "Inter", script: "latin", text: "Aksharo captions" },
  ] as const;

  for (const testCase of cases) {
    it(`draws ${testCase.script} with real glyphs and no fallback`, () => {
      const codePoints = [...testCase.text]
        .map((character) => character.codePointAt(0) ?? 0)
        .filter((code) => code !== 0x20);
      const face = resolveFontOrThrow(
        registry,
        {
          family: testCase.family,
          weight: 400,
          italic: false,
          fallbacks: ["Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
          script: testCase.script,
        },
        codePoints,
      );
      expect(face.family, "resolved to a fallback rather than the family asked for").toBe(
        testCase.family,
      );
      const run = shaper.shape({ text: testCase.text, fontId: face.id, script: testCase.script });
      expect(run.glyphs.length).toBeGreaterThan(0);
      expect(run.advance).toBeGreaterThan(0);
      expect(
        run.glyphs.every((glyph) => glyph.id !== 0),
        "the pack drew tofu",
      ).toBe(true);
    });
  }

  it("resolves a Hinglish line's two runs to two different faces", () => {
    const latin = resolveFontOrThrow(
      registry,
      { family: "Poppins", weight: 700, italic: false, script: "latin" },
      [...("video" as string)].map((character) => character.codePointAt(0) ?? 0),
    );
    const devanagari = resolveFontOrThrow(
      registry,
      {
        family: "Anton",
        weight: 400,
        italic: false,
        fallbacks: ["Noto Sans Devanagari"],
        script: "devanagari",
      },
      [...("बारे" as string)].map((character) => character.codePointAt(0) ?? 0),
    );
    expect(latin.family).toBe("Poppins");
    expect(devanagari.family).toBe("Noto Sans Devanagari");
  });
});
