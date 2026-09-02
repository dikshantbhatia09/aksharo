/**
 * The CanvasKit executor: `DrawCommand[]` → Skia calls.
 *
 * This module is the browser half of decision D33. It contains **no layout**:
 * every coordinate arrives already in canvas pixels and every glyph already has
 * an id and a position, so the only decisions left are which Skia object to
 * build and in what order to draw. That is what makes A18a's parity gate
 * possible — the cloud executor (A20) makes the same decisions from the same
 * list.
 *
 * It also imports nothing at runtime (types only), which is what lets the
 * browser test bundle it on its own and run it against a stored PNG.
 */

import type {
  ClipShape,
  DrawCommand,
  Fill,
  GlyphRun,
  Matrix,
  Paint,
  Rect,
  Stroke,
} from "@montaj/render-core";

import { type Arena } from "./arena.js";

import type { Canvas, CanvasKit, Font, Image, Paint as SkPaint, Typeface } from "canvaskit-wasm";

/** What the executor needs besides the command list. */
export interface ExecutionContext {
  readonly ck: CanvasKit;
  readonly canvas: Canvas;
  /** Typefaces by `GlyphRun.fontId`; `CanvasKitBackend` fills this in. */
  readonly typefaces: ReadonlyMap<string, Typeface>;
  /** Decoded images by `ImageCommand.assetId`. */
  readonly images?: ReadonlyMap<string, Image>;
  /** Reused `Font` objects, keyed by `${fontId}@${sizePx}`. */
  readonly fonts: Map<string, Font>;
  /** Collects every per-frame Skia object so one `release()` frees them all. */
  readonly arena: Arena;
  /** Called instead of throwing when a command references a missing resource. */
  readonly onMissing?: (kind: "font" | "image", id: string) => void;
}

function parseColour(colour: string): [number, number, number, number] {
  const r = Number.parseInt(colour.slice(1, 3), 16) / 255;
  const g = Number.parseInt(colour.slice(3, 5), 16) / 255;
  const b = Number.parseInt(colour.slice(5, 7), 16) / 255;
  const a = colour.length === 9 ? Number.parseInt(colour.slice(7, 9), 16) / 255 : 1;
  return [r, g, b, a];
}

function rect(ck: CanvasKit, box: Rect): Float32Array {
  return ck.LTRBRect(box[0], box[1], box[2], box[3]);
}

function gradientArrays(
  stops: readonly { readonly offset: number; readonly color: string }[],
  opacity: number,
): { colors: Float32Array; positions: number[] } {
  const colors = new Float32Array(stops.length * 4);
  const positions: number[] = [];
  for (const [index, stop] of stops.entries()) {
    const [r, g, b, a] = parseColour(stop.color);
    colors.set([r, g, b, a * opacity], index * 4);
    positions.push(stop.offset);
  }
  return { colors, positions };
}

/** Applies a `Paint` (solid or gradient) to a Skia paint object. */
function applyPaint(
  context: ExecutionContext,
  paint: SkPaint,
  source: Paint,
  opacity: number,
): void {
  const { ck, arena } = context;
  if (source.type === "solid") {
    const [r, g, b, a] = parseColour(source.color);
    paint.setColor(ck.Color4f(r, g, b, a * opacity));
    return;
  }
  // A shader ignores the paint colour, so alpha has to go into the stops.
  const { colors, positions } = gradientArrays(source.stops, opacity);
  const shader =
    source.type === "linear-gradient"
      ? ck.Shader.MakeLinearGradient(
          [source.from[0], source.from[1]],
          [source.to[0], source.to[1]],
          colors,
          positions,
          ck.TileMode.Clamp,
        )
      : ck.Shader.MakeRadialGradient(
          [source.centre[0], source.centre[1]],
          source.radius,
          colors,
          positions,
          ck.TileMode.Clamp,
        );
  paint.setShader(arena.keep(shader));
}

function fillPaint(context: ExecutionContext, fill: Fill): SkPaint {
  const paint = context.arena.keep(new context.ck.Paint());
  paint.setAntiAlias(true);
  paint.setStyle(context.ck.PaintStyle.Fill);
  applyPaint(context, paint, fill.paint, fill.opacity ?? 1);
  return paint;
}

function strokePaint(context: ExecutionContext, stroke: Stroke): SkPaint {
  const { ck } = context;
  const paint = context.arena.keep(new ck.Paint());
  paint.setAntiAlias(true);
  paint.setStyle(ck.PaintStyle.Stroke);
  paint.setStrokeWidth(stroke.widthPx);
  paint.setStrokeJoin(
    stroke.join === "round"
      ? ck.StrokeJoin.Round
      : stroke.join === "bevel"
        ? ck.StrokeJoin.Bevel
        : ck.StrokeJoin.Miter,
  );
  paint.setStrokeCap(
    stroke.cap === "round"
      ? ck.StrokeCap.Round
      : stroke.cap === "square"
        ? ck.StrokeCap.Square
        : ck.StrokeCap.Butt,
  );
  applyPaint(context, paint, stroke.paint, stroke.opacity ?? 1);
  return paint;
}

/** A `Font` for one run, cached across frames because building one is not free. */
function fontFor(context: ExecutionContext, run: GlyphRun): Font | undefined {
  const key = `${run.fontId}@${String(run.fontSizePx)}`;
  const cached = context.fonts.get(key);
  if (cached !== undefined) return cached;
  const typeface = context.typefaces.get(run.fontId);
  if (typeface === undefined) {
    context.onMissing?.("font", run.fontId);
    return undefined;
  }
  const font = new context.ck.Font(typeface, run.fontSizePx);
  font.setSubpixel(true);
  context.fonts.set(key, font);
  return font;
}

function drawGlyphRun(context: ExecutionContext, run: GlyphRun, paint: SkPaint): void {
  const font = fontFor(context, run);
  if (font === undefined || run.glyphs.length === 0) return;
  context.canvas.drawGlyphs(run.glyphs as number[], run.positions as number[], 0, 0, font, paint);
}

/** Our `[a, b, c, d, e, f]` in Skia's 3×3 row-major form. */
export function toMatrix3x3(matrix: Matrix): number[] {
  const [scaleX, skewY, skewX, scaleY, transX, transY] = matrix;
  return [scaleX, skewX, transX, skewY, scaleY, transY, 0, 0, 1];
}

function applyClip(context: ExecutionContext, shape: ClipShape, antiAlias: boolean): void {
  const { ck, canvas, arena } = context;
  switch (shape.type) {
    case "rect":
      canvas.clipRect(rect(ck, shape.rect), ck.ClipOp.Intersect, antiAlias);
      return;
    case "roundRect":
      canvas.clipRRect(
        ck.RRectXY(rect(ck, shape.rect), shape.radiusX, shape.radiusY),
        ck.ClipOp.Intersect,
        antiAlias,
      );
      return;
    default: {
      const path = ck.Path.MakeFromSVGString(shape.d);
      if (path === null) return;
      arena.keep(path);
      if (shape.fillRule === "evenodd") path.setFillType(ck.FillType.EvenOdd);
      canvas.clipPath(path, ck.ClipOp.Intersect, antiAlias);
    }
  }
}

function drawShape(
  context: ExecutionContext,
  draw: (paint: SkPaint) => void,
  fill: Fill | undefined,
  stroke: Stroke | undefined,
): void {
  if (fill !== undefined) draw(fillPaint(context, fill));
  if (stroke !== undefined) draw(strokePaint(context, stroke));
}

/** Executes one command list onto `context.canvas`. */
export function executeCommands(context: ExecutionContext, commands: readonly DrawCommand[]): void {
  const { ck, canvas, arena } = context;

  for (const command of commands) {
    switch (command.kind) {
      case "rect":
        drawShape(
          context,
          (paint) => {
            canvas.drawRect(rect(ck, command.rect), paint);
          },
          command.fill,
          command.stroke,
        );
        break;

      case "roundRect": {
        const rrect = ck.RRectXY(rect(ck, command.rect), command.radiusX, command.radiusY);
        drawShape(
          context,
          (paint) => {
            canvas.drawRRect(rrect, paint);
          },
          command.fill,
          command.stroke,
        );
        break;
      }

      case "path": {
        const path = ck.Path.MakeFromSVGString(command.d);
        if (path === null) break;
        arena.keep(path);
        if (command.fillRule === "evenodd") path.setFillType(ck.FillType.EvenOdd);
        drawShape(
          context,
          (paint) => {
            canvas.drawPath(path, paint);
          },
          command.fill,
          command.stroke,
        );
        break;
      }

      case "text":
        // Stroke first so the fill sits on top of it, exactly as `animate`
        // ordered the two commands.
        if (command.stroke !== undefined)
          drawGlyphRun(context, command.run, strokePaint(context, command.stroke));
        if (command.fill !== undefined)
          drawGlyphRun(context, command.run, fillPaint(context, command.fill));
        break;

      case "image": {
        const image = context.images?.get(command.assetId);
        if (image === undefined) {
          context.onMissing?.("image", command.assetId);
          break;
        }
        const paint = arena.keep(new ck.Paint());
        paint.setAntiAlias(true);
        paint.setAlphaf(command.opacity ?? 1);
        canvas.drawImageRect(
          image,
          ck.XYWHRect(0, 0, image.width(), image.height()),
          rect(ck, command.dest),
          paint,
        );
        break;
      }

      case "group": {
        if (command.opacity === undefined || command.opacity >= 1) {
          executeCommands(context, command.children);
          break;
        }
        const paint = arena.keep(new ck.Paint());
        paint.setAlphaf(command.opacity);
        canvas.saveLayer(paint);
        executeCommands(context, command.children);
        canvas.restore();
        break;
      }

      case "transform":
        canvas.save();
        canvas.concat(toMatrix3x3(command.matrix));
        executeCommands(context, command.children);
        canvas.restore();
        break;

      case "clip":
        canvas.save();
        applyClip(context, command.shape, command.antiAlias);
        executeCommands(context, command.children);
        canvas.restore();
        break;

      case "shadow": {
        const [r, g, b, a] = parseColour(command.color);
        const filter =
          command.shadowOnly === true
            ? ck.ImageFilter.MakeDropShadowOnly(
                command.dx,
                command.dy,
                command.sigma,
                command.sigma,
                ck.Color4f(r, g, b, a),
                null,
              )
            : ck.ImageFilter.MakeDropShadow(
                command.dx,
                command.dy,
                command.sigma,
                command.sigma,
                ck.Color4f(r, g, b, a),
                null,
              );
        arena.keep(filter);
        const paint = arena.keep(new ck.Paint());
        paint.setImageFilter(filter);
        canvas.saveLayer(paint);
        executeCommands(context, command.children);
        canvas.restore();
        break;
      }

      case "blur": {
        const filter = arena.keep(
          ck.ImageFilter.MakeBlur(command.sigmaX, command.sigmaY, ck.TileMode.Decal, null),
        );
        if (command.backdrop === true) {
          // A backdrop blur samples what is already on the surface, so the
          // filter goes in as the layer's backdrop, not as its paint.
          canvas.saveLayer(
            undefined,
            command.bounds === undefined ? null : rect(ck, command.bounds),
            filter,
            0,
          );
          executeCommands(context, command.children);
          canvas.restore();
          break;
        }
        const paint = arena.keep(new ck.Paint());
        paint.setImageFilter(filter);
        canvas.saveLayer(paint);
        executeCommands(context, command.children);
        canvas.restore();
        break;
      }

      default: {
        const exhaustive: never = command;
        throw new Error(`unhandled draw command: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
