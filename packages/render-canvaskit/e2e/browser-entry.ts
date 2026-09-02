/**
 * The browser half of the parity harness.
 *
 * It does exactly what `apps/web` does: take the CanvasKit module the page
 * loaded, register the same fixture fonts the Node baselines were drawn with,
 * and execute a stored `DrawCommand[]` — first onto the visible WebGL canvas
 * (which is what the editor sees) and then onto a CPU surface it can encode, so
 * the test compares a real PNG against the stored one.
 *
 * Bundled by `build-bundle.mjs`; `canvaskit-wasm` is aliased away because the
 * page loads the wasm from a script tag.
 */


import type { DrawCommand } from "@montaj/render-core";

import { CanvasKitBackend, createBrowserSurface } from "../src/index.js";

import type { CanvasKit } from "canvaskit-wasm";

interface FrameBundle {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly background: string;
  readonly frames: Record<string, DrawCommand[]>;
}

interface Harness {
  readonly ready: Promise<{ backend: "webgl" | "cpu"; fonts: number; frames: string[] }>;
  renderFrame(name: string): string;
  frameNames(): string[];
  missing(): { kind: string; id: string }[];
}

declare global {
   
  var CanvasKitInit: (options: { locateFile: (file: string) => string }) => Promise<CanvasKit>;
   
  var __aksharoHarness: Harness | undefined;
}

const FONT_FILES = [
  { id: "noto-sans", family: "Noto Sans", file: "NotoSans-Regular-subset.ttf", script: "latin" },
  {
    id: "noto-sans-devanagari",
    family: "Noto Sans Devanagari",
    file: "NotoSansDevanagari-Regular-subset.ttf",
    script: "devanagari",
  },
  { id: "noto-sans-tamil", family: "Noto Sans Tamil", file: "NotoSansTamil-Regular-subset.ttf", script: "tamil" },
] as const;

/** The same aliases `@montaj/render-core/testing` registers in Node. */
const ALIASES = ["Inter", "Poppins", "Montserrat", "Bebas Neue", "Anton", "Roboto Mono", "Playfair Display"];
const WEIGHTS = [400, 700, 900];

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function boot(): Promise<{ backend: "webgl" | "cpu"; fonts: number; frames: string[] }> {
  const ck = await globalThis.CanvasKitInit({ locateFile: (file) => `/${file}` });

  const [bundle, ...fontBuffers] = await Promise.all([
    fetch("/commands.json").then(async (response) => (await response.json()) as FrameBundle),
    ...FONT_FILES.map(async (font) => new Uint8Array(await (await fetch(`/fonts/${font.file}`)).arrayBuffer())),
  ]);

  const backend = await CanvasKitBackend.create({ canvasKit: ck });
  for (const [index, font] of FONT_FILES.entries()) {
    const data = fontBuffers[index];
    if (data === undefined) continue;
    for (const weight of WEIGHTS) {
      backend.registerFont({ id: `${font.id}-${String(weight)}`, family: font.family, weight, italic: false, data });
    }
  }
  const latin = fontBuffers[0];
  if (latin !== undefined) {
    for (const family of ALIASES) {
      for (const weight of WEIGHTS) {
        backend.registerFont({
          id: `${family.toLowerCase().replace(/\s+/g, "-")}-${String(weight)}`,
          family,
          weight,
          italic: false,
          data: latin,
        });
      }
    }
  }

  const element = document.getElementById("stage");
  if (!(element instanceof HTMLCanvasElement)) throw new Error("no #stage canvas on the page");
  element.width = bundle.canvas.width;
  element.height = bundle.canvas.height;
  const { surface, backend: surfaceBackend } = createBrowserSurface(ck, element);

  globalThis.__aksharoHarness = {
    ready: Promise.resolve({
      backend: surfaceBackend,
      fonts: backend.registeredFontIds.length,
      frames: Object.keys(bundle.frames),
    }),
    frameNames: () => Object.keys(bundle.frames),
    missing: () => [...backend.missingResources],
    renderFrame(name: string): string {
      const commands = bundle.frames[name];
      if (commands === undefined) throw new Error(`no such frame: ${name}`);
      // Draw onto the on-screen surface first — that is the path the editor
      // uses, and a WebGL failure has to fail the test, not be skipped.
      backend.drawFrame(surface.getCanvas(), commands, { background: bundle.background });
      surface.flush();
      // Then encode from a CPU surface, because a GPU snapshot cannot be read
      // back losslessly in every browser.
      return toBase64(
        backend.renderToPng(commands, {
          width: bundle.canvas.width,
          height: bundle.canvas.height,
          background: bundle.background,
        }),
      );
    },
  };

  const status = document.getElementById("status");
  if (status !== null) status.textContent = `ready:${surfaceBackend}`;
  return { backend: surfaceBackend, fonts: backend.registeredFontIds.length, frames: Object.keys(bundle.frames) };
}

const ready = boot();
globalThis.__aksharoHarness ??= {
  ready,
  frameNames: () => [],
  missing: () => [],
  renderFrame: () => {
    throw new Error("the harness is still booting");
  },
};

ready.catch((error: unknown) => {
  const status = document.getElementById("status");
  if (status !== null) status.textContent = `error:${String(error)}`;
});
