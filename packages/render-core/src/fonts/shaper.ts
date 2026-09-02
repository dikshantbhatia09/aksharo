/**
 * The shaping boundary. Layout asks a `Shaper` to turn (text, face, script)
 * into glyph ids and advances **in font units**; it never asks for pixels.
 *
 * Shaping in font units and scaling in TypeScript is deliberate. HarfBuzz's
 * integer arithmetic at the font's own upem is identical on every platform, so
 * two machines produce the same glyph ids and the same advances; doing the
 * multiply by `fontSizePx / upem` in double precision afterwards keeps the
 * pixel positions exact rather than pre-rounded, which is what lets the browser
 * and the cloud agree (D33's parity SLO).
 */

import { type WordScript } from "../script.js";

/** One glyph as HarfBuzz reports it, in font units. */
export interface ShapedGlyph {
  /** Glyph id in the face. */
  readonly id: number;
  /** Index of the code point in the run's text this glyph belongs to. */
  readonly cluster: number;
  readonly xAdvance: number;
  readonly yAdvance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

/** A shaped run of one text in one face. */
export interface ShapedRun {
  readonly text: string;
  readonly fontId: string;
  /** The face's units per em; every measurement below is in these units. */
  readonly upem: number;
  readonly glyphs: readonly ShapedGlyph[];
  /** Sum of the glyph advances, in font units. */
  readonly advance: number;
}

/** Vertical metrics of a face, in font units. */
export interface FontMetrics {
  readonly upem: number;
  readonly ascender: number;
  /** Negative, as HarfBuzz reports it. */
  readonly descender: number;
  readonly lineGap: number;
}

export interface ShapeRequest {
  readonly text: string;
  readonly fontId: string;
  readonly script: WordScript;
  /** BCP-47 tag; only affects language-specific OpenType features. */
  readonly language?: string;
  /** OpenType feature tags to force on, e.g. `["liga", "kern"]`. */
  readonly features?: readonly string[];
}

/**
 * What layout needs from HarfBuzz. Kept tiny and synchronous so it can be
 * faked in a unit test without a wasm module: the fake in `testing.ts` is the
 * proof that layout has no hidden dependency on the real shaper.
 */
export interface Shaper {
  shape(request: ShapeRequest): ShapedRun;
  metrics(fontId: string): FontMetrics;
  /** Whether the face has a glyph for every code point. */
  covers(fontId: string, codePoints: readonly number[]): boolean;
  /** SVG path of one glyph in font units, y **up** as the font stores it. */
  glyphPath(fontId: string, glyphId: number): string;
}

/** Code points of a string, one entry per code point (not per UTF-16 unit). */
export function codePointsOf(text: string): number[] {
  const points: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code !== undefined) points.push(code);
  }
  return points;
}

/**
 * Distinct cluster values in a shaped run, ascending. A cluster is the smallest
 * unit a karaoke fill or a hard line break may cut on — for `हिंदी` that is the
 * whole syllable, not the matra.
 */
export function clusterBoundaries(run: ShapedRun): number[] {
  const seen: number[] = [];
  let previous = -1;
  for (const glyph of run.glyphs) {
    if (glyph.cluster !== previous) {
      if (!seen.includes(glyph.cluster)) seen.push(glyph.cluster);
      previous = glyph.cluster;
    }
  }
  return seen.sort((a, b) => a - b);
}

/**
 * Advance of the glyphs whose cluster falls in `[fromCluster, toCluster)`, in
 * font units. The karaoke fill sweeps a clip rectangle across exactly this
 * width, so it lands on cluster boundaries rather than mid-conjunct.
 */
export function advanceOfClusterRange(
  run: ShapedRun,
  fromCluster: number,
  toCluster: number,
): number {
  let total = 0;
  for (const glyph of run.glyphs) {
    if (glyph.cluster >= fromCluster && glyph.cluster < toCluster) total += glyph.xAdvance;
  }
  return total;
}
