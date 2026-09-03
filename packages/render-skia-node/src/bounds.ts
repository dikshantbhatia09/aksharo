/**
 * Device-space bounding boxes for a command list.
 *
 * This exists for one reason: **a layer costs what it covers**. `group`
 * opacity, `shadow` and `blur` all need an offscreen surface, and allocating
 * that surface at the size of the frame makes every one of them cost a
 * full-frame allocation, a full-frame composite and — for a shadow — a
 * full-frame Gaussian blur. Measured on a 1080×1920 caption frame, one shadow
 * command drawn that way cost **60 ms**; the caption it shadows covers about a
 * sixth of the frame.
 *
 * Skia solves this with `SaveLayerRec`'s bounds. Canvas2D has no equivalent, so
 * the bound is computed here and the scratch surface is allocated to it.
 *
 * Every box is **conservative**: a Bézier is bounded by its control points, a
 * stroke by its full width rather than half, and a Gaussian by three sigmas —
 * past which the tail is under 0.3% and quantises to zero in eight bits. A box
 * that is too big only costs time; a box that is too small would clip the
 * picture, so nothing here is allowed to be clever.
 */

import { isContainerCommand, type DrawCommand, type Matrix, type Rect } from "@montaj/render-core";

/** Device-space box, right and bottom exclusive. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** How many standard deviations of a Gaussian a bound has to contain. */
export const BLUR_SIGMA_MARGIN = 3;

/** The identity, in the same `[a, b, c, d, e, f]` order Canvas2D uses. */
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `first` then `second`, i.e. the matrix a nested `transform` produces. */
export function multiply(first: Matrix, second: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

class Accumulator {
  left = Number.POSITIVE_INFINITY;
  top = Number.POSITIVE_INFINITY;
  right = Number.NEGATIVE_INFINITY;
  bottom = Number.NEGATIVE_INFINITY;

  point(x: number, y: number): void {
    if (x < this.left) this.left = x;
    if (y < this.top) this.top = y;
    if (x > this.right) this.right = x;
    if (y > this.bottom) this.bottom = y;
  }

  box(other: Box | null): void {
    if (other === null) return;
    this.point(other.left, other.top);
    this.point(other.right, other.bottom);
  }

  get empty(): boolean {
    return this.right < this.left || this.bottom < this.top;
  }

  finish(): Box | null {
    if (this.empty) return null;
    return { left: this.left, top: this.top, right: this.right, bottom: this.bottom };
  }
}

function mapPoint(matrix: Matrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/** All four corners, because a rotation makes the axis-aligned box larger. */
function addRect(accumulator: Accumulator, matrix: Matrix, rect: Rect, pad: number): void {
  const [left, top, right, bottom] = rect;
  for (const [x, y] of [
    [left - pad, top - pad],
    [right + pad, top - pad],
    [right + pad, bottom + pad],
    [left - pad, bottom + pad],
  ] as const) {
    accumulator.point(...mapPoint(matrix, x, y));
  }
}

/**
 * Every coordinate pair in an SVG path, transformed.
 *
 * Control points bound their curve, so taking them all is a correct (if loose)
 * bound without evaluating a single Bézier.
 */
function addPathPoints(accumulator: Accumulator, matrix: Matrix, d: string, pad: number): void {
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
  const numbers = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (numbers === null) return;
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const x = Number.parseFloat(numbers[index] ?? "0");
    const y = Number.parseFloat(numbers[index + 1] ?? "0");
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const [dx, dy] = mapPoint(matrix, x, y);
    accumulator.point(dx - pad, dy - pad);
    accumulator.point(dx + pad, dy + pad);
  }
}

/** Stroke padding: the full width, not half, so a mitre cannot poke out. */
function strokePad(command: { stroke?: { widthPx: number } }): number {
  return command.stroke === undefined ? 0 : Math.abs(command.stroke.widthPx);
}

function shapeRect(shape: { type: string; rect?: Rect; d?: string }): Rect | null {
  return shape.rect ?? null;
}

function collect(accumulator: Accumulator, commands: readonly DrawCommand[], matrix: Matrix): void {
  for (const command of commands) {
    switch (command.kind) {
      case "rect":
      case "roundRect":
        addRect(accumulator, matrix, command.rect, strokePad(command));
        break;
      case "path":
        addPathPoints(accumulator, matrix, command.d, strokePad(command));
        break;
      case "image":
        addRect(accumulator, matrix, command.dest, 0);
        break;
      case "text": {
        // A glyph run is bounded by its positions plus one em in every
        // direction: an ascender, a descender and a stroke all fit inside that.
        const pad = command.run.fontSizePx + strokePad(command);
        for (let index = 0; index + 1 < command.run.positions.length; index += 2) {
          const [x, y] = mapPoint(
            matrix,
            // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
            command.run.positions[index] ?? 0,
            command.run.positions[index + 1] ?? 0,
          );
          accumulator.point(x - pad, y - pad);
          accumulator.point(x + pad, y + pad);
        }
        break;
      }
      case "group":
        collect(accumulator, command.children, matrix);
        break;
      case "transform":
        collect(accumulator, command.children, multiply(matrix, command.matrix));
        break;
      case "clip": {
        const inner = new Accumulator();
        collect(inner, command.children, matrix);
        const clipRect = shapeRect(command.shape);
        if (clipRect === null) {
          // A path clip only ever shrinks what the children cover, so their own
          // bound is still a correct outer bound.
          accumulator.box(inner.finish());
          break;
        }
        const clip = new Accumulator();
        addRect(clip, matrix, clipRect, 0);
        accumulator.box(intersect(inner.finish(), clip.finish()));
        break;
      }
      case "shadow": {
        const inner = new Accumulator();
        collect(inner, command.children, matrix);
        const box = inner.finish();
        if (box === null) break;
        accumulator.box(box);
        accumulator.box(
          inflate(offset(box, command.dx, command.dy), command.sigma * BLUR_SIGMA_MARGIN),
        );
        break;
      }
      case "blur": {
        const inner = new Accumulator();
        collect(inner, command.children, matrix);
        const box = inner.finish();
        const margin = Math.max(command.sigmaX, command.sigmaY) * BLUR_SIGMA_MARGIN;
        if (command.backdrop === true) {
          // A backdrop blur paints its own `bounds`, whatever the children cover.
          const region = new Accumulator();
          if (command.bounds !== undefined) addRect(region, matrix, command.bounds, 0);
          region.box(box);
          accumulator.box(region.finish());
          break;
        }
        if (box !== null) accumulator.box(inflate(box, margin));
        break;
      }
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }
}

export function offset(box: Box, dx: number, dy: number): Box {
  return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

export function inflate(box: Box, margin: number): Box {
  return {
    left: box.left - margin,
    top: box.top - margin,
    right: box.right + margin,
    bottom: box.bottom + margin,
  };
}

export function intersect(a: Box | null, b: Box | null): Box | null {
  if (a === null || b === null) return null;
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return box.right <= box.left || box.bottom <= box.top ? null : box;
}

export function union(a: Box | null, b: Box | null): Box | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * Rounds outwards to whole pixels and clamps to the surface.
 *
 * Outwards, always: a box rounded inwards would clip the very edge pixel the
 * anti-aliasing lives in, which is exactly the pixel the parity gate measures.
 */
export function snapToSurface(box: Box | null, width: number, height: number): Box | null {
  if (box === null) return null;
  const left = Math.max(0, Math.floor(box.left));
  const top = Math.max(0, Math.floor(box.top));
  const right = Math.min(width, Math.ceil(box.right));
  const bottom = Math.min(height, Math.ceil(box.bottom));
  return right <= left || bottom <= top ? null : { left, top, right, bottom };
}

/**
 * The device-space box a command list can possibly touch, or `null` when it
 * draws nothing at all.
 */
export function deviceBounds(
  commands: readonly DrawCommand[],
  matrix: Matrix = IDENTITY,
): Box | null {
  const accumulator = new Accumulator();
  collect(accumulator, commands, matrix);
  return accumulator.finish();
}

/** Whether any command in the list nests — i.e. whether a bound is worth taking. */
export function hasContainers(commands: readonly DrawCommand[]): boolean {
  return commands.some((command) => isContainerCommand(command));
}
