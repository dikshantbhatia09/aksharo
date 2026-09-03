/**
 * D06 Text FX drawing — turns a placed title (`placeTitleBox`) and a motion
 * phase (`textFxPhase`) into the same portable `DrawCommand[]` (D33) every
 * other item kind emits, so the browser (CanvasKit) and cloud (Skia-node)
 * backends draw title items exactly the same way a caption is drawn.
 *
 * Text shaping (turning `text` into glyph ids and advances) is the caller's
 * job, same as `animate.ts`'s `toGlyphRun` boundary: this module accepts an
 * already-shaped `GlyphRun` and only positions/animates the box around it.
 */

import {
  fill as makeFill,
  group,
  rect as makeRect,
  scaleTranslateMatrix,
  text as makeText,
  transform,
} from "../commands/build.js";
import { type Color, type DrawCommand, type GlyphRun, type Rect } from "../commands/types.js";
import { clamp01 } from "../units.js";
import { type TextFxPhase } from "./presets.js";

export interface TextFxDrawOptions {
  /** The title's placed box, from `placeTitleBox`. */
  readonly box: Rect;
  readonly phase: TextFxPhase;
  /** The title's shaped text, positioned inside `box` by the caller. */
  readonly glyphRun: GlyphRun;
  readonly textColor: Color;
  /** Highlight/background colour from the brand kit or the style's accent. */
  readonly accentColor?: Color;
  /** Draws a background chip behind the text when true (brief: brand-kit colours). */
  readonly withBackground?: boolean;
  /** Draws the animated underline rule (the `underline` preset only). */
  readonly showUnderline?: boolean;
}

/**
 * Reveals a prefix of `run`'s glyphs, by cluster, for the `typewriter`
 * preset — the same left-to-right reveal `karaokeOverlay` uses for captions,
 * but over the whole run rather than one word's sweep.
 */
function revealedGlyphRun(run: GlyphRun, reveal: number): GlyphRun {
  if (reveal >= 1) return run;
  if (reveal <= 0) return { ...run, glyphs: [], positions: [], clusters: [] };
  const maxCluster = run.text.length * clamp01(reveal);
  const glyphs: number[] = [];
  const positions: number[] = [];
  const clusters: number[] = [];
  for (const [index, cluster] of run.clusters.entries()) {
    if (cluster > maxCluster) continue;
    // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, index-bounded loop counter, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    glyphs.push(run.glyphs[index] as number);
    positions.push(run.positions[index * 2] as number, run.positions[index * 2 + 1] as number);
    clusters.push(cluster);
  }
  return { ...run, glyphs, positions, clusters };
}

/** Builds the commands for one title item at one frame. */
export function drawTextFxTitle(options: TextFxDrawOptions): DrawCommand[] {
  const { box, phase, glyphRun, textColor, accentColor } = options;
  if (phase.opacity <= 0) return [];

  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;

  const shownRun = revealedGlyphRun(glyphRun, phase.reveal);
  const children: DrawCommand[] = [];

  if (options.withBackground === true) {
    children.push(makeRect(box, { fill: makeFill(accentColor ?? "#000000", 0.55) }));
  }
  children.push(makeText(shownRun, { fill: makeFill(textColor) }));

  if (options.showUnderline === true) {
    const thickness = (box[3] - box[1]) * 0.06;
    const width = (box[2] - box[0]) * clamp01(phase.underline);
    children.push(
      makeRect([box[0], box[3] - thickness, box[0] + width, box[3]], {
        fill: makeFill(accentColor ?? textColor),
      }),
    );
  }

  const matrix = scaleTranslateMatrix(phase.scale, cx, cy, 0, phase.dy);
  return [transform(matrix, [group(children, undefined, phase.opacity)])];
}
