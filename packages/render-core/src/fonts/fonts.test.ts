import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { RenderError } from "../errors.js";
import { FIXTURE_FONT_DIR, createFixtureRegistry } from "../testing.js";
import {
  createHarfBuzzShaper,
  DEFAULT_FEATURES,
  harfBuzzVersion,
  loadHarfBuzz,
  resetHarfBuzz,
} from "./harfbuzz.js";
import { createFontRegistry, resolveFontOrThrow, __testing } from "./registry.js";
import { advanceOfClusterRange, clusterBoundaries, codePointsOf, type Shaper } from "./shaper.js";
import { type FontResource } from "./types.js";

function fixture(file: string): Uint8Array {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  return new Uint8Array(readFileSync(join(FIXTURE_FONT_DIR, file)));
}

const LATIN = fixture("NotoSans-Regular-subset.ttf");
const DEVANAGARI = fixture("NotoSansDevanagari-Regular-subset.ttf");
const TAMIL = fixture("NotoSansTamil-Regular-subset.ttf");

function face(overrides: Partial<FontResource> = {}): FontResource {
  return {
    id: "latin-400",
    family: "Noto Sans",
    weight: 400,
    italic: false,
    data: LATIN,
    scripts: ["latin"],
    ...overrides,
  };
}

describe("character map reading", () => {
  it("finds Latin, Devanagari and Tamil code points in their own faces", () => {
    expect(__testing.readCharacterMap(LATIN).has(0x41)).toBe(true);
    expect(__testing.readCharacterMap(LATIN).has(0x0939)).toBe(false);
    expect(__testing.readCharacterMap(DEVANAGARI).has(0x0939)).toBe(true);
    expect(__testing.readCharacterMap(TAMIL).has(0x0b87)).toBe(true);
  });

  it("returns nothing for bytes that are not a font", () => {
    expect(__testing.readCharacterMap(new Uint8Array(4)).size).toBe(0);
    expect(__testing.readCharacterMap(new Uint8Array(64)).size).toBe(0);
  });
});

describe("the registry", () => {
  it("refuses a face with no id or no bytes", () => {
    const registry = createFontRegistry();
    expect(() => registry.register(face({ id: "" }))).toThrow(RenderError);
    expect(() => registry.register(face({ data: new Uint8Array(0) }))).toThrow(/has no data/);
  });

  it("keeps registration order and replaces a face registered twice", () => {
    const registry = createFontRegistry([face(), face({ id: "b", family: "Other" })]);
    expect(registry.list().map((font) => font.id)).toEqual(["latin-400", "b"]);
    registry.register(face({ weight: 700 }));
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("latin-400")?.weight).toBe(700);
    expect(registry.has("nope")).toBe(false);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("matches a family case- and whitespace-insensitively", () => {
    const registry = createFontRegistry([face({ family: "  Noto   Sans " })]);
    expect(registry.resolve({ family: "noto sans", weight: 400, italic: false })?.id).toBe(
      "latin-400",
    );
  });

  it("prefers the nearest weight and never swaps slant for weight", () => {
    const registry = createFontRegistry([
      face({ id: "w400" }),
      face({ id: "w900", weight: 900 }),
      face({ id: "i400", italic: true }),
    ]);
    expect(registry.resolve({ family: "Noto Sans", weight: 800, italic: false })?.id).toBe("w900");
    expect(registry.resolve({ family: "Noto Sans", weight: 400, italic: true })?.id).toBe("i400");
  });

  it("falls back through the style's list before guessing", () => {
    const registry = createFontRegistry([
      face(),
      face({
        id: "deva",
        family: "Noto Sans Devanagari",
        data: DEVANAGARI,
        scripts: ["devanagari"],
      }),
    ]);
    const resolved = registry.resolve(
      { family: "Inter", fallbacks: ["Noto Sans Devanagari"], weight: 400, italic: false },
      codePointsOf("हिंदी"),
    );
    expect(resolved?.id).toBe("deva");
  });

  it("falls back by declared script when no family matches", () => {
    const registry = createFontRegistry([
      face(),
      face({ id: "tamil", family: "Noto Sans Tamil", data: TAMIL, scripts: ["tamil"] }),
    ]);
    expect(
      registry.resolve(
        { family: "Inter", weight: 400, italic: false, script: "tamil" },
        codePointsOf("இன்று"),
      )?.id,
    ).toBe("tamil");
  });

  it("falls back to anything that covers the text as a last resort", () => {
    const registry = createFontRegistry([face({ scripts: undefined })]);
    expect(
      registry.resolve({ family: "Nothing", weight: 400, italic: false }, codePointsOf("abc"))?.id,
    ).toBe("latin-400");
  });

  it("never lets a space decide the fallback", () => {
    const registry = createFontRegistry([face()]);
    expect(
      registry.resolve({ family: "Noto Sans", weight: 400, italic: false }, codePointsOf("a b")),
    ).toBeDefined();
  });

  it("returns undefined, and throws on demand, when nothing can draw the text", () => {
    const registry = createFontRegistry([face()]);
    expect(
      registry.resolve({ family: "Noto Sans", weight: 400, italic: false }, codePointsOf("हिंदी")),
    ).toBeUndefined();
    expect(() =>
      resolveFontOrThrow(
        registry,
        { family: "Noto Sans", weight: 400, italic: false, script: "devanagari" },
        codePointsOf("हिंदी"),
      ),
    ).toThrow(/no registered font/);
  });

  it("scores faces the way the docstring says", () => {
    expect(__testing.familyKey(" Noto  Sans ")).toBe("noto sans");
    expect(
      __testing.faceDistance(face(), { family: "x", weight: 400, italic: true }),
    ).toBeGreaterThan(1000);
  });
});

describe("the HarfBuzz shaper", () => {
  let shaper: Shaper;

  beforeAll(async () => {
    shaper = await createHarfBuzzShaper(createFixtureRegistry());
  });

  it("reports the wasm build's HarfBuzz version", async () => {
    expect(await harfBuzzVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("shapes Latin into glyph ids with advances in font units", () => {
    const run = shaper.shape({ text: "AV", fontId: "noto-sans-400", script: "latin" });
    expect(run.upem).toBe(1000);
    expect(run.glyphs).toHaveLength(2);
    expect(run.glyphs.every((glyph) => glyph.id > 0)).toBe(true);
    expect(run.advance).toBe(run.glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0));
  });

  it("reorders a Devanagari matra ahead of its consonant", () => {
    const run = shaper.shape({
      text: "हि",
      fontId: "noto-sans-devanagari-400",
      script: "devanagari",
    });
    // "ि" is typed after "ह" but drawn before it, and both belong to cluster 0.
    expect(run.glyphs.length).toBeGreaterThan(1);
    expect(run.glyphs.every((glyph) => glyph.cluster === 0)).toBe(true);
    expect(clusterBoundaries(run)).toEqual([0]);
  });

  it("keeps a Tamil syllable in one cluster", () => {
    const run = shaper.shape({ text: "இன்று", fontId: "noto-sans-tamil-400", script: "tamil" });
    expect(run.glyphs.every((glyph) => glyph.id > 0)).toBe(true);
    expect(clusterBoundaries(run).length).toBeLessThan("இன்று".length);
  });

  it("applies the default OpenType features and can be told otherwise", () => {
    expect(DEFAULT_FEATURES).toContain("liga");
    const withLigatures = shaper.shape({ text: "ffi", fontId: "noto-sans-400", script: "latin" });
    const without = shaper.shape({
      text: "ffi",
      fontId: "noto-sans-400",
      script: "latin",
      features: [],
    });
    expect(withLigatures.glyphs.length).toBeLessThanOrEqual(without.glyphs.length);
  });

  it("caches a shaped run and returns the identical object", () => {
    const first = shaper.shape({ text: "cache me", fontId: "noto-sans-400", script: "latin" });
    expect(shaper.shape({ text: "cache me", fontId: "noto-sans-400", script: "latin" })).toBe(
      first,
    );
  });

  it("evicts the oldest entry once the cache is full", async () => {
    const small = await createHarfBuzzShaper(createFixtureRegistry(), { cacheSize: 2 });
    const first = small.shape({ text: "one", fontId: "noto-sans-400", script: "latin" });
    small.shape({ text: "two", fontId: "noto-sans-400", script: "latin" });
    small.shape({ text: "three", fontId: "noto-sans-400", script: "latin" });
    expect(small.shape({ text: "one", fontId: "noto-sans-400", script: "latin" })).not.toBe(first);
  });

  it("reports face metrics in font units", () => {
    const metrics = shaper.metrics("noto-sans-400");
    expect(metrics.upem).toBe(1000);
    expect(metrics.ascender).toBeGreaterThan(0);
    expect(metrics.descender).toBeLessThan(0);
  });

  it("answers coverage questions per face", () => {
    expect(shaper.covers("noto-sans-400", codePointsOf("abc "))).toBe(true);
    expect(shaper.covers("noto-sans-400", codePointsOf("हिंदी"))).toBe(false);
    expect(shaper.covers("noto-sans-devanagari-400", codePointsOf("हिंदी"))).toBe(true);
  });

  it("returns a cached SVG outline for a glyph", () => {
    const run = shaper.shape({ text: "A", fontId: "noto-sans-400", script: "latin" });
    const glyph = run.glyphs[0];
    expect(glyph).toBeDefined();
    const path = shaper.glyphPath("noto-sans-400", glyph?.id ?? 0);
    expect(path.startsWith("M")).toBe(true);
    expect(shaper.glyphPath("noto-sans-400", glyph?.id ?? 0)).toBe(path);
  });

  it("refuses to shape with a font that was never registered", () => {
    expect(() => shaper.shape({ text: "x", fontId: "ghost", script: "latin" })).toThrow(
      /not registered/,
    );
  });

  it("can be handed an already-initialised module and reset", async () => {
    const module = await loadHarfBuzz();
    resetHarfBuzz();
    expect(await loadHarfBuzz(module)).toBe(module);
    resetHarfBuzz();
  });
});

describe("cluster helpers", () => {
  it("measures the advance of a cluster range only", async () => {
    const shaper = await createHarfBuzzShaper(createFixtureRegistry());
    const run = shaper.shape({ text: "abcd", fontId: "noto-sans-400", script: "latin" });
    expect(advanceOfClusterRange(run, 0, 4)).toBe(run.advance);
    expect(advanceOfClusterRange(run, 0, 2)).toBeLessThan(run.advance);
    expect(advanceOfClusterRange(run, 4, 4)).toBe(0);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(codePointsOf("a😀b")).toHaveLength(3);
    expect(codePointsOf("")).toHaveLength(0);
  });
});
