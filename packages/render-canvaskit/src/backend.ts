/**
 * `CanvasKitBackend` — the object a host holds on to: it owns the CanvasKit
 * module, the typefaces built from the registry's bytes, the decoded images and
 * the `Font` cache, and it draws a `DrawCommand[]` onto a surface.
 *
 * Surfaces: the browser gets a WebGL surface where one exists and falls back to
 * the CPU raster surface otherwise (an old device, a blocked context, a
 * software-rendering VM). Both are Skia, so the output matches; only the speed
 * differs, which is why the fallback is a warning and not an error.
 */

import type { DrawCommand, FontResource } from "@montaj/render-core";

import { Arena } from "./arena.js";
import { loadCanvasKit, type LoadCanvasKitOptions } from "./canvaskit.js";
import { executeCommands, type ExecutionContext } from "./execute.js";

import type { Canvas, CanvasKit, Font, Image, Surface, Typeface } from "canvaskit-wasm";

export class CanvasKitError extends Error {
  override readonly name = "CanvasKitError";
  constructor(
    readonly code: "canvaskit/no-typeface" | "canvaskit/no-surface" | "canvaskit/encode-failed",
    message: string,
  ) {
    super(message);
  }
}

export interface CanvasKitBackendOptions extends LoadCanvasKitOptions {
  /** Faces to register up front; more can be added later. */
  readonly fonts?: readonly FontResource[];
  /** An already-initialised CanvasKit, e.g. one a worker shares. */
  readonly canvasKit?: CanvasKit;
}

export interface DrawFrameOptions {
  /** Clear the surface to this colour first; omit to draw over what is there. */
  readonly background?: string;
}

export interface RenderToPngOptions extends DrawFrameOptions {
  readonly width: number;
  readonly height: number;
}

/** Missing resources are reported rather than thrown, so one bad frame still draws. */
export interface MissingResource {
  readonly kind: "font" | "image";
  readonly id: string;
}

export class CanvasKitBackend {
  readonly #typefaces = new Map<string, Typeface>();
  readonly #images = new Map<string, Image>();
  readonly #fonts = new Map<string, Font>();
  #missing: MissingResource[] = [];

  private constructor(readonly ck: CanvasKit) {}

  static async create(options: CanvasKitBackendOptions = {}): Promise<CanvasKitBackend> {
    const ck = options.canvasKit ?? (await loadCanvasKit(options));
    const backend = new CanvasKitBackend(ck);
    for (const font of options.fonts ?? []) backend.registerFont(font);
    return backend;
  }

  /**
   * Builds a Skia typeface from a registered face's bytes. The id must be the
   * same `FontResource.id` the layout put in `GlyphRun.fontId`, because that is
   * the only thing tying a glyph id to a face.
   */
  registerFont(font: FontResource): void {
    const existing = this.#typefaces.get(font.id);
    if (existing !== undefined) existing.delete();
    const buffer = font.data.buffer.slice(
      font.data.byteOffset,
      font.data.byteOffset + font.data.byteLength,
    ) as ArrayBuffer;
    const typeface = this.ck.Typeface.MakeFreeTypeFaceFromData(buffer);
    if (typeface === null) {
      throw new CanvasKitError(
        "canvaskit/no-typeface",
        `Skia could not read the font "${font.id}" (${font.family}); the bytes are not a TTF or OTF`,
      );
    }
    this.#typefaces.set(font.id, typeface);
    // A new face invalidates any cached size of the same id.
    for (const key of [...this.#fonts.keys()]) {
      if (key.startsWith(`${font.id}@`)) {
        this.#fonts.get(key)?.delete();
        this.#fonts.delete(key);
      }
    }
  }

  /** Decodes a PNG/JPEG/WebP for `image` commands that name `assetId`. */
  registerImage(assetId: string, bytes: Uint8Array): void {
    const image = this.ck.MakeImageFromEncoded(bytes);
    if (image === null) {
      throw new CanvasKitError("canvaskit/no-typeface", `could not decode the image "${assetId}"`);
    }
    this.#images.get(assetId)?.delete();
    this.#images.set(assetId, image);
  }

  get registeredFontIds(): string[] {
    return [...this.#typefaces.keys()];
  }

  /** Resources the last `drawFrame` could not find. */
  get missingResources(): readonly MissingResource[] {
    return this.#missing;
  }

  /** Draws one frame onto an existing canvas (the editor's preview surface). */
  drawFrame(
    canvas: Canvas,
    commands: readonly DrawCommand[],
    options: DrawFrameOptions = {},
  ): void {
    const arena = new Arena();
    this.#missing = [];
    const context: ExecutionContext = {
      ck: this.ck,
      canvas,
      typefaces: this.#typefaces,
      images: this.#images,
      fonts: this.#fonts,
      arena,
      onMissing: (kind, id) => {
        if (!this.#missing.some((entry) => entry.kind === kind && entry.id === id)) {
          this.#missing.push({ kind, id });
        }
      },
    };
    try {
      if (options.background !== undefined) {
        canvas.clear(colourOf(this.ck, options.background));
      }
      executeCommands(context, commands);
    } finally {
      arena.release();
    }
  }

  /**
   * Rasterises a frame on a CPU surface and encodes it as a PNG. This is the
   * harness the golden PNG baselines are made with, and the one A18a re-runs on
   * every backend.
   */
  renderToPng(commands: readonly DrawCommand[], options: RenderToPngOptions): Uint8Array {
    const surface = this.ck.MakeSurface(options.width, options.height);
    if (surface === null) {
      throw new CanvasKitError(
        "canvaskit/no-surface",
        `could not make a ${String(options.width)}×${String(options.height)} raster surface`,
      );
    }
    try {
      this.drawFrame(surface.getCanvas(), commands, {
        background: options.background ?? "#00000000",
      });
      surface.flush();
      const image = surface.makeImageSnapshot();
      try {
        const png = image.encodeToBytes();
        if (png === null) {
          throw new CanvasKitError(
            "canvaskit/encode-failed",
            "Skia could not encode the frame as a PNG",
          );
        }
        return png;
      } finally {
        image.delete();
      }
    } finally {
      surface.delete();
    }
  }

  /** Frees every typeface, image and cached font. */
  dispose(): void {
    for (const font of this.#fonts.values()) font.delete();
    this.#fonts.clear();
    for (const typeface of this.#typefaces.values()) typeface.delete();
    this.#typefaces.clear();
    for (const image of this.#images.values()) image.delete();
    this.#images.clear();
  }
}

function colourOf(ck: CanvasKit, colour: string): Float32Array {
  const r = Number.parseInt(colour.slice(1, 3), 16) / 255;
  const g = Number.parseInt(colour.slice(3, 5), 16) / 255;
  const b = Number.parseInt(colour.slice(5, 7), 16) / 255;
  const a = colour.length === 9 ? Number.parseInt(colour.slice(7, 9), 16) / 255 : 1;
  return ck.Color4f(r, g, b, a);
}

export interface BrowserSurface {
  readonly surface: Surface;
  /** `"webgl"` when the GPU path worked, `"cpu"` when it fell back. */
  readonly backend: "webgl" | "cpu";
}

/**
 * A surface for an HTML canvas: WebGL first, CPU raster second. Returning which
 * one happened lets the editor show "software rendering" rather than silently
 * dropping to 12 fps.
 */
export function createBrowserSurface(ck: CanvasKit, element: HTMLCanvasElement): BrowserSurface {
  const gpu = ck.MakeWebGLCanvasSurface(element);
  if (gpu !== null) return { surface: gpu, backend: "webgl" };
  const cpu = ck.MakeSWCanvasSurface(element);
  if (cpu !== null) return { surface: cpu, backend: "cpu" };
  throw new CanvasKitError(
    "canvaskit/no-surface",
    "neither a WebGL nor a CPU surface could be created for this canvas",
  );
}
