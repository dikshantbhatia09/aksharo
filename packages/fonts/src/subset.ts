/**
 * Subsetting and WOFF2 conversion, both on `hb-subset` (the same HarfBuzz that
 * shapes the captions, compiled to wasm).
 *
 * Two things are produced from one source face:
 *
 * - an **SFNT** (`.ttf`) subset, which is what HarfBuzz shapes and what
 *   CanvasKit and `@napi-rs/canvas` rasterise. Neither reads WOFF2, so this is
 *   the format every renderer actually registers;
 * - a **WOFF2** twin of the same subset, about a third of the size, which is
 *   what the browser downloads and what a CSS `@font-face` can use directly.
 *
 * Two properties are load-bearing and both are tested:
 *
 * 1. **Shaping does not change.** `hb-subset` renumbers glyph ids, so the glyph
 *    *ids* differ before and after — but the cluster structure and every advance
 *    are identical, which is what layout and the parity goldens depend on.
 *    `subset.test.ts` shapes Devanagari, Tamil and Latin samples through the
 *    real HarfBuzz shaper on both faces and compares.
 * 2. **A variable font is instanced, not carried.** Passing `axes` pins the
 *    variation axes and writes a static face, so the browser and the cloud
 *    cannot disagree about which instance a default resolves to. A variable font
 *    that reached a renderer un-instanced is the "variable-font instancing bug"
 *    the brief names.
 */

import subsetFont from "subset-font";

import { subsetText, type ScriptTag } from "./scripts.js";

/**
 * The layout features Indic shaping depends on.
 *
 * They are **not** passed to `hb-subset`: its default retained-feature set
 * already contains every one of them, and naming a list would *restrict* the
 * set rather than add to it — dropping, say, `dist` or a script-specific
 * feature this list forgot. They are written down because the subsetting
 * round-trip test exists to prove they survived, and a reader deserves to know
 * what "shaping is unchanged" is actually about.
 */
export const REQUIRED_LAYOUT_FEATURES: readonly string[] = [
  "abvf",
  "abvs",
  "akhn",
  "blwf",
  "blws",
  "cjct",
  "half",
  "haln",
  "nukt",
  "pref",
  "pres",
  "pstf",
  "psts",
  "rkrf",
  "rphf",
  "vatu",
  "kern",
  "liga",
  "mark",
  "mkmk",
];

/** Tables no renderer reads and every one of which is worth dropping. */
export const DROPPED_TABLES: readonly string[] = ["DSIG", "LTSH", "VDMX", "hdmx", "PCLT"];

export interface SubsetOptions {
  /** Scripts to keep; the common punctuation set is always added. */
  readonly scripts: readonly ScriptTag[];
  /** Axis values to pin, for a variable source. */
  readonly axes?: Readonly<Record<string, number>>;
  /** Extra characters to keep beyond the scripts' ranges. */
  readonly extraText?: string;
}

export class FontSubsetError extends Error {
  public override readonly name = "FontSubsetError";
  constructor(
    readonly code: "fonts/subset_failed",
    message: string,
  ) {
    super(message);
  }
}

async function run(
  bytes: Uint8Array,
  text: string,
  format: "truetype" | "woff2",
  axes: Readonly<Record<string, number>> | undefined,
): Promise<Uint8Array> {
  try {
    const result = await subsetFont(Buffer.from(bytes), text, {
      targetFormat: format,
      dropTables: DROPPED_TABLES,
      ...(axes === undefined ? {} : { variationAxes: axes }),
    });
    return new Uint8Array(result);
  } catch (error) {
    throw new FontSubsetError(
      "fonts/subset_failed",
      `hb-subset could not produce a ${format} subset: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The subset SFNT every renderer registers. */
export async function subsetToSfnt(bytes: Uint8Array, options: SubsetOptions): Promise<Uint8Array> {
  return run(
    bytes,
    subsetText(options.scripts) + (options.extraText ?? ""),
    "truetype",
    options.axes,
  );
}

/** The same subset as WOFF2, for the wire. */
export async function subsetToWoff2(
  bytes: Uint8Array,
  options: SubsetOptions,
): Promise<Uint8Array> {
  return run(bytes, subsetText(options.scripts) + (options.extraText ?? ""), "woff2", options.axes);
}

export interface SubsetPair {
  readonly sfnt: Uint8Array;
  readonly woff2: Uint8Array;
}

/**
 * Both formats of one face.
 *
 * They are produced by two `hb-subset` runs over the same input and the same
 * character set rather than by compressing the first result, so a WOFF2 that
 * somehow disagreed with its SFNT would have to disagree inside HarfBuzz. The
 * round-trip test decompresses the WOFF2 and shapes it to prove they do not.
 */
export async function subsetFace(bytes: Uint8Array, options: SubsetOptions): Promise<SubsetPair> {
  const [sfnt, woff2] = await Promise.all([
    subsetToSfnt(bytes, options),
    subsetToWoff2(bytes, options),
  ]);
  return { sfnt, woff2 };
}
