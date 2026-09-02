/**
 * `SkiaNodeBackend` — the object a render worker holds: it owns the shaper that
 * turns glyph runs into outlines, the decoded images an `image` command names,
 * and the reusable surfaces a long render draws thousands of frames on.
 *
 * The contrast with `@montaj/render-canvaskit` is deliberate and small. That
 * backend owns typefaces because CanvasKit draws glyph ids; this one owns a
 * `Shaper` because Canvas2D cannot, and `outlineTextCommands` converts the run
 * to the same geometry Skia would have rasterised from the same face. No system
 * font is ever consulted, in either backend (D33).
 *
 * Frames come out as **straight (unpremultiplied) RGBA**, which is what ffmpeg's
 * `-pix_fmt rgba` means and what the `overlay` filter composites correctly.
 * `Canvas.data()` would be cheaper but hands back premultiplied pixels, and
 * feeding those to `overlay` darkens every anti-aliased edge.
 */

import {
  createCanvas,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";

import { outlineTextCommands, type DrawCommand, type Shaper } from "@montaj/render-core";

import { SkiaNodeError } from "./errors.js";
import {
  executeCommands,
  type Approximation,
  type ExecutionContext,
  type MissingResource,
} from "./executor.js";

export interface SkiaNodeBackendOptions {
  /**
   * The HarfBuzz shaper the layout used. Required for any list containing
   * `text` commands, which in practice means every caption frame.
   */
  readonly shaper?: Shaper;
  /** Layer nesting ceiling; a guard, not a tuning knob. */
  readonly maxLayerDepth?: number;
}

export interface FrameOptions {
  readonly width: number;
  readonly height: number;
  /**
   * Clear to this colour before drawing. Omit for a transparent overlay, which
   * is what the ffmpeg `overlay` path wants; pass an opaque colour for a still
   * or for the green-screen output.
   */
  readonly background?: string;
  /**
   * Write the pixels into this buffer instead of a freshly allocated one.
   *
   * It exists so a rasteriser running in a worker thread can draw straight into
   * a `SharedArrayBuffer` the main thread already owns: without it every frame
   * would cross the thread boundary as an 8.3 MB structured clone, which costs
   * more than the parallelism buys. Must be exactly `width × height × 4` bytes.
   */
  readonly into?: Uint8Array;
}

/** What the last frame could not find or could not draw exactly. */
export interface FrameDiagnostics {
  readonly missing: readonly MissingResource[];
  readonly approximations: readonly Approximation[];
}

/**
 * A reusable surface plus its output buffer.
 *
 * A 1080×1920 frame is 8.3 MB of RGBA. A ninety-second Reel is 2,700 frames, so
 * allocating a surface and a buffer per frame is 22 GB of garbage for one
 * render. A batch allocates both once and rewrites them, which is the whole
 * reason this type exists.
 */
export interface FrameBatch {
  readonly width: number;
  readonly height: number;
  /** `width × height × 4` straight RGBA, rewritten by every {@link render}. */
  readonly buffer: Uint8Array;
  /** How many frames this batch has rasterised. */
  readonly rendered: number;
  /** Draws one frame and returns {@link buffer}, which now holds it. */
  render(commands: readonly DrawCommand[]): Uint8Array;
  /** Diagnostics for the most recent {@link render}. */
  readonly diagnostics: FrameDiagnostics;
}

export class SkiaNodeBackend {
  readonly #images = new Map<string, Image>();
  readonly #shaper: Shaper | undefined;
  readonly #maxLayerDepth: number;

  private constructor(shaper: Shaper | undefined, maxLayerDepth: number) {
    this.#shaper = shaper;
    this.#maxLayerDepth = maxLayerDepth;
  }

  /**
   * Async only so that it matches `CanvasKitBackend.create` and so a future
   * option can load something; nothing here awaits today.
   */
  static create(options: SkiaNodeBackendOptions = {}): Promise<SkiaNodeBackend> {
    return Promise.resolve(new SkiaNodeBackend(options.shaper, options.maxLayerDepth ?? 32));
  }

  /** Decodes a PNG/JPEG/WebP for the `image` commands that name `assetId`. */
  async registerImage(assetId: string, bytes: Uint8Array): Promise<void> {
    try {
      const image = await loadImage(Buffer.from(bytes));
      this.#images.set(assetId, image);
    } catch (error) {
      throw new SkiaNodeError(
        "skia-node/bad-image",
        `could not decode the image "${assetId}": ${error instanceof Error ? error.message : String(error)}`,
        { assetId },
      );
    }
  }

  get registeredImageIds(): string[] {
    return [...this.#images.keys()];
  }

  /**
   * Replaces every `text` command with its outline.
   *
   * Exposed because the render loop hashes the list *before* outlining and calls
   * this only for the frames it is about to rasterise, so a cached frame never
   * pays for the conversion.
   */
  outline(commands: readonly DrawCommand[]): DrawCommand[] {
    if (this.#shaper === undefined) {
      if (!containsText(commands)) return [...commands];
      throw new SkiaNodeError(
        "skia-node/no-shaper",
        "this list contains text but the backend was created without a shaper",
      );
    }
    return outlineTextCommands(commands, this.#shaper);
  }

  /** One frame as straight RGBA. Convenience over {@link createBatch} for stills. */
  renderFrameToRgba(commands: readonly DrawCommand[], options: FrameOptions): Uint8Array {
    return this.createBatch(options).render(commands);
  }

  /** One frame as an encoded PNG — the parity harness and the thumbnails. */
  renderToPng(commands: readonly DrawCommand[], options: FrameOptions): Buffer {
    const { canvas, ctx } = this.#surface(options);
    this.#draw(ctx, canvas, commands, options);
    return canvas.toBuffer("image/png");
  }

  /**
   * A surface and a buffer to render N frames through.
   *
   * @throws {SkiaNodeError} when the requested size cannot be allocated.
   */
  createBatch(options: FrameOptions): FrameBatch {
    const { canvas, ctx } = this.#surface(options);
    const bytes = options.width * options.height * 4;
    if (options.into !== undefined && options.into.byteLength !== bytes) {
      throw new SkiaNodeError(
        "skia-node/no-surface",
        `the supplied buffer is ${String(options.into.byteLength)} bytes; a ` +
          `${String(options.width)}×${String(options.height)} frame needs ${String(bytes)}`,
        { width: options.width, height: options.height },
      );
    }
    const buffer = options.into ?? new Uint8Array(bytes);
    // An arrow captures `this` lexically, so the returned object needs no alias.
    const draw = (commands: readonly DrawCommand[]): FrameDiagnostics =>
      this.#draw(ctx, canvas, commands, options);
    let rendered = 0;
    let diagnostics: FrameDiagnostics = { missing: [], approximations: [] };

    return {
      width: options.width,
      height: options.height,
      buffer,
      get rendered() {
        return rendered;
      },
      get diagnostics() {
        return diagnostics;
      },
      render(commands: readonly DrawCommand[]): Uint8Array {
        diagnostics = draw(commands);
        const pixels = ctx.getImageData(0, 0, options.width, options.height).data;
        buffer.set(pixels);
        rendered += 1;
        return buffer;
      },
    };
  }

  /** Frees the decoded images. Surfaces are garbage-collected. */
  dispose(): void {
    this.#images.clear();
  }

  #surface(options: FrameOptions): { canvas: Canvas; ctx: SKRSContext2D } {
    if (
      !Number.isInteger(options.width) ||
      !Number.isInteger(options.height) ||
      options.width <= 0 ||
      options.height <= 0
    ) {
      throw new SkiaNodeError(
        "skia-node/no-surface",
        `cannot make a ${String(options.width)}×${String(options.height)} surface`,
        { width: options.width, height: options.height },
      );
    }
    const canvas = createCanvas(options.width, options.height);
    return { canvas, ctx: canvas.getContext("2d") };
  }

  #draw(
    ctx: SKRSContext2D,
    canvas: Canvas,
    commands: readonly DrawCommand[],
    options: FrameOptions,
  ): FrameDiagnostics {
    const missing: MissingResource[] = [];
    const approximations: Approximation[] = [];
    const context: ExecutionContext = {
      ctx,
      width: options.width,
      height: options.height,
      createCanvas: (width, height) => createCanvas(width, height),
      images: this.#images,
      maxLayerDepth: this.#maxLayerDepth,
      onMissing: (resource) => {
        if (!missing.some((entry) => entry.kind === resource.kind && entry.id === resource.id)) {
          missing.push(resource);
        }
      },
      onApproximate: (approximation) => {
        approximations.push(approximation);
      },
    };

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (options.background !== undefined) {
      ctx.fillStyle = backgroundStyle(options.background);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    try {
      executeCommands(context, this.outline(commands));
    } finally {
      ctx.restore();
    }
    return { missing, approximations };
  }
}

/** `#RRGGBB`/`#RRGGBBAA` as a CSS colour Canvas2D accepts. */
function backgroundStyle(colour: string): string {
  if (colour.length !== 9) return colour;
  const alpha = Number.parseInt(colour.slice(7, 9), 16) / 255;
  return `rgba(${String(Number.parseInt(colour.slice(1, 3), 16))}, ${String(
    Number.parseInt(colour.slice(3, 5), 16),
  )}, ${String(Number.parseInt(colour.slice(5, 7), 16))}, ${String(alpha)})`;
}

function containsText(commands: readonly DrawCommand[]): boolean {
  for (const command of commands) {
    if (command.kind === "text") return true;
    if (
      command.kind === "group" ||
      command.kind === "transform" ||
      command.kind === "clip" ||
      command.kind === "shadow" ||
      command.kind === "blur"
    ) {
      if (containsText(command.children)) return true;
    }
  }
  return false;
}
