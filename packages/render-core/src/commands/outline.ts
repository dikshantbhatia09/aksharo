/**
 * Glyph runs as paths.
 *
 * CanvasKit draws glyph ids directly (`Canvas.drawGlyphs`), so the browser
 * backend never needs this. A Canvas2D surface cannot — `@napi-rs/canvas`
 * exposes `fillText`, not glyph indices — and re-running the text through a
 * second layout engine would break the parity SLO on exactly the scripts that
 * matter. `outlineGlyphRun` closes that gap: it turns a shaped run into a
 * single `path` command whose geometry is identical to what CanvasKit rasters,
 * so both backends draw the same outlines.
 *
 * HarfBuzz reports outlines in font units with y **up**; a canvas is y-down and
 * in pixels, so every coordinate is mapped through
 * `(x, y) → (originX + x·s, originY − y·s)`.
 */

import { type Shaper } from "../fonts/shaper.js";
import { q } from "../units.js";
import { type DrawCommand, type Fill, type GlyphRun, type PathCommand, type Stroke } from "./types.js";

const COMMAND_LETTERS = new Set(["M", "L", "Q", "C", "Z", "m", "l", "q", "c", "z"]);

/**
 * Rewrites one glyph's SVG path into canvas space. Only the absolute `M/L/Q/C/Z`
 * subset HarfBuzz emits is understood; anything else throws rather than being
 * silently dropped, because a silently missing curve is a parity failure nobody
 * would trace back here.
 */
export function transformGlyphPath(
  path: string,
  originX: number,
  originY: number,
  scale: number,
): string {
  const tokens = path.match(/[MLQCZmlqcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (tokens === null) return "";
  const out: string[] = [];
  let index = 0;

  const number = (): number => {
    const token = tokens[index];
    index += 1;
    return token === undefined ? 0 : Number.parseFloat(token);
  };
  const point = (): string => {
    const x = number();
    const y = number();
    return `${String(q(originX + x * scale))} ${String(q(originY - y * scale))}`;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (!COMMAND_LETTERS.has(token)) {
      throw new Error(`unsupported glyph path token "${token}" in "${path.slice(0, 40)}…"`);
    }
    index += 1;
    const letter = token.toUpperCase();
    switch (letter) {
      case "M":
      case "L":
        out.push(`${letter}${point()}`);
        break;
      case "Q":
        out.push(`Q${point()} ${point()}`);
        break;
      case "C":
        out.push(`C${point()} ${point()} ${point()}`);
        break;
      default:
        out.push("Z");
        break;
    }
  }
  return out.join("");
}

/** The SVG path of a whole shaped run, in canvas coordinates. */
export function glyphRunToPath(run: GlyphRun, shaper: Shaper): string {
  const scale = run.fontSizePx / shaper.metrics(run.fontId).upem;
  const parts: string[] = [];
  for (const [index, glyphId] of run.glyphs.entries()) {
    const x = run.positions[index * 2];
    const y = run.positions[index * 2 + 1];
    if (x === undefined || y === undefined) continue;
    const outline = shaper.glyphPath(run.fontId, glyphId);
    if (outline.length === 0) continue;
    parts.push(transformGlyphPath(outline, x, y, scale));
  }
  return parts.join("");
}

/** A `path` command equivalent to a `text` command, for glyph-less backends. */
export function outlineGlyphRun(
  run: GlyphRun,
  shaper: Shaper,
  paints: { fill?: Fill; stroke?: Stroke },
): PathCommand {
  return {
    kind: "path",
    d: glyphRunToPath(run, shaper),
    fillRule: "nonzero",
    ...(paints.fill === undefined ? {} : { fill: paints.fill }),
    ...(paints.stroke === undefined ? {} : { stroke: paints.stroke }),
  };
}

/**
 * Rewrites a whole command list, replacing every `text` command with its
 * outline. A Canvas2D backend calls this once per frame and then needs no font
 * machinery at all.
 */
export function outlineTextCommands(
  commands: readonly DrawCommand[],
  shaper: Shaper,
): DrawCommand[] {
  return commands.map((command) => {
    switch (command.kind) {
      case "text":
        return outlineGlyphRun(command.run, shaper, {
          ...(command.fill === undefined ? {} : { fill: command.fill }),
          ...(command.stroke === undefined ? {} : { stroke: command.stroke }),
        });
      case "group":
      case "transform":
      case "clip":
      case "shadow":
      case "blur":
        return { ...command, children: outlineTextCommands(command.children, shaper) };
      default:
        return command;
    }
  });
}
