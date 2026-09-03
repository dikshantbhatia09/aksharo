/**
 * D06 Text FX motion presets — six named entry/hold/exit curves shared by the
 * browser (CanvasKit) and cloud (Skia-node) render engines, since both draw
 * from the same `DrawCommand[]` this module (not either backend) produces the
 * numbers for.
 *
 * Every preset is a pure function of `progress` (0..1 through the item's own
 * `[startMs, endMs)` window, see {@link textFxProgress}) so a scrub or a
 * render worker can recompute frame N without frame N-1.
 */

import {
  easeOutBack,
  easeOutCubic,
  easeOutQuad,
  lerp,
  progress as easeProgress,
} from "../animate/easing.js";
import { clamp01 } from "../units.js";

export const TEXT_FX_MOTION_PRESETS = [
  "pop",
  "slide-up",
  "typewriter",
  "underline",
  "count-up",
  "fade",
] as const;

export type TextFxMotionPreset = (typeof TEXT_FX_MOTION_PRESETS)[number];

/** Suggested preset per intent (brief D06 rule 3); the caller may override. */
export const DEFAULT_PRESET_BY_INTENT: Record<
  "title" | "stat" | "quote" | "hook",
  TextFxMotionPreset
> = {
  title: "pop",
  stat: "count-up",
  quote: "fade",
  hook: "slide-up",
};

export interface TextFxPhase {
  readonly opacity: number;
  readonly scale: number;
  readonly dy: number;
  /** Fraction of the text revealed left-to-right; 1 means "all of it" (typewriter). */
  readonly reveal: number;
  /** Fraction of an underline's sweep drawn so far; 1 means "full width" (underline). */
  readonly underline: number;
  /**
   * The value to show for a `count-up` stat, 0..1 through its own numeric
   * range; the caller maps this fraction onto the actual number to display.
   */
  readonly countFraction: number;
}

const FULL: TextFxPhase = {
  opacity: 1,
  scale: 1,
  dy: 0,
  reveal: 1,
  underline: 1,
  countFraction: 1,
};

const ENTER_MS = 260;
const EXIT_MS = 200;

/** `[0, entering) -> [entering, holding) -> [holding, 1]` phase weights, given overall progress. */
function phaseWeights(progressValue: number, totalMs: number): { enter: number; exit: number } {
  const enterFraction = totalMs > 0 ? Math.min(0.5, ENTER_MS / totalMs) : 0.15;
  const exitFraction = totalMs > 0 ? Math.min(0.5, EXIT_MS / totalMs) : 0.15;
  const enter = enterFraction > 0 ? clamp01(progressValue / enterFraction) : 1;
  const exit = exitFraction > 0 ? clamp01((progressValue - (1 - exitFraction)) / exitFraction) : 0;
  return { enter, exit };
}

/**
 * Evaluates one motion preset at `progressValue` (0..1 through the item's
 * total on-screen window, `totalMs` long). Deterministic and side-effect free.
 */
export function textFxPhase(
  preset: TextFxMotionPreset,
  progressValue: number,
  totalMs: number,
): TextFxPhase {
  const p = clamp01(progressValue);
  const { enter, exit } = phaseWeights(p, totalMs);
  const exitOpacity = 1 - exit;

  switch (preset) {
    case "pop":
      return {
        ...FULL,
        opacity: clamp01(enter * 2) * exitOpacity,
        scale: lerp(0.7, 1, easeOutBack(enter)),
      };
    case "slide-up":
      return {
        ...FULL,
        opacity: enter * exitOpacity,
        dy: lerp(48, 0, easeOutCubic(enter)),
      };
    case "typewriter":
      return { ...FULL, opacity: exitOpacity, reveal: easeOutQuad(enter) };
    case "underline":
      return { ...FULL, opacity: enter * exitOpacity, underline: easeOutCubic(enter) };
    case "count-up":
      return {
        ...FULL,
        opacity: enter * exitOpacity,
        scale: lerp(0.9, 1, easeOutCubic(enter)),
        countFraction: easeOutCubic(enter),
      };
    case "fade":
    default:
      return { ...FULL, opacity: enter * exitOpacity };
  }
}

/** Progress through `[startMs, endMs)`, clamped, for a title item at `tMs`. */
export function textFxProgress(tMs: number, startMs: number, endMs: number): number {
  return easeProgress(tMs, startMs, Math.max(1, endMs - startMs));
}
