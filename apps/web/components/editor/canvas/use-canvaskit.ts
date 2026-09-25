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
    id: "anton-400",
    family: "Anton",
    weight: 400,
    italic: false,
    file: "anton-400.ttf",
    scripts: ["latin"],
  },
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
  // Every weight `@montaj/fonts`' bundled CATALOGUE ships for Inter
  // (`packages/fonts/src/catalogue.ts`), named and sourced exactly like the
  // pack's own files (`inter-<weight>.ttf`) rather than the ad hoc
  // "Inter-Medium.ttf"-style names this block used before A18b's real subset
  // pack existed. That mismatch is what let this drift silently: the pack has
  // no weight-600 face at all under the old names, so a style asking for Inter
  // 600 (`vertical-clean`, the default a brand-new project opens on) measured
  // through whichever weight `FontRegistry.resolve`'s nearest-match picked
  // instead of the one the server actually has — a real, wrong-face
  // measurement, not the ~1-character shaper noise `checkReflow` tolerates,
  // and the false "Reflow captions" banner on a first, untouched load was one
  // symptom of it.
  { id: "inter-300", family: "Inter", weight: 300, italic: false, file: "inter-300.ttf", scripts: ["latin"] },
  { id: "inter-400", family: "Inter", weight: 400, italic: false, file: "inter-400.ttf", scripts: ["latin"] },
  { id: "inter-500", family: "Inter", weight: 500, italic: false, file: "inter-500.ttf", scripts: ["latin"] },
  { id: "inter-600", family: "Inter", weight: 600, italic: false, file: "inter-600.ttf", scripts: ["latin"] },
  { id: "inter-700", family: "Inter", weight: 700, italic: false, file: "inter-700.ttf", scripts: ["latin"] },
  { id: "inter-900", family: "Inter", weight: 900, italic: false, file: "inter-900.ttf", scripts: ["latin"] },
  // Playfair from the pack (`playfair-display-<weight>.ttf`). Until 2026-09-25
  // this block named five pre-pack fixture files — PlayfairDisplay-SemiBold(,
  // Italic), EBGaramond-Regular, Helvetica(-Bold) — that `copy-render-assets.mjs`
  // never produced. They survived only in the original checkout's `public/`,
  // so the release worktree (a clean checkout, live since 2026-09-19) served
  // them as 404, `loadFonts` rejected, and every CanvasKit surface in the
  // editor — the template tiles included — drew nothing. The pack ships no EB
  // Garamond, Helvetica or italic Playfair; those styles resolve to the
  // nearest registered face, as any unregistered family does.
  { id: "playfair-display-500", family: "Playfair Display", weight: 500, italic: false, file: "playfair-display-500.ttf", scripts: ["latin"] },
  { id: "playfair-display-600", family: "Playfair Display", weight: 600, italic: false, file: "playfair-display-600.ttf", scripts: ["latin"] },
  // Every other face `@montaj/fonts`' bundled CATALOGUE ships — the same list
  // the Font Family picker (`RightPanel.tsx`) already offers. Registering them
  // here is what makes picking one of these actually draw in that family
  // instead of silently falling back (`FontRegistry.resolve`'s last resort) to
  // whichever already-registered face happens to cover the same code points.
  { id: "montserrat-400", family: "Montserrat", weight: 400, italic: false, file: "montserrat-400.ttf", scripts: ["latin"] },
  { id: "montserrat-600", family: "Montserrat", weight: 600, italic: false, file: "montserrat-600.ttf", scripts: ["latin"] },
  { id: "montserrat-800", family: "Montserrat", weight: 800, italic: false, file: "montserrat-800.ttf", scripts: ["latin"] },
  { id: "montserrat-900", family: "Montserrat", weight: 900, italic: false, file: "montserrat-900.ttf", scripts: ["latin"] },
  { id: "poppins-400", family: "Poppins", weight: 400, italic: false, file: "poppins-400.ttf", scripts: ["latin"] },
  { id: "poppins-700", family: "Poppins", weight: 700, italic: false, file: "poppins-700.ttf", scripts: ["latin"] },
  { id: "poppins-800", family: "Poppins", weight: 800, italic: false, file: "poppins-800.ttf", scripts: ["latin"] },
  { id: "roboto-mono-500", family: "Roboto Mono", weight: 500, italic: false, file: "roboto-mono-500.ttf", scripts: ["latin"] },
  { id: "roboto-mono-700", family: "Roboto Mono", weight: 700, italic: false, file: "roboto-mono-700.ttf", scripts: ["latin"] },
  { id: "bricolage-grotesque-700", family: "Bricolage Grotesque", weight: 700, italic: false, file: "bricolage-grotesque-700.ttf", scripts: ["latin"] },
  { id: "bricolage-grotesque-800", family: "Bricolage Grotesque", weight: 800, italic: false, file: "bricolage-grotesque-800.ttf", scripts: ["latin"] },
  { id: "jetbrains-mono-400", family: "JetBrains Mono", weight: 400, italic: false, file: "jetbrains-mono-400.ttf", scripts: ["latin"] },
  { id: "jetbrains-mono-700", family: "JetBrains Mono", weight: 700, italic: false, file: "jetbrains-mono-700.ttf", scripts: ["latin"] },
  { id: "oswald-400", family: "Oswald", weight: 400, italic: false, file: "oswald-400.ttf", scripts: ["latin"] },
  { id: "oswald-700", family: "Oswald", weight: 700, italic: false, file: "oswald-700.ttf", scripts: ["latin"] },
  { id: "raleway-400", family: "Raleway", weight: 400, italic: false, file: "raleway-400.ttf", scripts: ["latin"] },
  { id: "raleway-700", family: "Raleway", weight: 700, italic: false, file: "raleway-700.ttf", scripts: ["latin"] },
  { id: "nunito-400", family: "Nunito", weight: 400, italic: false, file: "nunito-400.ttf", scripts: ["latin"] },
  { id: "nunito-700", family: "Nunito", weight: 700, italic: false, file: "nunito-700.ttf", scripts: ["latin"] },
  { id: "dm-sans-400", family: "DM Sans", weight: 400, italic: false, file: "dm-sans-400.ttf", scripts: ["latin"] },
  { id: "dm-sans-700", family: "DM Sans", weight: 700, italic: false, file: "dm-sans-700.ttf", scripts: ["latin"] },
  { id: "bebas-neue-400", family: "Bebas Neue", weight: 400, italic: false, file: "bebas-neue-400.ttf", scripts: ["latin"] },
  { id: "black-ops-one-400", family: "Black Ops One", weight: 400, italic: false, file: "black-ops-one-400.ttf", scripts: ["latin"] },
  { id: "bungee-400", family: "Bungee", weight: 400, italic: false, file: "bungee-400.ttf", scripts: ["latin"] },
  { id: "bangers-400", family: "Bangers", weight: 400, italic: false, file: "bangers-400.ttf", scripts: ["latin"] },
  { id: "pacifico-400", family: "Pacifico", weight: 400, italic: false, file: "pacifico-400.ttf", scripts: ["latin"] },
  { id: "caveat-400", family: "Caveat", weight: 400, italic: false, file: "caveat-400.ttf", scripts: ["latin"] },
  { id: "caveat-700", family: "Caveat", weight: 700, italic: false, file: "caveat-700.ttf", scripts: ["latin"] },
  { id: "dancing-script-400", family: "Dancing Script", weight: 400, italic: false, file: "dancing-script-400.ttf", scripts: ["latin"] },
  { id: "dancing-script-700", family: "Dancing Script", weight: 700, italic: false, file: "dancing-script-700.ttf", scripts: ["latin"] },
  { id: "permanent-marker-400", family: "Permanent Marker", weight: 400, italic: false, file: "permanent-marker-400.ttf", scripts: ["latin"] },
  { id: "satisfy-400", family: "Satisfy", weight: 400, italic: false, file: "satisfy-400.ttf", scripts: ["latin"] },
  // "other" matches `@montaj/fonts`' own manifest tag for every one of these —
  // `@montaj/edg`'s frozen segmenter alphabet only names latin/devanagari/tamil
  // (`FontRegistry`'s docstring, `packages/render-core/src/script.ts`), so a
  // script beyond those three is "other" until the segmenter itself grows a
  // dedicated case for it. `FontRegistry.resolve`'s coverage-based last resort
  // still finds these faces by their actual glyph coverage regardless, so text
  // in these scripts draws in the right typeface; what "other" does not yet
  // buy is Devanagari/Tamil-grade complex-script line-budgeting or the correct
  // OpenType script tag for shaping (`openTypeScriptTag`'s `default: "Zyyy"`).
  { id: "noto-sans-bengali-400", family: "Noto Sans Bengali", weight: 400, italic: false, file: "noto-sans-bengali-400.ttf", scripts: ["other"] },
  { id: "noto-sans-bengali-700", family: "Noto Sans Bengali", weight: 700, italic: false, file: "noto-sans-bengali-700.ttf", scripts: ["other"] },
  { id: "noto-sans-gurmukhi-400", family: "Noto Sans Gurmukhi", weight: 400, italic: false, file: "noto-sans-gurmukhi-400.ttf", scripts: ["other"] },
  { id: "noto-sans-gurmukhi-700", family: "Noto Sans Gurmukhi", weight: 700, italic: false, file: "noto-sans-gurmukhi-700.ttf", scripts: ["other"] },
  { id: "noto-sans-gujarati-400", family: "Noto Sans Gujarati", weight: 400, italic: false, file: "noto-sans-gujarati-400.ttf", scripts: ["other"] },
  { id: "noto-sans-gujarati-700", family: "Noto Sans Gujarati", weight: 700, italic: false, file: "noto-sans-gujarati-700.ttf", scripts: ["other"] },
  { id: "noto-sans-oriya-400", family: "Noto Sans Oriya", weight: 400, italic: false, file: "noto-sans-oriya-400.ttf", scripts: ["other"] },
  { id: "noto-sans-oriya-700", family: "Noto Sans Oriya", weight: 700, italic: false, file: "noto-sans-oriya-700.ttf", scripts: ["other"] },
  { id: "noto-sans-telugu-400", family: "Noto Sans Telugu", weight: 400, italic: false, file: "noto-sans-telugu-400.ttf", scripts: ["other"] },
  { id: "noto-sans-telugu-700", family: "Noto Sans Telugu", weight: 700, italic: false, file: "noto-sans-telugu-700.ttf", scripts: ["other"] },
  { id: "noto-sans-kannada-400", family: "Noto Sans Kannada", weight: 400, italic: false, file: "noto-sans-kannada-400.ttf", scripts: ["other"] },
  { id: "noto-sans-kannada-700", family: "Noto Sans Kannada", weight: 700, italic: false, file: "noto-sans-kannada-700.ttf", scripts: ["other"] },
  { id: "noto-sans-malayalam-400", family: "Noto Sans Malayalam", weight: 400, italic: false, file: "noto-sans-malayalam-400.ttf", scripts: ["other"] },
  { id: "noto-sans-malayalam-700", family: "Noto Sans Malayalam", weight: 700, italic: false, file: "noto-sans-malayalam-700.ttf", scripts: ["other"] },
  { id: "noto-sans-ol-chiki-400", family: "Noto Sans Ol Chiki", weight: 400, italic: false, file: "noto-sans-ol-chiki-400.ttf", scripts: ["other"] },
  { id: "noto-sans-ol-chiki-700", family: "Noto Sans Ol Chiki", weight: 700, italic: false, file: "noto-sans-ol-chiki-700.ttf", scripts: ["other"] },
  { id: "noto-sans-meetei-mayek-400", family: "Noto Sans Meetei Mayek", weight: 400, italic: false, file: "noto-sans-meetei-mayek-400.ttf", scripts: ["other"] },
  { id: "noto-sans-meetei-mayek-700", family: "Noto Sans Meetei Mayek", weight: 700, italic: false, file: "noto-sans-meetei-mayek-700.ttf", scripts: ["other"] },
  // Arabic script only; Urdu is conventionally set in Nastaliq calligraphic
  // style, a visually distinct typeface this pack does not yet bundle, and
  // this repo's layout engine does not yet do right-to-left line layout (line
  // positions, alignment and word order throughout `render-core/src/layout`
  // are left-to-right only) — real RTL text will draw in the right glyphs,
  // left-to-right, which is wrong for genuine Urdu sentences. Flagged rather
  // than silently shipped as correct.
  { id: "noto-sans-arabic-400", family: "Noto Sans Arabic", weight: 400, italic: false, file: "noto-sans-arabic-400.ttf", scripts: ["other"] },
  { id: "noto-sans-arabic-700", family: "Noto Sans Arabic", weight: 700, italic: false, file: "noto-sans-arabic-700.ttf", scripts: ["other"] },
];

let backendPromise: Promise<CanvasKitBackend> | undefined;
let fontsPromise: Promise<FontResource[]> | undefined;
let shaperPromise: Promise<LayoutEngine> | undefined;

/**
 * Fetches the subset faces once, for both the backend and the shaper.
 *
 * A face that cannot be fetched is skipped, not fatal: one missing file used to
 * reject the whole set and leave every caption surface blank (2026-09-25). A
 * style asking for a skipped face draws in the nearest registered one. Only
 * losing every face is an error.
 */
export async function loadFonts(
  fontBase: string,
  files: readonly FontFile[],
): Promise<FontResource[]> {
  fontsPromise ??= (async (): Promise<FontResource[]> => {
    const settled = await Promise.allSettled(
      files.map(async (font): Promise<FontResource> => {
        const response = await fetch(`${fontBase}${font.file}`);
        if (!response.ok)
          throw new Error(`could not fetch the font ${font.file}: ${String(response.status)}`);
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
    const fonts: FontResource[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") fonts.push(result.value);
      else console.warn(`[renderer] ${String((result.reason as Error).message)}`);
    }
    if (fonts.length === 0) throw new Error("could not fetch any caption font");
    return fonts;
  })();
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
          setState({
            backend: undefined,
            engine: undefined,
            error: error as Error,
            loading: false,
          });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [canvasKitBase, fontBase]);

  return state;
}
