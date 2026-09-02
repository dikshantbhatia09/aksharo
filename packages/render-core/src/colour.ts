/**
 * Colours travel through the command list as `#RRGGBBAA` strings, because that
 * is what a StyleDoc carries and what survives `JSON.stringify` into a golden
 * fixture. Only the backends turn them into floats.
 */

import { RenderError } from "./errors.js";
import { clamp01 } from "./units.js";

export interface Rgba {
  /** 0–255. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1. */
  readonly a: number;
}

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Parses `#RRGGBB` / `#RRGGBBAA`. Throws on anything else. */
export function parseColour(colour: string): Rgba {
  if (!HEX.test(colour)) {
    throw new RenderError("render/invalid-input", `expected #RRGGBB or #RRGGBBAA, got "${colour}"`);
  }
  const r = Number.parseInt(colour.slice(1, 3), 16);
  const g = Number.parseInt(colour.slice(3, 5), 16);
  const b = Number.parseInt(colour.slice(5, 7), 16);
  const a = colour.length === 9 ? Number.parseInt(colour.slice(7, 9), 16) / 255 : 1;
  return { r, g, b, a };
}

function byte(value: number): string {
  const clamped = Math.round(Math.min(255, Math.max(0, value)));
  return clamped.toString(16).padStart(2, "0");
}

/** Formats back to `#RRGGBBAA`, always eight digits so hashes are stable. */
export function formatColour({ r, g, b, a }: Rgba): string {
  return `#${byte(r)}${byte(g)}${byte(b)}${byte(clamp01(a) * 255)}`;
}

/** Normalises any accepted form to the canonical eight-digit one. */
export function normaliseColour(colour: string): string {
  return formatColour(parseColour(colour));
}

/** Multiplies a colour's alpha, e.g. to fade a whole caption in. */
export function withAlpha(colour: string, multiplier: number): string {
  const rgba = parseColour(colour);
  return formatColour({ ...rgba, a: rgba.a * clamp01(multiplier) });
}

/** Replaces a colour's alpha outright. */
export function setAlpha(colour: string, alpha: number): string {
  return formatColour({ ...parseColour(colour), a: clamp01(alpha) });
}

/** Linear interpolation in straight (non-premultiplied) sRGB, as Skia lerps. */
export function mixColours(from: string, to: string, t: number): string {
  const a = parseColour(from);
  const b = parseColour(to);
  const k = clamp01(t);
  return formatColour({
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  });
}

/**
 * Perceived luminance (Rec. 601), used to decide whether a highlight box needs
 * dark or light text on it.
 */
export function luminance(colour: string): number {
  const { r, g, b } = parseColour(colour);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Black or white, whichever reads on `background`. */
export function contrastingInk(background: string): string {
  return luminance(background) > 0.55 ? "#000000ff" : "#ffffffff";
}
