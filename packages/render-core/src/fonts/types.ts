/**
 * The font abstraction. `render-core` never touches the filesystem, a CDN or a
 * system font list (D33): a host registers the bytes it already has — A18b
 * fetches the subset fonts from R2, the desktop app reads them from disk, the
 * tests load the three fixtures — and layout resolves families out of the
 * registry only.
 */

import { type WordScript } from "../script.js";

/** One face: a family at one weight and slant, with its bytes. */
export interface FontResource {
  /**
   * Stable id used by `GlyphRun.fontId`. It is what a backend looks up to find
   * the typeface, so it must survive a round trip through a golden fixture:
   * `"noto-sans-devanagari-400"`, `"ws01H…-inter-700"`.
   */
  readonly id: string;
  /** Family name as a StyleDoc's `typography.fontFamily` spells it. */
  readonly family: string;
  /** 100–900. */
  readonly weight: number;
  readonly italic: boolean;
  /** TTF/OTF bytes. */
  readonly data: Uint8Array;
  /**
   * Scripts the face is known to cover. Purely a hint that orders the fallback
   * search; coverage is still confirmed against the font's own character map.
   */
  readonly scripts?: readonly WordScript[];
}

export interface FontQuery {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  /** Families tried, in order, when `family` cannot draw the text. */
  readonly fallbacks?: readonly string[];
  readonly script?: WordScript;
}

/**
 * Where layout gets faces from. Deliberately synchronous: a caller loads bytes
 * however it likes and registers them before rendering, so a frame never awaits
 * a network round trip halfway through.
 */
export interface FontRegistry {
  register(font: FontResource): void;
  /** Every registered face, in registration order. */
  list(): readonly FontResource[];
  has(id: string): boolean;
  get(id: string): FontResource | undefined;
  /**
   * The best face for a query, or `undefined` when nothing matches. When
   * `codePoints` is given, only faces that can draw **all** of them qualify —
   * that is what makes a Devanagari fallback kick in for a Hinglish line.
   */
  resolve(query: FontQuery, codePoints?: readonly number[]): FontResource | undefined;
}
