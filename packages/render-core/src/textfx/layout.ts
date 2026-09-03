/**
 * D06 Text FX layout solver — places one title box on the canvas so it never
 * intersects the caption's safe area, for any caption position × title size.
 *
 * `placeTitleBox` is deterministic and geometry-only: it takes the caption's
 * own `paddedBox` (the rectangle `layoutSegment` already keeps clear of the
 * safe-area margins, or `undefined` when no caption is on screen at this
 * frame), the canvas size and the title's measured width/height, and returns
 * a rectangle from a fixed slot order — never a rectangle that overlaps the
 * caption box, and never one that crosses the canvas's own safe margin.
 *
 * ### Slot order (03-architecture/09-ai-pipeline.md §6, brief D06 rule 2)
 *
 * 1. `top-third` — caption sits at the bottom (or nowhere): the title centres
 *    in the top third of the frame.
 * 2. `upper-left` / `upper-right` — caption occupies the top third itself
 *    (an unusual style override): the title moves to whichever upper corner
 *    has more horizontal room outside the caption's own box.
 * 3. `centre` — caption is confined to a side margin (neither top nor
 *    bottom third), so the frame's vertical centre is clear on both edges.
 *
 * Every candidate is clamped inside `[safeMarginPx, canvas.width -
 * safeMarginPx]` × the same for height, and a candidate is accepted only when
 * it does not intersect the caption box (`rectsOverlap` returns false). If
 * every slot on the fixed list would overlap — a title taller than a third of
 * the frame, say — the solver keeps searching down the list and finally
 * falls back to whichever candidate overlaps the caption **least**, still
 * clamped to the safe area, so the function always returns a rectangle
 * (never throws) and never regresses to drawing on top of a caption when a
 * clear slot exists.
 */

import { type Rect } from "../commands/types.js";
import { type CanvasSize } from "../units.js";

export type TextFxSlot = "top-third" | "upper-left" | "upper-right" | "centre";

export interface TitleSize {
  readonly width: number;
  readonly height: number;
}

export interface PlaceTitleOptions {
  readonly canvas: CanvasSize;
  /** The caption's own safe-area rectangle at this frame, or `undefined` when none is visible. */
  readonly captionBox?: Rect | undefined;
  readonly title: TitleSize;
  /** Fraction of the canvas's shorter side kept clear on every edge; default 0.06. */
  readonly safeAreaFraction?: number;
}

export interface TitlePlacement {
  readonly slot: TextFxSlot;
  readonly box: Rect;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function overlapArea(a: Rect, b: Rect): number {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const bottom = Math.min(a[3], b[3]);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function clampBox(box: Rect, canvas: CanvasSize, margin: number): Rect {
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  const minLeft = margin;
  const maxLeft = Math.max(minLeft, canvas.width - margin - width);
  const minTop = margin;
  const maxTop = Math.max(minTop, canvas.height - margin - height);
  const left = Math.min(Math.max(box[0], minLeft), maxLeft);
  const top = Math.min(Math.max(box[1], minTop), maxTop);
  return [left, top, left + width, top + height];
}

function centredAt(cx: number, cy: number, size: TitleSize): Rect {
  return [cx - size.width / 2, cy - size.height / 2, cx + size.width / 2, cy + size.height / 2];
}

function candidateBoxes(
  canvas: CanvasSize,
  captionBox: Rect | undefined,
  title: TitleSize,
): readonly { slot: TextFxSlot; box: Rect }[] {
  const thirdHeight = canvas.height / 3;
  const centreX = canvas.width / 2;

  const topThird = centredAt(centreX, thirdHeight / 2, title);
  const upperLeft = centredAt(canvas.width * 0.26, thirdHeight * 0.5, title);
  const upperRight = centredAt(canvas.width * 0.74, thirdHeight * 0.5, title);
  const centre = centredAt(centreX, canvas.height / 2, title);

  const candidates: { slot: TextFxSlot; box: Rect }[] = [];

  if (captionBox === undefined || captionBox[3] <= thirdHeight) {
    // Nothing (or only an upper-third caption) below the top third: prefer it.
    candidates.push({ slot: "top-third", box: topThird });
  }
  candidates.push({ slot: "upper-left", box: upperLeft });
  candidates.push({ slot: "upper-right", box: upperRight });
  candidates.push({ slot: "centre", box: centre });
  if (captionBox !== undefined && captionBox[3] > thirdHeight) {
    // Caption at the bottom (or covering the centre): top-third is the safest
    // fallback even though it was not tried first above.
    candidates.push({ slot: "top-third", box: topThird });
  }
  return candidates;
}

/**
 * Deterministic slot solver: same inputs, same output, always inside the
 * safe area, never overlapping `captionBox` when a non-overlapping slot
 * exists on the fixed candidate list.
 */
export function placeTitleBox(options: PlaceTitleOptions): TitlePlacement {
  const { canvas, captionBox, title } = options;
  const safeFraction = options.safeAreaFraction ?? 0.06;
  const margin = Math.min(canvas.width, canvas.height) * safeFraction;

  const candidates = candidateBoxes(canvas, captionBox, title).map((candidate) => ({
    slot: candidate.slot,
    box: clampBox(candidate.box, canvas, margin),
  }));

  for (const candidate of candidates) {
    if (captionBox === undefined || !rectsOverlap(candidate.box, captionBox)) {
      return candidate;
    }
  }

  // Every candidate overlaps: keep the one that overlaps least (deterministic
  // tie-break: candidate order), still clamped to the safe area.
  let best = candidates[0] as { slot: TextFxSlot; box: Rect };
  let bestOverlap = captionBox === undefined ? 0 : overlapArea(best.box, captionBox);
  for (const candidate of candidates.slice(1)) {
    const area = captionBox === undefined ? 0 : overlapArea(candidate.box, captionBox);
    if (area < bestOverlap) {
      best = candidate;
      bestOverlap = area;
    }
  }
  return best;
}

export { rectsOverlap };
