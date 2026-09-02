/**
 * Small constructors for `DrawCommand`s. They exist so every command in the
 * codebase is built one way — quantised coordinates, canonical colours, no
 * `undefined` keys — which is what keeps the golden hashes stable across
 * refactors.
 */

import { normaliseColour } from "../colour.js";
import { q, qRect } from "../units.js";
import {
  type ClipShape,
  type DrawCommand,
  type Fill,
  type GlyphRun,
  type GroupCommand,
  type Matrix,
  type Paint,
  type Rect,
  type Stroke,
} from "./types.js";

/** A flat colour paint. */
export function solid(colour: string): Paint {
  return { type: "solid", color: normaliseColour(colour) };
}

export function fill(paint: Paint | string, opacity?: number): Fill {
  const resolved = typeof paint === "string" ? solid(paint) : paint;
  return opacity === undefined || opacity >= 1
    ? { paint: resolved }
    : { paint: resolved, opacity: q(opacity) };
}

export function stroke(
  paint: Paint | string,
  widthPx: number,
  join: Stroke["join"] = "round",
  cap: Stroke["cap"] = "round",
): Stroke {
  return { paint: typeof paint === "string" ? solid(paint) : paint, widthPx: q(widthPx), join, cap };
}

export function linearGradient(
  from: readonly [number, number],
  to: readonly [number, number],
  stops: readonly { offset: number; color: string }[],
): Paint {
  return {
    type: "linear-gradient",
    from: [q(from[0]), q(from[1])],
    to: [q(to[0]), q(to[1])],
    stops: stops.map((stop) => ({ offset: q(stop.offset), color: normaliseColour(stop.color) })),
  };
}

export function radialGradient(
  centre: readonly [number, number],
  radius: number,
  stops: readonly { offset: number; color: string }[],
): Paint {
  return {
    type: "radial-gradient",
    centre: [q(centre[0]), q(centre[1])],
    radius: q(radius),
    stops: stops.map((stop) => ({ offset: q(stop.offset), color: normaliseColour(stop.color) })),
  };
}

export function rect(box: Rect, paints: { fill?: Fill; stroke?: Stroke }): DrawCommand {
  return {
    kind: "rect",
    rect: qRect(box[0], box[1], box[2], box[3]) as Rect,
    ...(paints.fill === undefined ? {} : { fill: paints.fill }),
    ...(paints.stroke === undefined ? {} : { stroke: paints.stroke }),
  };
}

export function roundRect(
  box: Rect,
  radiusX: number,
  radiusY: number,
  paints: { fill?: Fill; stroke?: Stroke },
): DrawCommand {
  return {
    kind: "roundRect",
    rect: qRect(box[0], box[1], box[2], box[3]) as Rect,
    radiusX: q(radiusX),
    radiusY: q(radiusY),
    ...(paints.fill === undefined ? {} : { fill: paints.fill }),
    ...(paints.stroke === undefined ? {} : { stroke: paints.stroke }),
  };
}

export function text(run: GlyphRun, paints: { fill?: Fill; stroke?: Stroke }): DrawCommand {
  return {
    kind: "text",
    run,
    ...(paints.fill === undefined ? {} : { fill: paints.fill }),
    ...(paints.stroke === undefined ? {} : { stroke: paints.stroke }),
  };
}

export function group(children: readonly DrawCommand[], id?: string, opacity?: number): GroupCommand {
  return {
    kind: "group",
    ...(id === undefined ? {} : { id }),
    ...(opacity === undefined || opacity >= 1 ? {} : { opacity: q(opacity) }),
    children,
  };
}

/** `scale` about `(cx, cy)` combined with a translation, in Skia's column order. */
export function scaleTranslateMatrix(
  scale: number,
  cx: number,
  cy: number,
  dx = 0,
  dy = 0,
): Matrix {
  return [q(scale), 0, 0, q(scale), q(cx - scale * cx + dx), q(cy - scale * cy + dy)];
}

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

export function transform(matrix: Matrix, children: readonly DrawCommand[]): DrawCommand {
  return { kind: "transform", matrix, children };
}

export function clip(shape: ClipShape, children: readonly DrawCommand[], antiAlias = true): DrawCommand {
  return { kind: "clip", shape, antiAlias, children };
}

export function clipRect(box: Rect, children: readonly DrawCommand[]): DrawCommand {
  return clip({ type: "rect", rect: qRect(box[0], box[1], box[2], box[3]) as Rect }, children);
}

export function shadow(
  options: { dx: number; dy: number; sigma: number; color: string; shadowOnly?: boolean },
  children: readonly DrawCommand[],
): DrawCommand {
  return {
    kind: "shadow",
    dx: q(options.dx),
    dy: q(options.dy),
    sigma: q(options.sigma),
    color: normaliseColour(options.color),
    ...(options.shadowOnly === true ? { shadowOnly: true } : {}),
    children,
  };
}

export function blur(
  options: { sigmaX: number; sigmaY: number; backdrop?: boolean; bounds?: Rect },
  children: readonly DrawCommand[],
): DrawCommand {
  return {
    kind: "blur",
    sigmaX: q(options.sigmaX),
    sigmaY: q(options.sigmaY),
    ...(options.backdrop === true ? { backdrop: true } : {}),
    ...(options.bounds === undefined
      ? {}
      : { bounds: qRect(options.bounds[0], options.bounds[1], options.bounds[2], options.bounds[3]) as Rect }),
    children,
  };
}

export function image(assetId: string, dest: Rect, opacity?: number): DrawCommand {
  return {
    kind: "image",
    assetId,
    dest: qRect(dest[0], dest[1], dest[2], dest[3]) as Rect,
    ...(opacity === undefined || opacity >= 1 ? {} : { opacity: q(opacity) }),
  };
}

/** Grows a rectangle by `amount` on every side. */
export function inflate(box: Rect, amount: number): Rect {
  return [box[0] - amount, box[1] - amount, box[2] + amount, box[3] + amount];
}

export function rectWidth(box: Rect): number {
  return box[2] - box[0];
}

export function rectHeight(box: Rect): number {
  return box[3] - box[1];
}
