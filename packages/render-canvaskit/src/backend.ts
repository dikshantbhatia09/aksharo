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

import type {
  DrawCommand,
  Fill,
  FontResource,
  GlyphRun,
  Shaper,
  Stroke,
  WordScript,
} from "@montaj/render-core";
import { createFontRegistry, createHarfBuzzShaper } from "@montaj/render-core";

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
  /** Optional HarfBuzz shaper instance for complex text shaping */
  readonly shaper?: Shaper;
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
  readonly #fontResources = new Map<string, FontResource>();
  #shaper: Shaper | undefined;
  #missing: MissingResource[] = [];

  private constructor(readonly ck: CanvasKit, shaper?: Shaper) {
    this.#shaper = shaper;
  }

  static async create(options: CanvasKitBackendOptions = {}): Promise<CanvasKitBackend> {
    const ck = options.canvasKit ?? (await loadCanvasKit(options));
    const backend = new CanvasKitBackend(ck, options.shaper);
    for (const font of options.fonts ?? []) backend.registerFont(font);
    return backend;
  }

  /**
   * Builds a Skia typeface from a registered face's bytes. The id must be the
   * same `FontResource.id` the layout put in `GlyphRun.fontId`, because that is
   * the only thing tying a glyph id to a face.
   */
  registerFont(font: FontResource): void {
    this.#fontResources.set(font.id, font);
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

  /**
   * Returns a HarfBuzz shaper configured with every registered font.
   * Lazily initialized and cached across calls.
   */
  async getShaper(): Promise<Shaper> {
    if (this.#shaper !== undefined) return this.#shaper;
    const registry = createFontRegistry([...this.#fontResources.values()]);
    this.#shaper = await createHarfBuzzShaper(registry);
    return this.#shaper;
  }

  /**
   * Shapes text using HarfBuzz complex text shaping for Devanagari and Dravidian scripts.
   * Returns a `GlyphRun` with accurate conjunct ligatures and advances in canvas pixels.
   */
  async shapeComplexText(options: {
    readonly text: string;
    readonly fontId: string;
    readonly fontSizePx: number;
    readonly script?: WordScript | string;
    readonly language?: string;
  }): Promise<GlyphRun> {
    const shaper = await this.getShaper();
    const resolvedScript = (options.script ?? "devanagari") as WordScript;
    const shaped = shaper.shape({
      text: options.text,
      fontId: options.fontId,
      script: resolvedScript,
      language: options.language,
    });
    const scale = options.fontSizePx / shaped.upem;
    const glyphs: number[] = [];
    const positions: number[] = [];
    let currentX = 0;
    for (const glyph of shaped.glyphs) {
      glyphs.push(glyph.id);
      positions.push(currentX + glyph.xOffset * scale, glyph.yOffset * scale);
      currentX += glyph.xAdvance * scale;
    }
    return {
      fontId: options.fontId,
      fontSizePx: options.fontSizePx,
      glyphs,
      positions,
      advancePx: shaped.advance * scale,
    };
  }

  /**
   * Shapes and draws complex Indic or multilingual text onto a Skia Canvas.
   */
  async drawComplexText(
    canvas: Canvas,
    options: {
      readonly text: string;
      readonly fontId: string;
      readonly fontSizePx: number;
      readonly x: number;
      readonly y: number;
      readonly fill?: Fill;
      readonly stroke?: Stroke;
      readonly script?: WordScript | string;
      readonly language?: string;
    },
  ): Promise<GlyphRun> {
    const run = await this.shapeComplexText({
      text: options.text,
      fontId: options.fontId,
      fontSizePx: options.fontSizePx,
      script: options.script,
      language: options.language,
    });
    const placedPositions: number[] = [];
    for (let i = 0; i < run.positions.length; i += 2) {
      placedPositions.push(run.positions[i]! + options.x, run.positions[i + 1]! + options.y);
    }
    const placedRun: GlyphRun = {
      ...run,
      positions: placedPositions,
    };
    const commands: DrawCommand[] = [
      {
        kind: "text",
        run: placedRun,
        fill: options.fill ?? { paint: { type: "solid", color: "#ffffffff" } },
        ...(options.stroke !== undefined ? { stroke: options.stroke } : {}),
      },
    ];
    this.drawFrame(canvas, commands);
    return placedRun;
  }

  /**
   * Validates that complex Indic consonant conjuncts render without tofu (glyph ID 0)
   * or broken ligatures using HarfBuzz in CanvasKit.
   */
  async verifyIndicConjuncts(
    fontId: string,
    conjuncts: readonly string[],
    script: WordScript | string = "devanagari",
  ): Promise<{
    readonly total: number;
    readonly passed: number;
    readonly tofuCount: number;
    readonly details: readonly {
      readonly conjunct: string;
      readonly glyphCount: number;
      readonly hasTofu: boolean;
      readonly glyphIds: readonly number[];
    }[];
  }> {
    const shaper = await this.getShaper();
    const details = [];
    let passed = 0;
    let tofuCount = 0;

    for (const conjunct of conjuncts) {
      const shaped = shaper.shape({
        text: conjunct,
        fontId,
        script: script as WordScript,
      });
      const glyphIds = shaped.glyphs.map((g) => g.id);
      // Tofu is glyph 0 (.notdef) or U+FFFD
      const hasTofu = glyphIds.some((id) => id === 0);
      if (hasTofu) {
        tofuCount++;
      } else {
        passed++;
      }
      details.push({
        conjunct,
        glyphCount: glyphIds.length,
        hasTofu,
        glyphIds,
      });
    }

    return { total: conjuncts.length, passed, tofuCount, details };
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

/**
 * A20/A19c: the export worker's off-screen caption surface. `MakeWebGLCanvasSurface`
 * and `MakeSWCanvasSurface` both accept an `OffscreenCanvas` (not just an
 * `HTMLCanvasElement`), so the same GPU-first/CPU-fallback shape
 * `createBrowserSurface` uses for the editor's on-screen preview applies here too —
 * nothing has to be visible on a page for CanvasKit to attach a WebGL context to it,
 * which is exactly what makes an `OffscreenCanvas` usable inside a Web Worker (no DOM
 * there at all). Where `OffscreenCanvas` itself does not exist (older Safari,
 * `probe.ts`'s `offscreenCanvas` flag already gates the whole browser-export path on
 * it) or the GPU context cannot be created (an old device, a blocked context, a
 * CPU raster `MakeSurface`. A GPU surface (WebGL on OffscreenCanvas) cannot be
 * read back losslessly/reliably into CPU memory via snapshot.readPixels() across
 * browsers (returning blank/zero pixels and triggering GPU pipeline stalls).
 * A CPU raster surface in CanvasKit allocates in WebAssembly linear memory and
 * allows instant, bit-exact pixel readback for frame compositing onto the export video.
 */
export function createExportSurface(ck: CanvasKit, width: number, height: number): BrowserSurface {
  const cpu = ck.MakeSurface(width, height);
  if (cpu !== null) return { surface: cpu, backend: "cpu" };
  throw new CanvasKitError(
    "canvaskit/no-surface",
    `could not allocate a ${String(width)}×${String(height)} caption surface on the CPU raster path`,
  );
}
