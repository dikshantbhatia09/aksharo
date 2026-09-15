import type { StyleDoc } from "@montaj/caption-styles/browser";

import { group, transform } from "../commands/build.js";
import { typographyKeyword } from "../layout/typography-motion.js";
import { clamp01, q } from "../units.js";
import { easeOutBack, easeOutCubic, lerp, progress } from "./easing.js";

import type { DrawCommand, Matrix } from "../commands/types.js";
import type { Layout, LayoutWord } from "../layout/types.js";

function matrix(scale: number, degrees: number, cx: number, cy: number, dx = 0, dy = 0): Matrix {
  const radians = (degrees * Math.PI) / 180;
  const a = Math.cos(radians) * scale;
  const b = Math.sin(radians) * scale;
  return [q(a), q(b), q(-b), q(a), q(cx - a * cx + b * cy + dx), q(cy - b * cx - a * cy + dy)];
}

/** Reveal whole shaped clusters, including all glyphs in an Indic conjunct. */
export function revealTypographyWord(word: LayoutWord, amount: number): LayoutWord {
  if (amount >= 1) return word;
  const boundaries = word.runs.map((run) =>
    [...new Set(run.glyphs.map((glyph) => glyph.cluster))].sort((a, b) => a - b),
  );
  let remaining = Math.ceil(
    boundaries.reduce((count, clusters) => count + clusters.length, 0) * clamp01(amount),
  );
  return {
    ...word,
    runs: word.runs.map((run, index) => {
      const clusters = boundaries.at(index) ?? [];
      const visible = new Set(clusters.slice(0, remaining));
      remaining = Math.max(0, remaining - clusters.length);
      return { ...run, glyphs: run.glyphs.filter((glyph) => visible.has(glyph.cluster)) };
    }),
  };
}

/** All movement is a pure function of caption/word timestamps, including seeks. */
export function typographyMotionCommands(
  layout: Layout,
  style: StyleDoc,
  tMs: number,
  drawWord: (word: LayoutWord) => DrawCommand[],
): DrawCommand[] {
  const motion = style.animation.typographyMotion;
  const keyword = typographyKeyword(layout, style);
  if (motion === undefined || keyword === undefined) return [];
  const cx = (layout.box[0] + layout.box[2]) / 2;
  const cy = (layout.box[1] + layout.box[3]) / 2;
  const span = Math.max(1, layout.endMs - layout.startMs);
  const enterDuration = Math.min(style.animation.in.durationMs, span * 0.25);
  const exitDuration = Math.min(style.animation.out.durationMs, span * 0.2);
  const enter =
    style.animation.in.type === "none" ? 1 : progress(tMs, layout.startMs, enterDuration);
  const exit =
    style.animation.out.type === "none"
      ? 0
      : progress(tMs, layout.endMs - exitDuration, exitDuration);
  const travel = progress(tMs, layout.startMs, span);
  const body: DrawCommand[] = [];

  if (motion.ghostOpacity > 0 && motion.mode !== "stack") {
    const width = Math.max(1, keyword.box[2] - keyword.box[0]);
    const ghostScale = Math.min(8, (layout.canvas.width * 0.94) / width) * lerp(0.97, 1.07, travel);
    const kx = (keyword.box[0] + keyword.box[2]) / 2;
    const ky = (keyword.box[1] + keyword.box[3]) / 2;
    body.push(
      group(
        [
          transform(
            matrix(
              ghostScale,
              0,
              kx,
              ky,
              cx - kx,
              cy - ky - (motion.mode === "focus" ? layout.fontSizePx * 0.2 : 0),
            ),
            drawWord(keyword),
          ),
        ],
        "typography:ghost",
        motion.ghostOpacity,
      ),
    );
  }

  for (const word of layout.words) {
    const isKeyword = word.wid === keyword.wid;
    const start = Math.max(layout.startMs, Math.min(word.startMs, layout.endMs - 1));
    const duration = Math.min(enterDuration, Math.max(1, word.endMs - start) * 0.65);
    const reveal = progress(tMs, start, duration);
    const future = tMs < start;
    if (future && motion.mode !== "stack") continue;
    const wordCx = (word.box[0] + word.box[2]) / 2;
    const wordCy = (word.box[1] + word.box[3]) / 2;
    const scale = isKeyword ? lerp(0.68, 1, easeOutBack(reveal)) : 1;
    const dy = isKeyword ? 0 : (1 - easeOutCubic(reveal)) * layout.fontSizePx * 0.22;
    const opacity = future ? 0.12 : isKeyword ? clamp01(reveal * 3) : 1;
    const typed = isKeyword || future ? word : revealTypographyWord(word, reveal);
    const rotation =
      (word.rotationDeg ?? 0) + (motion.mode === "stack" ? (1 - easeOutCubic(reveal)) * -7 : 0);
    body.push(
      group(
        [transform(matrix(scale, rotation, wordCx, wordCy, 0, dy), drawWord(typed))],
        `typography:word:${word.wid}`,
        opacity,
      ),
    );
  }

  // Stable alternation for the pan direction; never depends on playback history.
  const direction = Math.floor(layout.startMs / 1000) % 2 === 0 ? -1 : 1;
  const leave = exit * exit * exit;
  const scale =
    motion.mode === "focus" ? lerp(1.18, 1, easeOutCubic(enter)) + leave * 1.6 : 1 + leave * 0.12;
  const dx = direction * layout.canvas.width * ((1 - easeOutCubic(enter)) * 0.12 + leave * 0.65);
  const rotation = motion.mode === "stack" ? direction * leave * 9 : direction * leave * 2;
  return [transform(matrix(scale, rotation, cx, cy, dx), body)];
}
