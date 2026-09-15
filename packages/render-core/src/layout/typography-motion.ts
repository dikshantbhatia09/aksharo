import type { StyleDoc } from "@montaj/caption-styles/browser";

import { clamp, q } from "../units.js";

import type { Layout, LayoutLine, LayoutWord, RenderWord } from "./types.js";
import type { Rect } from "../commands/types.js";
import type { Shaper } from "../fonts/shaper.js";

/** A marked keyword wins; otherwise use the longest word, with stable ties. */
export function typographyMotionWords(words: readonly RenderWord[], style: StyleDoc): RenderWord[] {
  const motion = style.animation.typographyMotion;
  if (motion === undefined || words.length === 0) return [...words];
  if (words.some((word) => word.emphasisPresetId === motion.keywordPresetId)) return [...words];
  const keyword = words.reduce((best, word) =>
    Array.from(word.t).length > Array.from(best.t).length ? word : best,
  );
  return words.map((word) =>
    word === keyword && word.emphasisPresetId === undefined
      ? { ...word, emphasisPresetId: motion.keywordPresetId }
      : word,
  );
}

export function typographyKeyword(layout: Layout, style: StyleDoc): LayoutWord | undefined {
  return (
    layout.words.find(
      (word) => word.emphasisPresetId === style.animation.typographyMotion?.keywordPresetId,
    ) ??
    layout.words.reduce<LayoutWord | undefined>(
      (best, word) =>
        best === undefined || Array.from(word.text).length > Array.from(best.text).length
          ? word
          : best,
      undefined,
    )
  );
}

interface Slot {
  readonly word: LayoutWord;
  readonly scale: number;
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
}

function union(boxes: readonly Rect[]): Rect {
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

/** The visible rectangle, including a quarter-turn sidebar word. */
export function typographyWordBounds(word: LayoutWord): Rect {
  if (word.rotationDeg !== -90) return word.box;
  const [left, top, right, bottom] = word.box;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return [
    cx - (bottom - top) / 2,
    cy - (right - left) / 2,
    cx + (bottom - top) / 2,
    cy + (right - left) / 2,
  ];
}

/** Repositions already-shaped glyphs; no browser text measurement or reshaping. */
export function composeTypographyMotion(
  layout: Layout,
  style: StyleDoc,
  shaper: Shaper,
  anchor: { readonly x: number; readonly y: number; readonly h: number; readonly v: number },
): Layout {
  const motion = style.animation.typographyMotion;
  if (motion === undefined) return layout;
  const keyword = typographyKeyword(layout, style);
  if (keyword === undefined) return layout;
  const baseSize = (style.typography.sizePct * layout.canvas.height) / 100;
  const makeSlot = (word: LayoutWord, multiple: number): Slot => {
    const scale = (baseSize * multiple) / Math.max(1, layout.fontSizePx);
    const metrics = word.runs.map((run) => {
      const face = shaper.metrics(run.fontId);
      return {
        ascent: (face.ascender / face.upem) * run.fontSizePx * scale,
        descent: (-face.descender / face.upem) * run.fontSizePx * scale,
      };
    });
    return {
      word,
      scale,
      width: (word.box[2] - word.box[0]) * scale,
      ascent: Math.max(1, ...metrics.map((item) => item.ascent)),
      descent: Math.max(0, ...metrics.map((item) => item.descent)),
    };
  };
  const keywordIndex = layout.words.indexOf(keyword);
  const before = layout.words.slice(0, keywordIndex);
  const after = layout.words.slice(keywordIndex + 1);
  const sidebar = motion.mode === "stack" && before.length > 1 ? before.shift() : undefined;
  const rows: Slot[][] = [];
  const addRows = (words: readonly LayoutWord[], count: number, multiple: number): void => {
    for (let i = 0; i < words.length; i += count) {
      rows.push(words.slice(i, i + count).map((word) => makeSlot(word, multiple)));
    }
  };
  if (motion.mode === "echo") {
    for (let i = 0; i < layout.words.length; i += 4) {
      rows.push(
        layout.words.slice(i, i + 4).map((word) => makeSlot(word, word === keyword ? 1.25 : 0.7)),
      );
    }
  } else {
    addRows(before, motion.mode === "stack" ? 2 : 4, motion.mode === "stack" ? 0.85 : 0.6);
    rows.push([makeSlot(keyword, motion.mode === "stack" ? 2.3 : 2.8)]);
    addRows(after, motion.mode === "stack" ? 2 : 4, motion.mode === "stack" ? 0.85 : 0.6);
  }
  const gap = baseSize * 0.2;
  const rowGap = baseSize * 0.05;
  const widths = rows.map(
    (row) => row.reduce((sum, slot) => sum + slot.width, 0) + gap * Math.max(0, row.length - 1),
  );
  const heights = rows.map(
    (row) =>
      Math.max(...row.map((slot) => slot.ascent)) + Math.max(...row.map((slot) => slot.descent)),
  );
  const sideSlot = sidebar === undefined ? undefined : makeSlot(sidebar, 0.68);
  const sideWidth = sideSlot === undefined ? 0 : sideSlot.ascent + sideSlot.descent + gap;
  const bodyWidth = Math.max(...widths);
  const width = bodyWidth + sideWidth;
  const rowsHeight =
    heights.reduce((sum, value) => sum + value, 0) + rowGap * Math.max(0, rows.length - 1);
  const height = Math.max(rowsHeight, sideSlot?.width ?? 0);
  const margin =
    (Math.min(layout.canvas.width, layout.canvas.height) * (style.layout.safeAreaPct ?? 0)) / 100;
  const maxWidth = Math.max(
    1,
    Math.min(
      (layout.canvas.width * style.layout.maxWidthPct) / 100,
      layout.canvas.width - 2 * margin,
    ),
  );
  const fit = Math.min(
    1,
    maxWidth / Math.max(1, width),
    (layout.canvas.height - 2 * margin) / Math.max(1, height),
  );
  const rawX = anchor.x - anchor.h * width * fit;
  const rawY = anchor.y - anchor.v * height * fit;
  const left = clamp(rawX, margin, Math.max(margin, layout.canvas.width - margin - width * fit));
  const top = clamp(rawY, margin, Math.max(margin, layout.canvas.height - margin - height * fit));
  const placed: LayoutWord[] = [];
  const place = (
    slot: Slot,
    x: number,
    baseline: number,
    lineIndex: number,
    rotationDeg?: number,
  ): void => {
    const scale = slot.scale * fit;
    const sourceBaseline = slot.word.runs[0]?.y ?? slot.word.box[3] - layout.descentPx;
    const xFor = (value: number): number => q(x + (value - slot.word.box[0]) * scale);
    const yFor = (value: number): number => q(baseline + (value - sourceBaseline) * scale);
    placed.push({
      ...slot.word,
      lineIndex,
      ...(rotationDeg === undefined ? {} : { rotationDeg }),
      box: [
        q(x),
        q(baseline - slot.ascent * fit),
        q(x + slot.width * fit),
        q(baseline + slot.descent * fit),
      ],
      runs: slot.word.runs.map((run) => ({
        ...run,
        x: xFor(run.x),
        y: yFor(run.y),
        fontSizePx: q(run.fontSizePx * scale),
        widthPx: q(run.widthPx * scale),
        glyphs: run.glyphs.map((glyph) => ({ ...glyph, x: xFor(glyph.x), y: yFor(glyph.y) })),
      })),
    });
  };
  let y = top + ((height - rowsHeight) * fit) / 2;
  for (const [index, row] of rows.entries()) {
    const rowWidth = widths.at(index) ?? 0;
    const alignment = style.layout.align === "left" ? 0 : style.layout.align === "right" ? 1 : 0.5;
    let x = left + (sideWidth + (bodyWidth - rowWidth) * alignment) * fit;
    const ascent = Math.max(...row.map((slot) => slot.ascent));
    for (const slot of row) {
      place(slot, x, y + ascent * fit, index);
      x += (slot.width + gap) * fit;
    }
    y += ((heights.at(index) ?? 0) + rowGap) * fit;
  }
  if (sideSlot !== undefined) {
    const cx = left + ((sideSlot.ascent + sideSlot.descent) * fit) / 2;
    const cy = top + (height * fit) / 2;
    place(
      sideSlot,
      cx - (sideSlot.width * fit) / 2,
      cy + ((sideSlot.ascent - sideSlot.descent) * fit) / 2,
      rows.length,
      -90,
    );
  }
  placed.sort((a, b) => a.index - b.index);
  const lines: LayoutLine[] = [...new Set(placed.map((word) => word.lineIndex))].map((index) => {
    const words = placed.filter((word) => word.lineIndex === index);
    return {
      index,
      text: words.map((word) => word.text).join(" "),
      baselineY: words[0]?.runs[0]?.y ?? 0,
      box: union(words.map(typographyWordBounds)),
      words,
      runs: words.flatMap((word) => word.runs),
    };
  });
  const box = union(placed.map(typographyWordBounds));
  const padding = style.box.enabled ? (style.box.paddingPct * baseSize * fit) / 100 : 0;
  return {
    ...layout,
    words: placed,
    lines,
    box,
    paddedBox: [box[0] - padding, box[1] - padding, box[2] + padding, box[3] + padding],
    clampedToSafeArea: left !== rawX || top !== rawY,
  };
}
