/**
 * `layoutSegment` — StyleDoc + words + canvas + time → absolute geometry.
 *
 * Four passes, in this order, and the order is the contract:
 *
 * 1. **Character wrap.** The segmenter's own greedy wrap with the segmenter's
 *    own counting rule, so layout reproduces the split the caption was cut for
 *    (orchestrator addendum, 2026-09-02) instead of inventing another one.
 * 2. **Shrink to fit.** If the real font metrics overflow the box, the type gets
 *    smaller. This is the *only* answer to a mild overflow — the line split does
 *    not move.
 * 3. **Width wrap.** Only once shrinking has hit its floor: re-wrap by measured
 *    width at the floor size, still within `layout.maxLines`.
 * 4. **Cluster break.** Only when one word alone is wider than the box: split it
 *    at HarfBuzz cluster boundaries, so a Devanagari matra or a Tamil conjunct
 *    is never cut in half.
 *
 * Every number the function returns is a canvas pixel, and every one of them is
 * a pure function of the inputs — `animate` and the backends add no geometry of
 * their own.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { type Rect } from "../commands/types.js";
import { RenderError } from "../errors.js";
import { resolveFontOrThrow } from "../fonts/registry.js";
import {
  clusterBoundaries,
  codePointsOf,
  type ShapedRun,
  type Shaper,
} from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { charCount, dominantScript, limitsFor, type WordScript } from "../script.js";
import { assertCanvas, type CanvasSize, clamp, ofCanvasHeight, ofCanvasWidth, ofFontSize, q } from "../units.js";
import { itemise, type ItemisedRun } from "./itemise.js";
import {
  type Layout,
  type LayoutLine,
  type LayoutWord,
  type PlacedGlyph,
  type PlacedRun,
  type RenderSegment,
  type RenderWord,
} from "./types.js";
import { balanceIntoLines, breakWordAtClusters, toWrapItems, wrapByCharacters, wrapByWidth } from "./wrap.js";

/** The smallest fraction of the style's type size shrink-to-fit may use. */
export const MIN_SHRINK = 0.55;

/** Tolerance for "still overflows", in pixels. Below a tenth of a pixel is a fit. */
const OVERFLOW_EPSILON = 0.1;

export interface LayoutOptions {
  readonly style: StyleDoc;
  readonly segment: RenderSegment;
  readonly words: readonly RenderWord[];
  readonly canvas: CanvasSize;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** Output time in ms; picks the visible window for per-word styles. */
  readonly tMs: number;
  /** Overrides the detected script, e.g. when the document forces a language. */
  readonly script?: WordScript;
  /** Overrides the per-script character budget (`Resegment.maxChars`). */
  readonly maxChars?: number;
}

interface Measured {
  readonly word: RenderWord;
  readonly runs: readonly { readonly itemised: ItemisedRun; readonly shaped: ShapedRun }[];
  /** Advance in em: multiply by the type size to get pixels. */
  readonly widthEm: number;
  readonly clusters: number;
}

/** `textTransform` from the style, applied before anything is counted or shaped. */
export function applyTextTransform(text: string, transform: StyleDoc["typography"]["textTransform"]): string {
  switch (transform) {
    case "uppercase":
      return text.toLocaleUpperCase();
    case "lowercase":
      return text.toLocaleLowerCase();
    case "capitalize":
      return text.replace(/(^|\s)(\S)/gu, (_match, lead: string, first: string) => lead + first.toLocaleUpperCase());
    default:
      return text;
  }
}

/**
 * Which words are on screen at `tMs`.
 *
 * `animation.perWord` shows exactly one word (the word-pop family);
 * `layout.wordsPerCue` shows a fixed-size chunk; otherwise the whole caption is
 * up for the whole segment.
 */
export function visibleWords(
  words: readonly RenderWord[],
  style: StyleDoc,
  tMs: number,
): readonly RenderWord[] {
  if (words.length === 0) return words;
  if (style.animation.perWord) {
    return [words[indexAt(words, tMs)] as RenderWord];
  }
  const perCue = style.layout.wordsPerCue;
  if (perCue === undefined || perCue >= words.length) return words;
  const chunk = Math.floor(indexAt(words, tMs) / perCue);
  return words.slice(chunk * perCue, chunk * perCue + perCue);
}

/** Index of the word being spoken at `tMs`, clamped into the caption. */
function indexAt(words: readonly RenderWord[], tMs: number): number {
  let index = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === undefined) continue;
    if (tMs >= word.s) index = i;
    if (tMs >= word.s && tMs < word.e) return i;
  }
  return index;
}

function measure(
  words: readonly RenderWord[],
  style: StyleDoc,
  script: WordScript,
  registry: FontRegistry,
  shaper: Shaper,
): Measured[] {
  const { fontFamily, fallbacks, weight, italic, letterSpacingEm } = style.typography;
  return words.map((word) => {
    const runs = itemise(word.t, registry, {
      family: fontFamily,
      fallbacks,
      weight,
      italic,
      defaultScript: script,
    }).map((itemised) => ({
      itemised,
      shaped: shaper.shape({ text: itemised.text, fontId: itemised.fontId, script: itemised.script }),
    }));

    let widthEm = 0;
    let clusters = 0;
    for (const run of runs) {
      widthEm += run.shaped.advance / run.shaped.upem;
      clusters += clusterBoundaries(run.shaped).length;
    }
    widthEm += letterSpacingEm * Math.max(0, clusters - 1);
    return { word, runs, widthEm, clusters };
  });
}

/** Advance of one space in the caption's primary face, in em. */
function spaceEm(primaryFontId: string, script: WordScript, style: StyleDoc, shaper: Shaper): number {
  const run = shaper.shape({ text: " ", fontId: primaryFontId, script });
  return run.advance / run.upem + style.typography.letterSpacingEm;
}

function lineWidthEm(line: readonly number[], measured: readonly Measured[], space: number): number {
  let width = 0;
  for (const [position, index] of line.entries()) {
    const item = measured[index];
    if (item === undefined) continue;
    width += item.widthEm + (position > 0 ? space : 0);
  }
  return width;
}

function widestLineEm(lines: readonly number[][], measured: readonly Measured[], space: number): number {
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, lineWidthEm(line, measured, space));
  return widest;
}

type Anchor = StyleDoc["layout"]["anchor"];

function anchorOffsets(anchor: Anchor): { readonly h: number; readonly v: number } {
  const h = anchor.endsWith("-left") ? 0 : anchor.endsWith("-right") ? 1 : 0.5;
  const v = anchor.startsWith("top-") ? 0 : anchor.startsWith("bottom-") ? 1 : 0.5;
  return { h, v };
}

function alignOffset(align: StyleDoc["layout"]["align"], blockWidth: number, lineWidth: number): number {
  if (align === "left") return 0;
  if (align === "right") return blockWidth - lineWidth;
  return (blockWidth - lineWidth) / 2;
}

interface Placement {
  readonly runs: PlacedRun[];
  readonly width: number;
}

/**
 * Places one word's shaped runs from a pen position. Letter spacing is added
 * **after a cluster**, never between the glyphs inside one, so marks stay
 * attached to the base they belong to.
 */
function placeWord(
  measured: Measured,
  penX: number,
  baselineY: number,
  fontSizePx: number,
  letterSpacingPx: number,
): Placement {
  const runs: PlacedRun[] = [];
  let x = penX;
  let clustersPlaced = 0;

  for (const { itemised, shaped } of measured.runs) {
    const scale = fontSizePx / shaped.upem;
    const glyphs: PlacedGlyph[] = [];
    const runStart = x;
    for (const [index, glyph] of shaped.glyphs.entries()) {
      glyphs.push({
        id: glyph.id,
        cluster: glyph.cluster,
        x: q(x + glyph.xOffset * scale),
        // HarfBuzz y is up, the canvas is y-down.
        y: q(baselineY - glyph.yOffset * scale),
      });
      x += glyph.xAdvance * scale;
      const next = shaped.glyphs[index + 1];
      const endsCluster = next === undefined || next.cluster !== glyph.cluster;
      if (endsCluster) {
        clustersPlaced += 1;
        if (clustersPlaced < measured.clusters) x += letterSpacingPx;
      }
    }
    runs.push({
      fontId: itemised.fontId,
      fontSizePx: q(fontSizePx),
      script: itemised.script,
      text: itemised.text,
      x: q(runStart),
      y: q(baselineY),
      widthPx: q(x - runStart),
      glyphs,
    });
  }
  return { runs, width: x - penX };
}

function unionBox(boxes: readonly Rect[]): Rect {
  if (boxes.length === 0) return [0, 0, 0, 0];
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    left = Math.min(left, box[0]);
    top = Math.min(top, box[1]);
    right = Math.max(right, box[2]);
    bottom = Math.max(bottom, box[3]);
  }
  return [q(left), q(top), q(right), q(bottom)];
}

/** Splits an over-wide word into pieces that fit, keeping its timing on each. */
function hardBreak(
  measured: readonly Measured[],
  maxWidthPx: number,
  fontSizePx: number,
): { words: RenderWord[]; changed: boolean } {
  const words: RenderWord[] = [];
  let changed = false;
  for (const item of measured) {
    if (item.widthEm * fontSizePx <= maxWidthPx + OVERFLOW_EPSILON || item.runs.length === 0) {
      words.push(item.word);
      continue;
    }
    const first = item.runs[0];
    if (first === undefined) {
      words.push(item.word);
      continue;
    }
    const scale = fontSizePx / first.shaped.upem;
    const clusters = clusterBoundaries(first.shaped);
    const advanceTo = (cluster: number): number => {
      let total = 0;
      for (const glyph of first.shaped.glyphs) {
        if (glyph.cluster < cluster) total += glyph.xAdvance;
      }
      return total * scale;
    };
    const pieces = breakWordAtClusters(first.shaped.text, clusters, advanceTo, maxWidthPx);
    const tail = item.word.t.slice(first.shaped.text.length);
    if (pieces.length <= 1 && tail.length === 0) {
      words.push(item.word);
      continue;
    }
    changed = true;
    const all = tail.length > 0 ? [...pieces, tail] : pieces;
    const span = Math.max(1, item.word.e - item.word.s);
    for (const [index, piece] of all.entries()) {
      words.push({
        ...item.word,
        wid: index === 0 ? item.word.wid : `${item.word.wid}/${String(index)}`,
        t: piece,
        s: item.word.s + Math.round((span * index) / all.length),
        e: item.word.s + Math.round((span * (index + 1)) / all.length),
      });
    }
  }
  // Re-measuring is the caller's job; returning the words keeps this pure.
  return { words, changed };
}

export function layoutSegment(options: LayoutOptions): Layout {
  const { style, segment, canvas, registry, shaper, tMs } = options;
  assertCanvas(canvas);

  const transformed: RenderWord[] = visibleWords(options.words, style, tMs)
    .map((word) => ({ ...word, t: applyTextTransform(word.t, style.typography.textTransform) }))
    .filter((word) => word.t.trim().length > 0);

  const script = options.script ?? dominantScript(transformed.map((word) => word.t));
  const maxChars = options.maxChars ?? limitsFor(script).maxCharsPerLine;
  const baseFontSizePx = ofCanvasHeight(style.typography.sizePct, canvas);
  const maxWidthPx = ofCanvasWidth(style.layout.maxWidthPct, canvas);
  const safeMarginPx = ofCanvasHeight(style.layout.safeAreaPct ?? 0, canvas);

  const primary = resolveFontOrThrow(registry, {
    family: style.typography.fontFamily,
    fallbacks: style.typography.fallbacks,
    weight: style.typography.weight,
    italic: style.typography.italic,
    script,
  });
  const faceMetrics = shaper.metrics(primary.id);

  let measured = measure(transformed, style, script, registry, shaper);
  const space = spaceEm(primary.id, script, style, shaper);

  // Pass 1 — the segmenter's character wrap.
  let lines = wrapByCharacters(toWrapItems(measured.map((item) => item.word.t)), maxChars);
  if (lines.length > style.layout.maxLines) {
    lines = balanceIntoLines(toWrapItems(measured.map((item) => item.word.t)), style.layout.maxLines);
  }

  // Pass 2 — shrink to fit.
  const fit = (candidate: number[][], items: readonly Measured[]): number => {
    const widest = widestLineEm(candidate, items, space);
    const widthPx = widest * baseFontSizePx;
    const heightPx = candidate.length * baseFontSizePx * style.typography.lineHeight;
    const maxHeightPx = Math.max(1, canvas.height - 2 * safeMarginPx);
    const byWidth = widthPx <= maxWidthPx ? 1 : maxWidthPx / widthPx;
    const byHeight = heightPx <= maxHeightPx ? 1 : maxHeightPx / heightPx;
    return clamp(Math.min(byWidth, byHeight), MIN_SHRINK, 1);
  };
  let shrink = fit(lines, measured);

  const overflows = (candidate: number[][], items: readonly Measured[], scale: number): boolean =>
    widestLineEm(candidate, items, space) * baseFontSizePx * scale > maxWidthPx + OVERFLOW_EPSILON;

  // Pass 3 — re-wrap by measured width, only after the shrink floor was hit.
  if (overflows(lines, measured, shrink)) {
    const size = baseFontSizePx * shrink;
    const byWidth = wrapByWidth(
      toWrapItems(measured.map((item) => item.word.t)),
      (index) => (measured[index]?.widthEm ?? 0) * size,
      space * size,
      maxWidthPx,
    );
    lines =
      byWidth.length <= style.layout.maxLines
        ? byWidth
        : balanceIntoLines(toWrapItems(measured.map((item) => item.word.t)), style.layout.maxLines);
    shrink = fit(lines, measured);
  }

  // Pass 4 — one word alone is wider than the box: break it at cluster boundaries.
  if (overflows(lines, measured, shrink)) {
    const broken = hardBreak(measured, maxWidthPx, baseFontSizePx * shrink);
    if (broken.changed) {
      measured = measure(broken.words, style, script, registry, shaper);
      const size = baseFontSizePx * shrink;
      const byWidth = wrapByWidth(
        toWrapItems(measured.map((item) => item.word.t)),
        (index) => (measured[index]?.widthEm ?? 0) * size,
        space * size,
        maxWidthPx,
      );
      lines =
        byWidth.length <= style.layout.maxLines
          ? byWidth
          : balanceIntoLines(toWrapItems(measured.map((item) => item.word.t)), style.layout.maxLines);
      shrink = fit(lines, measured);
    }
  }

  const fontSizePx = baseFontSizePx * shrink;
  const letterSpacingPx = style.typography.letterSpacingEm * fontSizePx;
  const spacePx = space * fontSizePx;
  const lineHeightPx = fontSizePx * style.typography.lineHeight;
  const ascentPx = (faceMetrics.ascender / faceMetrics.upem) * fontSizePx;
  const descentPx = (-faceMetrics.descender / faceMetrics.upem) * fontSizePx;

  const blockWidth = widestLineEm(lines, measured, space) * fontSizePx;
  // The anchor addresses the **ink** box — the em box the reader sees — not the
  // taller line-height block, so `box`, `paddedBox` and the safe-area clamp all
  // talk about the same rectangle. `inset` is the gap between the top of the
  // first line's slot and the top of its em box.
  const inset = (lineHeightPx - (ascentPx + descentPx)) / 2;
  const inkHeight = (lines.length - 1) * lineHeightPx + ascentPx + descentPx;

  const anchor = (segment.position?.anchor as Anchor | undefined) ?? style.layout.anchor;
  const { h, v } = anchorOffsets(anchor);
  const anchorX = (segment.position?.x ?? style.layout.x) * canvas.width;
  const anchorY = (segment.position?.y ?? style.layout.y) * canvas.height;
  let inkLeft = anchorX - h * blockWidth;
  let inkTop = anchorY - v * inkHeight;

  // Safe area: the padded box, not the type box, is what must stay clear.
  const padding = style.box.enabled ? ofFontSize(style.box.paddingPct, fontSizePx) : 0;
  let clamped = false;
  if (safeMarginPx > 0) {
    const minLeft = safeMarginPx + padding;
    const maxLeft = canvas.width - safeMarginPx - padding - blockWidth;
    const minTop = safeMarginPx + padding;
    const maxTop = canvas.height - safeMarginPx - padding - inkHeight;
    const nextLeft = maxLeft >= minLeft ? clamp(inkLeft, minLeft, maxLeft) : inkLeft;
    const nextTop = maxTop >= minTop ? clamp(inkTop, minTop, maxTop) : inkTop;
    clamped = nextLeft !== inkLeft || nextTop !== inkTop;
    inkLeft = nextLeft;
    inkTop = nextTop;
  }

  const blockLeft = inkLeft;
  const blockTop = inkTop - inset;

  const layoutLines: LayoutLine[] = [];
  const layoutWords: LayoutWord[] = [];
  let wordIndex = 0;

  for (const [lineIndex, line] of lines.entries()) {
    const width = lineWidthEm(line, measured, space) * fontSizePx;
    const lineTop = blockTop + lineIndex * lineHeightPx;
    const baselineY = lineTop + (lineHeightPx - (ascentPx + descentPx)) / 2 + ascentPx;
    let penX = blockLeft + alignOffset(style.layout.align, blockWidth, width);

    const wordsOnLine: LayoutWord[] = [];
    const runsOnLine: PlacedRun[] = [];
    for (const [position, index] of line.entries()) {
      const item = measured[index];
      if (item === undefined) continue;
      if (position > 0) penX += spacePx;
      const placed = placeWord(item, penX, baselineY, fontSizePx, letterSpacingPx);
      const word: LayoutWord = {
        wid: item.word.wid,
        text: item.word.t,
        startMs: item.word.s,
        endMs: item.word.e,
        lineIndex,
        index: wordIndex,
        box: [q(penX), q(baselineY - ascentPx), q(penX + placed.width), q(baselineY + descentPx)],
        runs: placed.runs,
        ...(item.word.sp === undefined ? {} : { sp: item.word.sp }),
        ...(item.word.emphasisPresetId === undefined
          ? {}
          : { emphasisPresetId: item.word.emphasisPresetId }),
      };
      wordsOnLine.push(word);
      layoutWords.push(word);
      runsOnLine.push(...placed.runs);
      penX += placed.width;
      wordIndex += 1;
    }

    layoutLines.push({
      index: lineIndex,
      text: wordsOnLine.map((word) => word.text).join(" "),
      baselineY: q(baselineY),
      box: [
        q(blockLeft + alignOffset(style.layout.align, blockWidth, width)),
        q(baselineY - ascentPx),
        q(blockLeft + alignOffset(style.layout.align, blockWidth, width) + width),
        q(baselineY + descentPx),
      ],
      words: wordsOnLine,
      runs: runsOnLine,
    });
  }

  const box = unionBox(layoutLines.map((line) => line.box));
  const paddedBox: Rect = [
    q(box[0] - padding),
    q(box[1] - padding),
    q(box[2] + padding),
    q(box[3] + padding),
  ];

  return {
    segmentId: segment.id,
    canvas,
    script,
    fontSizePx: q(fontSizePx),
    shrink: q(shrink),
    lineHeightPx: q(lineHeightPx),
    ascentPx: q(ascentPx),
    descentPx: q(descentPx),
    lines: layoutLines,
    words: layoutWords,
    box,
    paddedBox,
    startMs: segment.startMs,
    endMs: segment.endMs,
    clampedToSafeArea: clamped,
  };
}

/** Characters the caption spends, by the segmenter's rule; used by tests and the UI. */
export function captionCharacterCount(words: readonly RenderWord[]): number {
  return words.reduce((total, word, index) => total + charCount(word.t) + (index > 0 ? 1 : 0), 0);
}

/** Exposed for the layout tests; not part of the public surface. */
export const __testing = { anchorOffsets, alignOffset, unionBox, indexAt, spaceEm, hardBreak };

/** Re-exported so callers can check coverage without importing the shaper module. */
export { codePointsOf };

/** Raised when a caller asks for a layout with no words at all. */
export function assertLayoutable(words: readonly RenderWord[], segmentId: string): void {
  if (words.length === 0) {
    throw new RenderError("render/invalid-input", `segment ${segmentId} has no words to lay out`, {
      segmentId,
    });
  }
}
