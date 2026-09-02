/**
 * Test helpers: the three fixture fonts, a ready-made registry and shaper, and
 * the four caption fixtures the golden suite renders (Hinglish, Hindi, Tamil,
 * English).
 *
 * Exported as `@montaj/render-core/testing` so `@montaj/render-canvaskit`,
 * `@montaj/render-skia-node` (A20) and the preview build script all draw from
 * one set of inputs — a golden hash is only comparable if every backend started
 * from the same bytes.
 *
 * This module reads the filesystem and therefore never gets imported by the
 * package's own runtime path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createHarfBuzzShaper } from "./fonts/harfbuzz.js";
import { createFontRegistry } from "./fonts/registry.js";
import { type Shaper } from "./fonts/shaper.js";
import { type FontRegistry, type FontResource } from "./fonts/types.js";
import { type RenderWord } from "./layout/types.js";
import { type WordScript } from "./script.js";
import { type CanvasSize } from "./units.js";

/** `fixtures/fonts`, resolved from the sources and from `dist/` alike. */
export const FIXTURE_FONT_DIR = join(__dirname, "..", "fixtures", "fonts");

interface FixtureFont {
  readonly id: string;
  readonly family: string;
  readonly file: string;
  readonly scripts: readonly WordScript[];
}

/**
 * The fixture faces. Each is registered under its own family **and** under the
 * families the system styles ask for, so a style that wants "Inter" or
 * "Poppins" resolves in tests without shipping either font.
 */
const FIXTURE_FONTS: readonly FixtureFont[] = [
  {
    id: "noto-sans-400",
    family: "Noto Sans",
    file: "NotoSans-Regular-subset.ttf",
    scripts: ["latin"],
  },
  {
    id: "noto-sans-devanagari-400",
    family: "Noto Sans Devanagari",
    file: "NotoSansDevanagari-Regular-subset.ttf",
    scripts: ["devanagari"],
  },
  {
    id: "noto-sans-tamil-400",
    family: "Noto Sans Tamil",
    file: "NotoSansTamil-Regular-subset.ttf",
    scripts: ["tamil"],
  },
];

/**
 * Families the system styles name. In production A18b registers the real subset
 * faces under these names; in tests they all alias the Latin fixture, which is
 * what keeps a golden hash a statement about **layout**, not about which
 * commercial font happened to be installed.
 */
export const ALIASED_FAMILIES: readonly string[] = [
  "Inter",
  "Poppins",
  "Montserrat",
  "Bebas Neue",
  "Anton",
  "Roboto Mono",
  "Playfair Display",
];

/** Loads the fixture faces, including the aliases, at one weight and slant. */
export function loadFixtureFonts(weights: readonly number[] = [400, 700, 900]): FontResource[] {
  const fonts: FontResource[] = [];
  for (const fixture of FIXTURE_FONTS) {
    const data = new Uint8Array(readFileSync(join(FIXTURE_FONT_DIR, fixture.file)));
    for (const weight of weights) {
      fonts.push({
        id: `${fixture.id.replace(/-\d+$/, "")}-${String(weight)}`,
        family: fixture.family,
        weight,
        italic: false,
        data,
        scripts: fixture.scripts,
      });
    }
  }
  const latin = fonts.find((font) => font.family === "Noto Sans");
  if (latin !== undefined) {
    for (const family of ALIASED_FAMILIES) {
      for (const weight of weights) {
        fonts.push({
          id: `${family.toLowerCase().replace(/\s+/g, "-")}-${String(weight)}`,
          family,
          weight,
          italic: false,
          data: latin.data,
          scripts: ["latin"],
        });
      }
    }
  }
  return fonts;
}

/** A registry holding every fixture face. */
export function createFixtureRegistry(): FontRegistry {
  return createFontRegistry(loadFixtureFonts());
}

export interface FixtureRenderer {
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
}

/** Registry + HarfBuzz shaper, the pair every test and benchmark starts from. */
export async function createFixtureRenderer(): Promise<FixtureRenderer> {
  const registry = createFixtureRegistry();
  const shaper = await createHarfBuzzShaper(registry);
  return { registry, shaper };
}

/** One caption fixture: a script, a segment and its words. */
export interface CaptionFixture {
  readonly name: string;
  readonly script: WordScript;
  readonly segment: { readonly id: string; readonly startMs: number; readonly endMs: number };
  readonly words: readonly RenderWord[];
}

function evenlyTimed(
  texts: readonly string[],
  startMs: number,
  endMs: number,
  prefix: string,
): RenderWord[] {
  const span = endMs - startMs;
  return texts.map((text, index) => ({
    wid: `${prefix}:${String(index)}`,
    t: text,
    s: startMs + Math.round((span * index) / texts.length),
    e: startMs + Math.round((span * (index + 1)) / texts.length),
    sp: "sp1",
  }));
}

/**
 * The four caption fixtures. The Hinglish one mixes Roman and Devanagari inside
 * a single caption on purpose: it is the case the font-fallback path exists for,
 * and the one a naive shaper renders as tofu.
 */
export const CAPTION_FIXTURES: readonly CaptionFixture[] = [
  {
    name: "hinglish",
    script: "latin",
    segment: { id: "fx-hinglish", startMs: 0, endMs: 3000 },
    words: evenlyTimed(
      ["Bhai", "aaj", "video", "editing", "के", "बारे", "में", "baat", "karenge"],
      0,
      3000,
      "0",
    ),
  },
  {
    name: "hindi",
    script: "devanagari",
    segment: { id: "fx-hindi", startMs: 0, endMs: 3000 },
    words: evenlyTimed(
      ["देखो", "पहले", "ट्रांसक्रिप्ट", "लो", "फिर", "काटो", "बहुत", "आसान"],
      0,
      3000,
      "1",
    ),
  },
  {
    name: "tamil",
    script: "tamil",
    segment: { id: "fx-tamil", startMs: 0, endMs: 3000 },
    words: evenlyTimed(["இன்று", "நாம்", "வீடியோ", "எடிட்டிங்", "பற்றி", "பேசுவோம்"], 0, 3000, "2"),
  },
  {
    name: "english",
    script: "latin",
    segment: { id: "fx-english", startMs: 0, endMs: 3000 },
    words: evenlyTimed(
      ["Get", "the", "transcript", "first", "then", "cut", "it", "is", "that", "simple"],
      0,
      3000,
      "3",
    ),
  },
];

/** The three instants the golden suite samples: entry, middle, exit. */
export const GOLDEN_TIMESTAMPS_MS: readonly number[] = [80, 1500, 2940];

/** The canvas the golden suite renders at: the 9:16 master. */
export const GOLDEN_CANVAS: CanvasSize = { width: 1080, height: 1920 };

/** The 540p proxy the editor previews at; used by the relative-sizing tests. */
export const PROXY_CANVAS: CanvasSize = { width: 540, height: 960 };
