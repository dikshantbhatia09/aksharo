/**
 * The real {@link CaptionRenderContext} (D78): a `FontRegistry` over the bundled
 * open-licence pack, and a HarfBuzz `Shaper` over it.
 *
 * `caption-budgets.ts` documented this as A18b's to bind; A18b is on `main` now,
 * so this is that binding. Nothing here is workspace-specific — a brand kit's own
 * uploaded faces are A18b's `registerManifestFonts` onto the render path proper,
 * not this one, which only has to answer "what does the bundled pack's Inter (or
 * Noto Sans, for Devanagari/Tamil) actually measure at this size" for the fit
 * half of the budget. Built once per process: HarfBuzz's wasm instantiation is
 * the one asynchronous step (`createHarfBuzzShaper`'s own doc comment), so paying
 * it on every completion would be paying it needlessly.
 */
import { loadPack } from "@montaj/fonts/node";
import { createHarfBuzzShaper } from "@montaj/render-core";

import type { CaptionRenderContext } from "./caption-budgets.js";

let building: Promise<CaptionRenderContext> | undefined;

/** The bundled pack's registry and shaper, built once and reused after. */
export function captionRenderContext(): Promise<CaptionRenderContext> {
  return (building ??= build());
}

/** Test-only: forget the cached context, so a fresh factory call rebuilds it. */
export function resetCaptionRenderContext(): void {
  building = undefined;
}

async function build(): Promise<CaptionRenderContext> {
  const { registry } = await loadPack();
  const shaper = await createHarfBuzzShaper(registry);
  return { registry, shaper };
}
