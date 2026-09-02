"use client";

/**
 * Loading the renderer in the browser, once.
 *
 * CanvasKit's wasm and the subset fonts are ~7 MB together, so every caption
 * surface on the page shares one backend: the promise is module-level, and a
 * component only ever awaits it. The assets are served from the app's own
 * origin (`/canvaskit/`, `/fonts/`) because a `.wasm` cannot be fetched
 * cross-origin under the app's CSP; `scripts/copy-render-assets.mjs` puts them
 * in `public/`.
 *
 * A18b replaces `DEFAULT_FONTS` with the workspace's real subset faces fetched
 * from R2; the shape of what it registers does not change.
 */

import { useEffect, useState } from "react";

import { CanvasKitBackend } from "@montaj/render-canvaskit";
import { createFontRegistry, createHarfBuzzShaper } from "@montaj/render-core";
import type { FontRegistry, FontResource, Shaper } from "@montaj/render-core";

export interface RendererAssets {
  /** Where `canvaskit.wasm` is served from. */
  readonly canvasKitBase?: string;
  /** Where the subset fonts are served from. */
  readonly fontBase?: string;
  /** Faces to register; defaults to the bundled Noto subsets. */
  readonly fonts?: readonly FontFile[];
}

export interface FontFile {
  readonly id: string;
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly file: string;
  readonly scripts?: readonly ("latin" | "devanagari" | "tamil" | "other")[];
}

/** The three scripts the product ships captions in on day one. */
export const DEFAULT_FONTS: readonly FontFile[] = [
  {
    id: "noto-sans-400",
    family: "Noto Sans",
    weight: 400,
    italic: false,
    file: "NotoSans-Regular-subset.ttf",
    scripts: ["latin"],
  },
  {
    id: "noto-sans-devanagari-400",
    family: "Noto Sans Devanagari",
    weight: 400,
    italic: false,
    file: "NotoSansDevanagari-Regular-subset.ttf",
    scripts: ["devanagari"],
  },
  {
    id: "noto-sans-tamil-400",
    family: "Noto Sans Tamil",
    weight: 400,
    italic: false,
    file: "NotoSansTamil-Regular-subset.ttf",
    scripts: ["tamil"],
  },
];

let backendPromise: Promise<CanvasKitBackend> | undefined;
let fontsPromise: Promise<FontResource[]> | undefined;
let shaperPromise: Promise<LayoutEngine> | undefined;

/** Fetches the subset faces once, for both the backend and the shaper. */
async function loadFonts(fontBase: string, files: readonly FontFile[]): Promise<FontResource[]> {
  fontsPromise ??= Promise.all(
    files.map(async (font): Promise<FontResource> => {
      const response = await fetch(`${fontBase}${font.file}`);
      if (!response.ok) throw new Error(`could not fetch the font ${font.file}: ${String(response.status)}`);
      return {
        id: font.id,
        family: font.family,
        weight: font.weight,
        italic: font.italic,
        data: new Uint8Array(await response.arrayBuffer()),
        ...(font.scripts === undefined ? {} : { scripts: font.scripts }),
      };
    }),
  );
  return fontsPromise;
}

/** The layout half: a font registry and the HarfBuzz shaper over it. */
export interface LayoutEngine {
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
}

/**
 * Loads (or returns) the one layout engine this page uses. HarfBuzz is a second
 * wasm module, so a picker of thirty tiles instantiates it once, not thirty
 * times.
 */
export async function loadLayoutEngine(assets: RendererAssets = {}): Promise<LayoutEngine> {
  const fontBase = assets.fontBase ?? "/fonts/";
  const files = assets.fonts ?? DEFAULT_FONTS;
  shaperPromise ??= (async (): Promise<LayoutEngine> => {
    const registry = createFontRegistry(await loadFonts(fontBase, files));
    return { registry, shaper: await createHarfBuzzShaper(registry) };
  })();
  return shaperPromise;
}

/** Loads (or returns) the one backend this page uses. */
export async function loadRenderer(assets: RendererAssets = {}): Promise<CanvasKitBackend> {
  const canvasKitBase = assets.canvasKitBase ?? "/canvaskit/";
  const fontBase = assets.fontBase ?? "/fonts/";
  const files = assets.fonts ?? DEFAULT_FONTS;

  backendPromise ??= (async (): Promise<CanvasKitBackend> => {
    const backend = await CanvasKitBackend.create({
      locateFile: (file) => `${canvasKitBase}${file}`,
    });
    for (const font of await loadFonts(fontBase, files)) backend.registerFont(font);
    return backend;
  })();
  return backendPromise;
}

/** Drops the shared backend, fonts and shaper; used on editor teardown. */
export function resetRenderer(): void {
  backendPromise = undefined;
  fontsPromise = undefined;
  shaperPromise = undefined;
}

export interface RendererState {
  readonly backend: CanvasKitBackend | undefined;
  readonly engine: LayoutEngine | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
}

/**
 * React wrapper over `loadRenderer` and `loadLayoutEngine`, safe to call from
 * many components: both promises are module-level, so the second caller waits
 * on the first caller's wasm rather than starting its own.
 */
export function useRenderer(assets: RendererAssets = {}): RendererState {
  const [state, setState] = useState<RendererState>({
    backend: undefined,
    engine: undefined,
    error: undefined,
    loading: true,
  });

  const canvasKitBase = assets.canvasKitBase;
  const fontBase = assets.fontBase;

  useEffect(() => {
    let cancelled = false;
    const options: RendererAssets = {
      ...(canvasKitBase === undefined ? {} : { canvasKitBase }),
      ...(fontBase === undefined ? {} : { fontBase }),
    };
    Promise.all([loadRenderer(options), loadLayoutEngine(options)])
      .then(([backend, engine]) => {
        if (!cancelled) setState({ backend, engine, error: undefined, loading: false });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ backend: undefined, engine: undefined, error: error as Error, loading: false });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [canvasKitBase, fontBase]);

  return state;
}
