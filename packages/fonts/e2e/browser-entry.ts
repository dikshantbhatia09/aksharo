/**
 * The browser half of the loader harness — what `apps/web` will do, in order.
 *
 * ```
 * GET /fonts/manifest  ->  loadFontsInBrowser (fetch .woff2, decompress to sfnt)
 *                      ->  CanvasKitBackend.registerFont for every face
 *                      ->  execute a DrawCommand[] and read the pixels back
 * ```
 *
 * Nothing here is a stand-in except the CanvasKit module, which the page loads
 * from a script tag. The manifest is the committed pack's own `fonts.json`, the
 * bytes are its `.woff2` files, the decompressor is the real wasm one, and the
 * commands were laid out in Node by `@montaj/render-core` from those same faces
 * — so a face that failed to register shows up as a missing resource and a
 * blank frame, not as a quietly substituted typeface.
 */

import decompress from "woff2-encoder/decompress";

import { type FontManifest } from "@montaj/fonts";
import { loadFontsInBrowser } from "@montaj/fonts/browser";
import { CanvasKitBackend, createBrowserSurface } from "@montaj/render-canvaskit";
import type { DrawCommand } from "@montaj/render-core";

import type { CanvasKit } from "canvaskit-wasm";

interface FrameBundle {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly background: string;
  readonly frames: Record<string, DrawCommand[]>;
  /** Face ids the commands actually reference, written by the Node setup. */
  readonly fontIds: readonly string[];
}

interface Summary {
  readonly backend: "webgl" | "cpu";
  /** How many faces the loader registered, and in which format they arrived. */
  readonly registered: number;
  readonly counts: { readonly woff2: number; readonly sfnt: number };
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
  readonly frames: readonly string[];
  /** Every face id the commands need, that the backend has a typeface for. */
  readonly resolvedFontIds: readonly string[];
}

interface Harness {
  readonly ready: Promise<Summary>;
  renderFrame(name: string): string;
  missing(): { kind: string; id: string }[];
  /** Fraction of pixels that are not the background — a blank frame is 0. */
  inkRatio(name: string): number;
}

declare global {
  var CanvasKitInit: (options: { locateFile: (file: string) => string }) => Promise<CanvasKit>;

  var __aksharoFontHarness: Harness | undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function boot(): Promise<Summary> {
  const ck = await globalThis.CanvasKitInit({ locateFile: (file) => `/${file}` });

  const bundle = (await (await fetch("/commands.json")).json()) as FrameBundle;
  const manifest = (await (await fetch("/fonts/fonts.json")).json()) as FontManifest;

  // The loader under test. `prefer: "woff2"` plus a real decompressor is the
  // path the editor takes: a third of the bytes over the wire, sfnt in memory.
  const loaded = await loadFontsInBrowser({
    manifest,
    prefer: "woff2",
    decompressWoff2: (bytes) => decompress(bytes),
    resolveUrl: (face, format) =>
      format === "woff2" ? `/fonts/${face.woff2 ?? ""}` : `/fonts/${face.file}`,
    families: [...new Set(bundle.fontIds.map((id) => familyOfId(manifest, id)))].filter(
      (family): family is string => family !== undefined,
    ),
  });

  const backend = await CanvasKitBackend.create({ canvasKit: ck });
  for (const font of loaded.fonts) backend.registerFont(font);

  const element = document.getElementById("stage");
  if (!(element instanceof HTMLCanvasElement)) throw new Error("no #stage canvas on the page");
  element.width = bundle.canvas.width;
  element.height = bundle.canvas.height;
  const { surface, backend: surfaceBackend } = createBrowserSurface(ck, element);

  const registeredIds = new Set(backend.registeredFontIds);
  const summary: Summary = {
    backend: surfaceBackend,
    registered: loaded.fonts.length,
    counts: loaded.counts,
    failed: loaded.failed,
    frames: Object.keys(bundle.frames),
    resolvedFontIds: bundle.fontIds.filter((id) => registeredIds.has(id)),
  };

  globalThis.__aksharoFontHarness = {
    ready: Promise.resolve(summary),
    missing: () => [...backend.missingResources],
    renderFrame(name: string): string {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const commands = bundle.frames[name];
      if (commands === undefined) throw new Error(`no such frame: ${name}`);
      backend.drawFrame(surface.getCanvas(), commands, { background: bundle.background });
      surface.flush();
      return toBase64(
        backend.renderToPng(commands, {
          width: bundle.canvas.width,
          height: bundle.canvas.height,
          background: bundle.background,
        }),
      );
    },
    inkRatio(name: string): number {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const commands = bundle.frames[name];
      if (commands === undefined) throw new Error(`no such frame: ${name}`);
      const png = backend.renderToPng(commands, {
        width: bundle.canvas.width,
        height: bundle.canvas.height,
        background: "#00000000",
      });
      const image = ck.MakeImageFromEncoded(png);
      if (image === null) throw new Error("could not decode the frame");
      try {
        const pixels = image.readPixels(0, 0, {
          width: image.width(),
          height: image.height(),
          colorType: ck.ColorType.RGBA_8888,
          alphaType: ck.AlphaType.Unpremul,
          colorSpace: ck.ColorSpace.SRGB,
        });
        if (pixels === null) throw new Error("could not read the frame back");
        let inked = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
          if ((pixels[index] ?? 0) > 8) inked += 1;
        }
        return inked / (pixels.length / 4);
      } finally {
        image.delete();
      }
    },
  };

  const status = document.getElementById("status");
  if (status !== null) status.textContent = `ready:${surfaceBackend}`;
  return summary;
}

/** The family a face id belongs to, so the loader can be asked for it by name. */
function familyOfId(manifest: FontManifest, id: string): string | undefined {
  return manifest.fonts.find((face) => face.id === id)?.family;
}

const ready = boot();
globalThis.__aksharoFontHarness ??= {
  ready,
  missing: () => [],
  inkRatio: () => 0,
  renderFrame: () => {
    throw new Error("the harness is still booting");
  },
};

ready.catch((error: unknown) => {
  const status = document.getElementById("status");
  if (status !== null) status.textContent = `error:${String(error)}`;
});
