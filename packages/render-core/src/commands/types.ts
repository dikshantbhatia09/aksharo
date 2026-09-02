/**
 * The `DrawCommand` union — the portable artefact of the whole render stack
 * (decision D33).
 *
 * `render-core` computes layout once and emits this list; CanvasKit executes it
 * in the browser (`@montaj/render-canvaskit`), `@napi-rs/canvas` executes it in
 * the cloud (`@montaj/render-skia-node`, A20) and A18a diffs the two. Every
 * command therefore has to be expressible in **both** Skia surfaces, which is
 * why the union stops at paths, glyph runs, fills, strokes, shadows, blurs,
 * clips, transforms and images: no CSS, no DOM, no shader source.
 *
 * Three invariants make the parity gate meaningful:
 *
 * 1. **Absolute pixels.** Every coordinate is already in canvas pixels; a
 *    backend never re-derives a position from a percentage, a font size or a
 *    text measurement of its own.
 * 2. **No text layout.** Text arrives as shaped glyph ids with per-glyph
 *    positions. A backend that cannot draw glyph ids (a Canvas2D surface, say)
 *    converts the run to a path with `outlineGlyphRun()` rather than measuring
 *    text itself.
 * 3. **JSON-serialisable.** The list survives `JSON.stringify` unchanged, so it
 *    can be hashed (`hashCommands`), stored as a golden fixture and shipped to
 *    a browser worker.
 */

/** `[x, y]` in canvas pixels. */
export type Point = readonly [x: number, y: number];

/** `[left, top, right, bottom]` in canvas pixels. */
export type Rect = readonly [left: number, top: number, right: number, bottom: number];

/**
 * A 3×2 affine matrix in column-major Skia order:
 * `[scaleX, skewY, skewX, scaleY, translateX, translateY]`.
 */
export type Matrix = readonly [number, number, number, number, number, number];

/** `#RRGGBB` or `#RRGGBBAA`; the only colour form a command may carry. */
export type Color = string;

export interface GradientStop {
  /** 0 at the gradient's start, 1 at its end. */
  readonly offset: number;
  readonly color: Color;
}

/** How a shape or a glyph run is coloured. */
export type Paint =
  | { readonly type: "solid"; readonly color: Color }
  | {
      readonly type: "linear-gradient";
      readonly from: Point;
      readonly to: Point;
      readonly stops: readonly GradientStop[];
    }
  | {
      readonly type: "radial-gradient";
      readonly centre: Point;
      readonly radius: number;
      readonly stops: readonly GradientStop[];
    };

export interface Fill {
  readonly paint: Paint;
  /** Multiplied into the paint's own alpha; 1 when omitted. */
  readonly opacity?: number;
}

export type StrokeJoin = "miter" | "round" | "bevel";
export type StrokeCap = "butt" | "round" | "square";

export interface Stroke {
  readonly paint: Paint;
  readonly widthPx: number;
  readonly join: StrokeJoin;
  readonly cap: StrokeCap;
  readonly opacity?: number;
}

/**
 * One shaped run of text: glyph ids resolved against `fontId`, positioned
 * absolutely. `positions` is a flat `[x0, y0, x1, y1, …]` array of baseline
 * origins, two entries per glyph, so the array is exactly `2 × glyphs.length`.
 */
export interface GlyphRun {
  /** `FontResource.id` in the registry the backend was built with. */
  readonly fontId: string;
  /** Em size in canvas pixels. */
  readonly fontSizePx: number;
  readonly glyphs: readonly number[];
  readonly positions: readonly number[];
  /**
   * Index into `text` of the code point each glyph came from, as HarfBuzz
   * reports it. Karaoke fills and per-word highlights slice a run by cluster,
   * and `@montaj/ass-exporter` uses it to place per-word `\pos` events.
   */
  readonly clusters: readonly number[];
  /** The source text of the run; kept for diagnostics and ASS export. */
  readonly text: string;
}

export interface TextCommand {
  readonly kind: "text";
  readonly run: GlyphRun;
  readonly fill?: Fill;
  readonly stroke?: Stroke;
}

export interface RectCommand {
  readonly kind: "rect";
  readonly rect: Rect;
  readonly fill?: Fill;
  readonly stroke?: Stroke;
}

export interface RoundRectCommand {
  readonly kind: "roundRect";
  readonly rect: Rect;
  /** Corner radii in pixels. */
  readonly radiusX: number;
  readonly radiusY: number;
  readonly fill?: Fill;
  readonly stroke?: Stroke;
}

/**
 * A path in the SVG subset both Skia surfaces parse: `M`, `L`, `Q`, `C` and
 * `Z`, absolute, space-separated. Glyph outlines produced by
 * `outlineGlyphRun()` use exactly this subset.
 */
export interface PathCommand {
  readonly kind: "path";
  readonly d: string;
  readonly fillRule?: "nonzero" | "evenodd";
  readonly fill?: Fill;
  readonly stroke?: Stroke;
}

export interface ImageCommand {
  readonly kind: "image";
  /**
   * How the backend finds the pixels. `assetId` is a key the host resolves
   * (a brand-kit logo, the watermark); the command never inlines bytes, so the
   * list stays small and hashable.
   */
  readonly assetId: string;
  readonly dest: Rect;
  readonly opacity?: number;
}

/** Children are drawn into a layer and then composited at `opacity`. */
export interface GroupCommand {
  readonly kind: "group";
  /** Diagnostic label: `"segment:<id>"`, `"line:2"`, `"word:0:17"`. */
  readonly id?: string;
  readonly opacity?: number;
  readonly children: readonly DrawCommand[];
}

export interface TransformCommand {
  readonly kind: "transform";
  readonly matrix: Matrix;
  readonly children: readonly DrawCommand[];
}

export type ClipShape =
  | { readonly type: "rect"; readonly rect: Rect }
  | {
      readonly type: "roundRect";
      readonly rect: Rect;
      readonly radiusX: number;
      readonly radiusY: number;
    }
  | { readonly type: "path"; readonly d: string; readonly fillRule?: "nonzero" | "evenodd" };

export interface ClipCommand {
  readonly kind: "clip";
  readonly shape: ClipShape;
  readonly antiAlias: boolean;
  readonly children: readonly DrawCommand[];
}

/** Children are drawn into a layer that gets a Gaussian drop shadow. */
export interface ShadowCommand {
  readonly kind: "shadow";
  readonly dx: number;
  readonly dy: number;
  /** Gaussian sigma in pixels, not a CSS blur radius. */
  readonly sigma: number;
  readonly color: Color;
  /** Draw the shadow only, dropping the children themselves. */
  readonly shadowOnly?: boolean;
  readonly children: readonly DrawCommand[];
}

/**
 * A Gaussian blur. With `backdrop: true` it blurs what is already on the
 * surface inside `bounds` — the liquid-glass look — which means the backend
 * must be compositing over the video frame; `render-core` marks such styles
 * with `requiresBackdrop` so a caller can refuse them on a transparent overlay.
 */
export interface BlurCommand {
  readonly kind: "blur";
  readonly sigmaX: number;
  readonly sigmaY: number;
  readonly backdrop?: boolean;
  /** Required when `backdrop` is set: the region to sample and blur. */
  readonly bounds?: Rect;
  readonly children: readonly DrawCommand[];
}

export type DrawCommand =
  | TextCommand
  | RectCommand
  | RoundRectCommand
  | PathCommand
  | ImageCommand
  | GroupCommand
  | TransformCommand
  | ClipCommand
  | ShadowCommand
  | BlurCommand;

/** The `kind` discriminants, for exhaustiveness tests and backend dispatch tables. */
export const DRAW_COMMAND_KINDS = [
  "text",
  "rect",
  "roundRect",
  "path",
  "image",
  "group",
  "transform",
  "clip",
  "shadow",
  "blur",
] as const;

export type DrawCommandKind = (typeof DRAW_COMMAND_KINDS)[number];

/** Commands that nest, i.e. the ones a backend walks recursively. */
export type ContainerCommand =
  GroupCommand | TransformCommand | ClipCommand | ShadowCommand | BlurCommand;

/** Narrows to the nesting commands without a `kind` switch at every call site. */
export function isContainerCommand(command: DrawCommand): command is ContainerCommand {
  switch (command.kind) {
    case "group":
    case "transform":
    case "clip":
    case "shadow":
    case "blur":
      return true;
    default:
      return false;
  }
}

/** Depth-first walk over a command list, containers before their children. */
export function* walkCommands(commands: readonly DrawCommand[]): Generator<DrawCommand> {
  for (const command of commands) {
    yield command;
    if (isContainerCommand(command)) yield* walkCommands(command.children);
  }
}

/** Total number of commands including nested children. */
export function countCommands(commands: readonly DrawCommand[]): number {
  let total = 0;
  for (const _command of walkCommands(commands)) total += 1;
  return total;
}
