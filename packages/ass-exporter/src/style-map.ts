/**
 * `StyleDoc` → one ASS `[V4+ Styles]` line.
 *
 * Percentages convert against the canvas exactly the way `render-core`'s
 * `units.ts` does — `sizePct`/`x`/`y` off canvas height/width, stroke width and
 * shadow off the resolved font size — so the sidecar's numbers agree with the
 * burned-in render's numbers even though this package never calls `render-core`
 * itself.
 */

import type { StyleDoc } from "@montaj/caption-styles";

import { toAssColour, toAssColourNoAlpha } from "./colour.js";

import type { AssCanvas } from "./types.js";

/** libass numpad alignment, from a StyleDoc anchor. */
export function alignmentOf(anchor: StyleDoc["layout"]["anchor"]): number {
  switch (anchor) {
    case "top-left":
      return 7;
    case "top-center":
      return 8;
    case "top-right":
      return 9;
    case "middle-left":
      return 4;
    case "center":
      return 5;
    case "middle-right":
      return 6;
    case "bottom-left":
      return 1;
    case "bottom-center":
      return 2;
    case "bottom-right":
      return 3;
    default:
      return 2;
  }
}

/** Font size in canvas pixels, StyleDoc's `sizePct` being a percentage of canvas height. */
export function fontSizePx(style: StyleDoc, canvas: AssCanvas): number {
  return Math.max(1, Math.round((style.typography.sizePct / 100) * canvas.height));
}

function ofFontSize(percent: number, sizePx: number): number {
  return (percent / 100) * sizePx;
}

export interface AssStyleLine {
  readonly name: string;
  readonly line: string;
}

const STYLE_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, " +
  "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, " +
  "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";

export { STYLE_FORMAT };

/** Builds the `Style:` line for one `StyleDoc`, keyed by its own `id`. */
export function buildStyleLine(style: StyleDoc, canvas: AssCanvas): AssStyleLine {
  const sizePx = fontSizePx(style, canvas);
  const primary = toAssColour(style.colors.text);
  const secondary = toAssColour(style.colors.accent ?? style.colors.activeText ?? style.colors.text);
  const outlineColour = style.stroke.enabled
    ? toAssColour(style.stroke.color ?? "#000000ff")
    : toAssColour("#00000000");
  const backColour = style.shadow.enabled
    ? toAssColour(style.shadow.color ?? "#000000ff")
    : style.box.enabled && style.box.mode === "block"
      ? toAssColour(style.box.fill ?? "#000000ff")
      : toAssColour("#00000000");

  const bold = style.typography.weight >= 600 ? -1 : 0;
  const italic = style.typography.italic ? -1 : 0;
  const borderStyle = style.box.enabled && style.box.mode === "block" ? 3 : 1;
  const outlineWidth = style.stroke.enabled
    ? Math.max(0, Math.round(ofFontSize(style.stroke.widthPct, sizePx) * 10) / 10)
    : borderStyle === 3
      ? Math.max(0, Math.round(ofFontSize(style.box.paddingPct, sizePx) * 10) / 10)
      : 0;
  const shadowDistance = style.shadow.enabled
    ? Math.max(
        0,
        Math.round(
          ((Math.abs(style.shadow.offsetXPct) + Math.abs(style.shadow.offsetYPct)) / 2 / 100) *
            sizePx *
            10,
        ) / 10,
      )
    : 0;
  const alignment = alignmentOf(style.layout.anchor);
  const marginH = Math.max(0, Math.round((1 - style.layout.maxWidthPct / 100) * canvas.width * 0.5));
  const marginV = Math.max(
    0,
    Math.round(((style.layout.safeAreaPct ?? 4) / 100) * canvas.height),
  );

  const fields = [
    style.id,
    style.typography.fontFamily,
    String(sizePx),
    primary,
    secondary,
    outlineColour,
    backColour,
    String(bold),
    String(italic),
    "0",
    "0",
    "100",
    "100",
    String(Math.round(style.typography.letterSpacingEm * sizePx * 10) / 10),
    "0",
    String(borderStyle),
    String(outlineWidth),
    String(shadowDistance),
    String(alignment),
    String(marginH),
    String(marginH),
    String(marginV),
    "1",
  ];

  return { name: style.id, line: `Style: ${fields.join(",")}` };
}

/** `\1c`/`\3c` override forms used inline in an event's text, no alpha. */
export { toAssColourNoAlpha };
