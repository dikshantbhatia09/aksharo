/**
 * The cloud executor: `DrawCommand[]` → `@napi-rs/canvas` (Skia) calls.
 *
 * This is the other half of decision D33. `@montaj/render-canvaskit` runs the
 * same list against Skia's WASM build in the browser; this module runs it
 * against Skia's native build in Node, and A18a diffs the two. It contains **no
 * layout**: every coordinate arrives in absolute canvas pixels and every glyph
 * has already been turned into an outline, so the only decisions left are which
 * Skia object to build and in what order to draw.
 *
 * Where the two backends must be read side by side:
 *
 * | `DrawCommand`      | CanvasKit                            | here                                      |
 * | ------------------ | ------------------------------------ | ----------------------------------------- |
 * | `text`             | `Canvas.drawGlyphs`                  | `outlineTextCommands` first, then `path`  |
 * | `group` (opacity)  | `saveLayer(paint)`                   | offscreen canvas composited at that alpha |
 * | `shadow`           | `ImageFilter.MakeDropShadow(σ)`      | layer redrawn with `shadowBlur = 2σ`      |
 * | `blur`             | `ImageFilter.MakeBlur(σ)`            | layer redrawn with `filter: blur(σpx)`    |
 * | `blur` (backdrop)  | `saveLayer(bounds, filter)`          | read the region back, blur it, draw it in |
 *
 * Two of those need a number to be right rather than merely close:
 *
 * - **`shadowBlur` is twice the sigma.** The HTML canvas spec defines the shadow
 *   blur as a *radius* and sets σ = radius/2; Skia's drop-shadow image filter
 *   takes σ directly. Halving one and not the other is the single easiest way
 *   to fail the parity gate, so {@link SHADOW_BLUR_PER_SIGMA} names it.
 * - **`filter: blur()` is already a sigma.** CSS defines the argument of
 *   `blur()` as the standard deviation, so it passes through unscaled — the
 *   opposite convention to the line above, in the same file.
 *
 * `miterLimit` is set explicitly for the same class of reason: Skia's `SkPaint`
 * defaults to 4 and Canvas2D defaults to 10, so a mitred stroke join would draw
 * differently in the two backends purely from a default.
 */

import {
  isContainerCommand,
  type ClipShape,
  type DrawCommand,
  type Fill,
  type Matrix,
  type Paint,
  type Rect,
  type Stroke,
} from "@montaj/render-core";

import {
  BLUR_SIGMA_MARGIN,
  deviceBounds,
  inflate,
  offset,
  snapToSurface,
  union,
  type Box,
} from "./bounds.js";
import { SkiaNodeError } from "./errors.js";

import type { Canvas, Image, SKRSContext2D } from "@napi-rs/canvas";

/** Canvas2D's shadow blur is a radius; Skia's drop shadow takes a sigma. */
export const SHADOW_BLUR_PER_SIGMA = 2;

/** Skia's `SkPaint` miter limit, which Canvas2D does not default to. */
export const SKIA_MITER_LIMIT = 4;

/** A resource a command named that the backend did not have. */
export interface MissingResource {
  readonly kind: "image";
  readonly id: string;
}

/** Somewhere the executor drew something close but not identical. */
export interface Approximation {
  readonly kind: "anisotropic-blur";
  readonly detail: string;
}

/** Makes the scratch surfaces the layer commands need. */
export type CanvasFactory = (width: number, height: number) => Canvas;

export interface ExecutionContext {
  readonly ctx: SKRSContext2D;
  /** Device size of the surface; layers are allocated at this size. */
  readonly width: number;
  readonly height: number;
  readonly createCanvas: CanvasFactory;
  /** Decoded images by `ImageCommand.assetId`. */
  readonly images?: ReadonlyMap<string, Image>;
  /** Called instead of throwing when a command references a missing resource. */
  readonly onMissing?: (resource: MissingResource) => void;
  /** Called when a command was drawn with a documented approximation. */
  readonly onApproximate?: (approximation: Approximation) => void;
  /** Guards against a pathological command list nesting layers forever. */
  readonly maxLayerDepth?: number;
  /** Internal: how many layers deep we already are. */
  readonly layerDepth?: number;
}

/** `#RRGGBB` / `#RRGGBBAA` → the four channels, alpha 0–1. */
export function parseColour(colour: string): [number, number, number, number] {
  const r = Number.parseInt(colour.slice(1, 3), 16);
  const g = Number.parseInt(colour.slice(3, 5), 16);
  const b = Number.parseInt(colour.slice(5, 7), 16);
  const a = colour.length === 9 ? Number.parseInt(colour.slice(7, 9), 16) / 255 : 1;
  return [r, g, b, a];
}

/** A CSS colour string with `opacity` multiplied into the alpha channel. */
export function cssColour(colour: string, opacity = 1): string {
  const [r, g, b, a] = parseColour(colour);
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(a * opacity)})`;
}

/** A `Paint` as something assignable to `fillStyle`/`strokeStyle`. */
function paintStyle(
  ctx: SKRSContext2D,
  paint: Paint,
  opacity: number,
): string | ReturnType<SKRSContext2D["createLinearGradient"]> {
  if (paint.type === "solid") return cssColour(paint.color, opacity);
  const gradient =
    paint.type === "linear-gradient"
      ? ctx.createLinearGradient(paint.from[0], paint.from[1], paint.to[0], paint.to[1])
      : // Skia's radial gradient starts at the centre with radius 0, which is
        // what `MakeRadialGradient` does and what Canvas2D's two-circle form
        // reduces to when the inner radius is zero.
        ctx.createRadialGradient(
          paint.centre[0],
          paint.centre[1],
          0,
          paint.centre[0],
          paint.centre[1],
          paint.radius,
        );
  for (const stop of paint.stops) {
    gradient.addColorStop(stop.offset, cssColour(stop.color, opacity));
  }
  return gradient;
}

function applyFill(ctx: SKRSContext2D, fill: Fill): void {
  ctx.fillStyle = paintStyle(ctx, fill.paint, fill.opacity ?? 1);
}

function applyStroke(ctx: SKRSContext2D, stroke: Stroke): void {
  ctx.strokeStyle = paintStyle(ctx, stroke.paint, stroke.opacity ?? 1);
  ctx.lineWidth = stroke.widthPx;
  ctx.lineJoin = stroke.join;
  ctx.lineCap = stroke.cap;
  ctx.miterLimit = SKIA_MITER_LIMIT;
}

/** Our `[a, b, c, d, e, f]` is already Canvas2D's argument order. */
export function toTransformArgs(matrix: Matrix): [number, number, number, number, number, number] {
  return [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]];
}

/**
 * Traces a round rectangle with elliptical corners.
 *
 * `ctx.roundRect` only takes scalar radii in this binding, and Skia's
 * `RRectXY` corners are quarter-**ellipses** with independent x and y radii, so
 * the path is traced by hand. The radii are clamped the way `SkRRect` clamps
 * them: a corner never eats more than half the side it sits on.
 */
export function traceRoundRect(
  ctx: SKRSContext2D,
  box: Rect,
  radiusX: number,
  radiusY: number,
): void {
  const [left, top, right, bottom] = box;
  const width = right - left;
  const height = bottom - top;
  const rx = Math.max(0, Math.min(radiusX, width / 2));
  const ry = Math.max(0, Math.min(radiusY, height / 2));
  ctx.beginPath();
  if (rx === 0 || ry === 0) {
    ctx.rect(left, top, width, height);
    ctx.closePath();
    return;
  }
  ctx.moveTo(left + rx, top);
  ctx.lineTo(right - rx, top);
  ctx.ellipse(right - rx, top + ry, rx, ry, 0, -Math.PI / 2, 0);
  ctx.lineTo(right, bottom - ry);
  ctx.ellipse(right - rx, bottom - ry, rx, ry, 0, 0, Math.PI / 2);
  ctx.lineTo(left + rx, bottom);
  ctx.ellipse(left + rx, bottom - ry, rx, ry, 0, Math.PI / 2, Math.PI);
  ctx.lineTo(left, top + ry);
  ctx.ellipse(left + rx, top + ry, rx, ry, 0, Math.PI, (3 * Math.PI) / 2);
  ctx.closePath();
}

function traceShape(ctx: SKRSContext2D, shape: ClipShape): "nonzero" | "evenodd" {
  switch (shape.type) {
    case "rect":
      ctx.beginPath();
      ctx.rect(
        shape.rect[0],
        shape.rect[1],
        shape.rect[2] - shape.rect[0],
        shape.rect[3] - shape.rect[1],
      );
      return "nonzero";
    case "roundRect":
      traceRoundRect(ctx, shape.rect, shape.radiusX, shape.radiusY);
      return "nonzero";
    default:
      tracePath(ctx, shape.d);
      return shape.fillRule ?? "nonzero";
  }
}

/**
 * Replays an SVG path string onto the context.
 *
 * `Path2D` would do this too, but a `Path2D` is in user space at construction
 * time while the current transform is applied at draw time; tracing onto the
 * context keeps both backends' order of operations identical. Only the absolute
 * `M/L/Q/C/Z` subset `render-core` emits is understood — anything else throws,
 * because a silently dropped curve is a parity failure nobody would trace back
 * to here.
 */
export function tracePath(ctx: SKRSContext2D, d: string): void {
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
  const tokens = d.match(/[MLQCZmlqcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  ctx.beginPath();
  if (tokens === null) return;
  let index = 0;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;

  const number = (): number => {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const token = tokens[index];
    index += 1;
    return token === undefined ? 0 : Number.parseFloat(token);
  };

  while (index < tokens.length) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const token = tokens[index];
    // eslint-disable-next-line security/detect-possible-timing-attacks -- equality check on a null/undefined/status/hash sentinel, not a secret or MAC comparison -- reviewed for M06's eslint-plugin-security promotion
    if (token === undefined) break;
    index += 1;
    switch (token.toUpperCase()) {
      case "M": {
        currentX = number();
        currentY = number();
        startX = currentX;
        startY = currentY;
        ctx.moveTo(currentX, currentY);
        break;
      }
      case "L": {
        currentX = number();
        currentY = number();
        ctx.lineTo(currentX, currentY);
        break;
      }
      case "Q": {
        const cx = number();
        const cy = number();
        currentX = number();
        currentY = number();
        ctx.quadraticCurveTo(cx, cy, currentX, currentY);
        break;
      }
      case "C": {
        const c1x = number();
        const c1y = number();
        const c2x = number();
        const c2y = number();
        currentX = number();
        currentY = number();
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, currentX, currentY);
        break;
      }
      case "Z": {
        ctx.closePath();
        currentX = startX;
        currentY = startY;
        break;
      }
      default:
        throw new SkiaNodeError(
          "skia-node/unsupported-command",
          `unsupported path token "${token}" in "${d.slice(0, 40)}…"`,
          { token },
        );
    }
  }
}

function paintCurrentPath(
  ctx: SKRSContext2D,
  fill: Fill | undefined,
  stroke: Stroke | undefined,
  fillRule: "nonzero" | "evenodd",
): void {
  if (fill !== undefined) {
    applyFill(ctx, fill);
    ctx.fill(fillRule);
  }
  if (stroke !== undefined) {
    applyStroke(ctx, stroke);
    ctx.stroke();
  }
}

/** The scratch surface a layer command drew on, and where it sits. */
interface Layer {
  readonly canvas: Canvas;
  readonly box: Box;
}

/**
 * Runs the children on a scratch surface, then hands it back for compositing.
 * This is `SkCanvas::saveLayer` with the parts Canvas2D does not give us built
 * by hand.
 *
 * **The surface is only as big as the children.** `margin` is how far the
 * composite will spread them — three sigmas of a blur, plus a shadow's offset —
 * and the box comes from the command list, snapped outwards to whole pixels and
 * clamped to the surface. A device-sized scratch surface makes every shadow cost
 * a full-frame allocation, a full-frame composite and a full-frame Gaussian:
 * measured at 1080x1920, that was 60 ms for one shadow around a caption
 * covering a sixth of the frame, and 6 ms once the layer was bounded.
 *
 * The current matrix is copied onto the layer with the box origin subtracted, so
 * children land on exactly the pixels they would have landed on directly. The
 * clip stays on the *target*: it is in device space and survives the
 * `setTransform` the composite does, so a clipped layer composites clipped.
 */
function withLayer(
  context: ExecutionContext,
  children: readonly DrawCommand[],
  margin: Box | number,
  composite: (layer: Layer, target: SKRSContext2D) => void,
): void {
  const depth = context.layerDepth ?? 0;
  const limit = context.maxLayerDepth ?? 32;
  if (depth >= limit) {
    throw new SkiaNodeError(
      "skia-node/unsupported-command",
      `draw command list nests layers more than ${String(limit)} deep`,
      { depth },
    );
  }

  const matrix = currentMatrix(context.ctx);
  const content = deviceBounds(children, matrix);
  if (content === null) return; // the children draw nothing; the layer is a no-op
  const wanted = typeof margin === "number" ? inflate(content, margin) : union(content, margin);
  const box = snapToSurface(wanted, context.width, context.height);
  if (box === null) return; // entirely off-surface

  const layer = context.createCanvas(box.right - box.left, box.bottom - box.top);
  const layerCtx = layer.getContext("2d");
  layerCtx.setTransform(1, 0, 0, 1, -box.left, -box.top);
  layerCtx.transform(...toTransformArgs(matrix));
  executeCommands(
    { ...context, ctx: layerCtx, width: layer.width, height: layer.height, layerDepth: depth + 1 },
    children,
  );

  const target = context.ctx;
  target.save();
  // Composite in device space: the layer already carries the transform.
  target.setTransform(1, 0, 0, 1, 0, 0);
  try {
    composite({ canvas: layer, box }, target);
  } finally {
    target.restore();
  }
}

/** The device box a shadow's blurred silhouette will occupy. */
function shadowMargin(
  children: readonly DrawCommand[],
  matrix: Matrix,
  command: { dx: number; dy: number; sigma: number },
): Box | number {
  const content = deviceBounds(children, matrix);
  if (content === null) return 0;
  return inflate(offset(content, command.dx, command.dy), command.sigma * BLUR_SIGMA_MARGIN);
}

/** The current transform, as our own matrix type. */
function currentMatrix(ctx: SKRSContext2D): Matrix {
  const transform = ctx.getTransform();
  return [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f];
}

/** Executes one command list onto `context.ctx`. */
export function executeCommands(context: ExecutionContext, commands: readonly DrawCommand[]): void {
  const { ctx } = context;

  for (const command of commands) {
    switch (command.kind) {
      case "rect": {
        ctx.beginPath();
        ctx.rect(
          command.rect[0],
          command.rect[1],
          command.rect[2] - command.rect[0],
          command.rect[3] - command.rect[1],
        );
        paintCurrentPath(ctx, command.fill, command.stroke, "nonzero");
        break;
      }

      case "roundRect": {
        traceRoundRect(ctx, command.rect, command.radiusX, command.radiusY);
        paintCurrentPath(ctx, command.fill, command.stroke, "nonzero");
        break;
      }

      case "path": {
        tracePath(ctx, command.d);
        paintCurrentPath(ctx, command.fill, command.stroke, command.fillRule ?? "nonzero");
        break;
      }

      case "text":
        // `outlineTextCommands` runs before the executor, so a `text` command
        // here means the caller forgot the shaper. Failing loudly beats drawing
        // a frame with the captions silently missing.
        throw new SkiaNodeError(
          "skia-node/no-shaper",
          "a text command reached the executor; outline the list with outlineTextCommands() first",
          { fontId: command.run.fontId },
        );

      case "image": {
        const image = context.images?.get(command.assetId);
        if (image === undefined) {
          context.onMissing?.({ kind: "image", id: command.assetId });
          break;
        }
        const previousAlpha = ctx.globalAlpha;
        ctx.globalAlpha = previousAlpha * (command.opacity ?? 1);
        ctx.drawImage(
          image,
          command.dest[0],
          command.dest[1],
          command.dest[2] - command.dest[0],
          command.dest[3] - command.dest[1],
        );
        ctx.globalAlpha = previousAlpha;
        break;
      }

      case "group": {
        if (command.opacity === undefined || command.opacity >= 1) {
          executeCommands(context, command.children);
          break;
        }
        const opacity = command.opacity;
        withLayer(context, command.children, 0, (layer, target) => {
          target.globalAlpha = opacity;
          target.drawImage(layer.canvas, layer.box.left, layer.box.top);
        });
        break;
      }

      case "transform": {
        ctx.save();
        ctx.transform(...toTransformArgs(command.matrix));
        executeCommands(context, command.children);
        ctx.restore();
        break;
      }

      case "clip": {
        ctx.save();
        const rule = traceShape(ctx, command.shape);
        ctx.clip(rule);
        executeCommands(context, command.children);
        ctx.restore();
        break;
      }

      case "shadow": {
        const shadow = command;
        withLayer(
          context,
          shadow.children,
          shadowMargin(shadow.children, currentMatrix(ctx), shadow),
          (layer, target) => {
            drawWithShadow(context, target, layer, shadow);
          },
        );
        break;
      }

      case "blur": {
        const blur = command;
        if (blur.sigmaX !== blur.sigmaY) {
          context.onApproximate?.({
            kind: "anisotropic-blur",
            detail:
              `blur ${String(blur.sigmaX)}×${String(blur.sigmaY)} drawn isotropically at ` +
              `${String(blur.sigmaX)}: CSS blur() takes one standard deviation`,
          });
        }
        if (blur.backdrop === true) {
          drawBackdropBlur(context, blur);
          break;
        }
        withLayer(
          context,
          blur.children,
          Math.max(blur.sigmaX, blur.sigmaY) * BLUR_SIGMA_MARGIN,
          (layer, target) => {
            target.filter = `blur(${String(blur.sigmaX)}px)`;
            target.drawImage(layer.canvas, layer.box.left, layer.box.top);
            target.filter = "none";
          },
        );
        break;
      }

      default: {
        const exhaustive: never = command;
        throw new SkiaNodeError(
          "skia-node/unsupported-command",
          `unhandled draw command: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
}

/**
 * Draws a finished layer with a Gaussian drop shadow, built the way Skia builds
 * one: colour the layer's **alpha** with the shadow colour, offset it, blur it,
 * draw it, then draw the layer itself once on top.
 *
 * `ctx.shadowColor`/`shadowBlur` would do this in one call and matches CanvasKit
 * exactly for opaque children — but it draws the source *and* its shadow, so the
 * source has to be drawn a second time to land on top of a sibling's shadow, and
 * a translucent layer then composites with itself. That is not a rounding
 * difference: the liquid-glass panel came out half again as opaque as the
 * browser drew it. Building the silhouette by hand draws the source exactly
 * once, which is what `SkImageFilters::DropShadow` does.
 *
 * `shadowOnly` is then free — it is this without the last step — and is the
 * whole appearance of the neon-glow style.
 */
function drawWithShadow(
  context: ExecutionContext,
  target: SKRSContext2D,
  layer: Layer,
  command: { dx: number; dy: number; sigma: number; color: string; shadowOnly?: boolean },
): void {
  const width = layer.canvas.width;
  const height = layer.canvas.height;
  const silhouette = context.createCanvas(width, height);
  const silhouetteCtx = silhouette.getContext("2d");
  silhouetteCtx.drawImage(layer.canvas, command.dx, command.dy);
  // `source-in` keeps the alpha and replaces the colour: Skia's
  // `SkColorFilters::Blend(color, kSrcIn)`, which is the first stage of its own
  // drop-shadow filter.
  silhouetteCtx.globalCompositeOperation = "source-in";
  silhouetteCtx.fillStyle = cssColour(command.color);
  silhouetteCtx.fillRect(0, 0, width, height);
  silhouetteCtx.globalCompositeOperation = "source-over";

  if (command.sigma > 0) target.filter = `blur(${String(command.sigma)}px)`;
  target.drawImage(silhouette, layer.box.left, layer.box.top);
  target.filter = "none";

  if (command.shadowOnly !== true) {
    target.drawImage(layer.canvas, layer.box.left, layer.box.top);
  }
}

/**
 * The liquid-glass look: blur what is already on the surface inside `bounds`,
 * put it back, then draw the panel on top.
 *
 * CanvasKit expresses this as `saveLayer(bounds, backdropFilter)`. Canvas2D has
 * no backdrop, so the region is copied to a scratch surface, drawn back through
 * the blur filter under a clip, and the children go on top. The clip is what
 * keeps the blur inside the panel instead of fogging the whole frame.
 */
function drawBackdropBlur(
  context: ExecutionContext,
  command: { sigmaX: number; sigmaY: number; bounds?: Rect; children: readonly DrawCommand[] },
): void {
  const { ctx } = context;
  const bounds = command.bounds ?? [0, 0, context.width, context.height];
  const snapshot = context.createCanvas(context.width, context.height);
  snapshot.getContext("2d").drawImage(ctx.canvas as unknown as Canvas, 0, 0);

  ctx.save();
  const rule = traceShape(ctx, { type: "rect", rect: bounds });
  ctx.clip(rule);
  const transform = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = `blur(${String(command.sigmaX)}px)`;
  ctx.drawImage(snapshot, 0, 0);
  ctx.filter = "none";
  ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  ctx.restore();

  executeCommands(context, command.children);
}

/** Total number of commands in a list, including nested children. */
export function commandCount(commands: readonly DrawCommand[]): number {
  let total = 0;
  for (const command of commands) {
    total += 1;
    if (isContainerCommand(command)) total += commandCount(command.children);
  }
  return total;
}
