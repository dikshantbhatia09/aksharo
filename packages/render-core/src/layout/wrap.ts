/**
 * Line breaking.
 *
 * The segmenter has already decided how many words a caption holds and that
 * they fit `maxLines` lines of 32/24/22 characters (`09 §3`). Layout's job is
 * to reproduce **that** split, not to invent a new one — so the first pass is
 * the segmenter's own greedy character wrap, with the segmenter's own counting
 * rule (base code points, combining marks excluded).
 *
 * Only when the real font metrics overflow the box does anything else happen,
 * and then the answer is shrink-to-fit (`layout.ts`), not a re-wrap. Re-wrapping
 * by width is the last resort before hard-breaking inside a word.
 */

import { charCount } from "../script.js";

export interface WrapItem {
  readonly text: string;
  /** Characters the item spends from the line budget. */
  readonly chars: number;
}

/** Turns display texts into wrap items using the segmenter's counting rule. */
export function toWrapItems(texts: readonly string[]): WrapItem[] {
  return texts.map((text) => ({ text, chars: charCount(text) }));
}

/**
 * The segmenter's greedy wrap: a word joins the current line when the line,
 * one space and the word still fit the budget. Returns index ranges, one per
 * line, so callers keep their own word objects.
 */
export function wrapByCharacters(items: readonly WrapItem[], maxCharsPerLine: number): number[][] {
  if (items.length === 0) return [];
  const lines: number[][] = [];
  let current: number[] = [];
  let lineChars = 0;

  for (const [index, item] of items.entries()) {
    if (current.length === 0) {
      current = [index];
      lineChars = item.chars;
      continue;
    }
    if (lineChars + 1 + item.chars <= maxCharsPerLine) {
      current.push(index);
      lineChars += 1 + item.chars;
      continue;
    }
    lines.push(current);
    current = [index];
    lineChars = item.chars;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Redistributes items into exactly `maxLines` lines when the character wrap
 * asked for more than the style allows. Greedy on a budget of
 * `ceil(totalChars / maxLines)`, which balances the lines instead of leaving a
 * one-word orphan; the width check afterwards decides whether it also needs to
 * shrink.
 */
export function balanceIntoLines(items: readonly WrapItem[], maxLines: number): number[][] {
  if (items.length === 0) return [];
  if (maxLines <= 1) return [items.map((_item, index) => index)];

  const total = items.reduce((sum, item) => sum + item.chars + 1, -1);
  const budget = Math.max(1, Math.ceil(total / maxLines));
  const lines: number[][] = [];
  let current: number[] = [];
  let lineChars = 0;

  for (const [index, item] of items.entries()) {
    const remainingItems = items.length - index;
    const linesLeft = maxLines - lines.length;
    const mustStartNewLine =
      current.length > 0 && lineChars + 1 + item.chars > budget && linesLeft > 1;
    // Never leave a line with nothing in it: if every remaining item is needed
    // to fill the remaining lines, break now.
    const mustBreakToFill = current.length > 0 && remainingItems < linesLeft;
    if (mustStartNewLine || mustBreakToFill) {
      lines.push(current);
      current = [index];
      lineChars = item.chars;
      continue;
    }
    if (current.length === 0) {
      current = [index];
      lineChars = item.chars;
    } else {
      current.push(index);
      lineChars += 1 + item.chars;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Wrap by measured width, used only after shrink-to-fit has hit its floor.
 * `widthOf(index)` returns the item's advance in pixels and `spaceWidth` the
 * inter-word gap.
 */
export function wrapByWidth(
  items: readonly WrapItem[],
  widthOf: (index: number) => number,
  spaceWidth: number,
  maxWidthPx: number,
): number[][] {
  if (items.length === 0) return [];
  const lines: number[][] = [];
  let current: number[] = [];
  let width = 0;

  for (let index = 0; index < items.length; index += 1) {
    const itemWidth = widthOf(index);
    if (current.length === 0) {
      current = [index];
      width = itemWidth;
      continue;
    }
    if (width + spaceWidth + itemWidth <= maxWidthPx) {
      current.push(index);
      width += spaceWidth + itemWidth;
      continue;
    }
    lines.push(current);
    current = [index];
    width = itemWidth;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Splits one over-wide word at **cluster boundaries** so no piece is wider than
 * `maxWidthPx`. `clusters` are the UTF-16 indices a break may fall on
 * (HarfBuzz cluster starts) and `advanceTo(cluster)` the pixel advance up to
 * one of them. Devanagari matras and Tamil conjuncts therefore never split.
 */
export function breakWordAtClusters(
  text: string,
  clusters: readonly number[],
  advanceTo: (cluster: number) => number,
  maxWidthPx: number,
): string[] {
  if (clusters.length <= 1 || maxWidthPx <= 0) return [text];
  const pieces: string[] = [];
  let start = 0;
  let startAdvance = 0;

  for (let i = 1; i < clusters.length; i += 1) {
    const cluster = clusters[i];
    if (cluster === undefined) continue;
    const advance = advanceTo(cluster) - startAdvance;
    if (advance <= maxWidthPx) continue;
    // The previous boundary is the last one that fitted; never emit an empty piece.
    const previous = clusters[i - 1];
    if (previous === undefined || previous <= start) continue;
    pieces.push(text.slice(start, previous));
    startAdvance = advanceTo(previous);
    start = previous;
  }
  pieces.push(text.slice(start));
  return pieces.filter((piece) => piece.length > 0);
}
