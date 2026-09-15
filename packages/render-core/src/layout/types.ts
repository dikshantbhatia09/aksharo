/**
 * What `layoutSegment` produces: absolute geometry for one caption at one
 * instant, with enough structure for `animate` to build commands *and* for
 * `@montaj/ass-exporter` to emit one `\pos`-ed event per word (RR-04 F7).
 *
 * Nothing here is a percentage and nothing is a promise: a `Layout` is finished
 * geometry in canvas pixels.
 */

import { type Rect } from "../commands/types.js";
import { type WordScript } from "../script.js";
import { type CanvasSize } from "../units.js";

/** A word as the renderer sees it: display text plus the timing it keeps. */
export interface RenderWord {
  /** `WordId` from the transcript, or a synthetic id when the text is overridden. */
  readonly wid: string;
  readonly t: string;
  readonly s: number;
  readonly e: number;
  /** Speaker id, for per-speaker colouring (podcast styles). */
  readonly sp?: string;
  /** Emphasis preset applied to this word, resolved from `Segment.emphasis`. */
  readonly emphasisPresetId?: string;
}

/** The part of an EDG `Segment` the renderer reads (CONTRACTS §2). */
export interface RenderSegment {
  readonly id: string;
  readonly seq?: string | number;
  readonly startMs: number;
  readonly endMs: number;
  readonly position?: { readonly x: number; readonly y: number; readonly anchor: string };
  readonly hidden?: boolean;
}

/** One glyph placed on the canvas, y **down** like every other coordinate. */
export interface PlacedGlyph {
  readonly id: number;
  /** UTF-16 index into the run's text this glyph came from. */
  readonly cluster: number;
  readonly x: number;
  readonly y: number;
}

/** A shaped, positioned run: one text, one face, one script. */
export interface PlacedRun {
  readonly fontId: string;
  readonly fontSizePx: number;
  readonly script: WordScript;
  readonly text: string;
  /** Baseline origin of the run. */
  readonly x: number;
  readonly y: number;
  readonly widthPx: number;
  readonly glyphs: readonly PlacedGlyph[];
}

/** A word placed on a line, with the box a highlight or a box-mode style draws. */
export interface LayoutWord {
  /** Editorial composition rotation, around the word's own box centre. */
  readonly rotationDeg?: number;
  readonly wid: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly lineIndex: number;
  /** Index of the word within the whole caption, in reading order. */
  readonly index: number;
  /** Em box of the word: x from the shaped advance, y from the face's metrics. */
  readonly box: Rect;
  readonly runs: readonly PlacedRun[];
  readonly sp?: string;
  readonly emphasisPresetId?: string;
}

export interface LayoutLine {
  readonly index: number;
  readonly text: string;
  readonly baselineY: number;
  /** Em box of the line, before any box padding. */
  readonly box: Rect;
  readonly words: readonly LayoutWord[];
  readonly runs: readonly PlacedRun[];
}

export interface Layout {
  readonly segmentId: string;
  readonly segmentSeq?: string | number;
  readonly canvas: CanvasSize;
  readonly script: WordScript;
  /** Type size actually used, i.e. after shrink-to-fit. */
  readonly fontSizePx: number;
  /** 1 when the caption fitted; < 1 when the metrics forced it smaller. */
  readonly shrink: number;
  readonly lineHeightPx: number;
  /** Distance from baseline to the top of the em box, positive. */
  readonly ascentPx: number;
  /** Distance from baseline to the bottom of the em box, positive. */
  readonly descentPx: number;
  readonly lines: readonly LayoutLine[];
  readonly words: readonly LayoutWord[];
  /** Union of the line boxes, before box padding. */
  readonly box: Rect;
  /** `box` grown by the style's box padding; what a `block` box draws. */
  readonly paddedBox: Rect;
  /** Times the caption is on screen; `animate` derives its progress from these. */
  readonly startMs: number;
  readonly endMs: number;
  /** True when the caption was clamped by the safe area. */
  readonly clampedToSafeArea: boolean;
}
