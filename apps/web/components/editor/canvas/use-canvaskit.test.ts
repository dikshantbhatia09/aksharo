import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CATALOGUE } from "@montaj/fonts";

import { DEFAULT_FONTS, loadFonts, resetRenderer } from "./use-canvaskit";

/**
 * The browser's fit-budget measurement (`checkReflow`, `apps/web/lib/edg/
 * caption-budgets.ts`) only agrees with the server's if both sides shape the
 * SAME face. `FontRegistry.resolve` silently substitutes the nearest
 * registered weight when the exact one is missing (`packages/render-core/src/
 * fonts/registry.ts`'s `#bestInFamily`), which is not shaper noise — it is a
 * different font, with a different average glyph advance — and is exactly
 * what let a brand-new project (opened on `vertical-clean`, Inter weight 600,
 * `DEFAULT_STYLE_REF`) show a false "Reflow captions" banner on first load:
 * `DEFAULT_FONTS` had no weight-600 Inter face at all (it still named the ad
 * hoc pre-A18b files, "Inter-Medium.ttf" and friends), so the browser measured
 * through a substitute weight the server never used.
 *
 * `@montaj/fonts`' `CATALOGUE` (the bundled pack's own manifest, also what
 * `RightPanel.tsx`'s Font Family picker reads) is the thing to stay in sync
 * with — not "every weight some style asks for", because a style can name a
 * weight the pack itself does not carry (Inter 800, `kinetic-circle-wipe` /
 * `kinetic-cross-orbit`), and that is a shared, pre-existing gap: the server
 * substitutes the nearest weight too, so there is no client/server mismatch
 * to catch there.
 */
describe("DEFAULT_FONTS covers what the bundled pack ships", () => {
  it("registers an exact-weight, non-italic face for every Inter weight the pack carries", () => {
    const inter = CATALOGUE.find((family) => family.family === "Inter");
    if (inter === undefined) throw new Error("the bundled pack no longer carries Inter");
    // The pack has no italic Inter face (`packages/fonts/src/catalogue.ts`),
    // so pinning italic here would assert something neither side can measure.
    expect(inter.faces.length).toBeGreaterThan(0);

    for (const face of inter.faces) {
      const match = DEFAULT_FONTS.find(
        (font) => font.family === "Inter" && font.weight === face.weight && !font.italic,
      );
      expect(
        match,
        `no exact Inter ${String(face.weight)} face registered in DEFAULT_FONTS`,
      ).toBeDefined();
    }
  });

  it("names every Inter entry after the pack file it is, not an ad hoc placeholder", () => {
    // `copy-render-assets.mjs` copies the pack's Inter faces as `inter-<weight>.ttf`
    // — the same convention every other pack-sourced family in this list already
    // uses (`montserrat-400.ttf`, `poppins-700.ttf`, ...). A name outside that
    // convention (the pre-A18b "Inter-Medium.ttf") is never actually copied
    // there, so it is either 404ing or resolving to a stray, uncontrolled file.
    for (const font of DEFAULT_FONTS) {
      if (font.family !== "Inter") continue;
      expect(font.file).toBe(`inter-${String(font.weight)}.ttf`);
    }
  });
});

/**
 * `public/fonts/` is gitignored and filled only by `copy-render-assets.mjs`, so
 * a name that script does not produce 404s on a clean checkout — which is what
 * production runs. Five such names blanked every caption surface in the editor
 * from 2026-09-19 to 2026-09-25, while the original checkout still had stray
 * copies and looked fine.
 */
describe("every DEFAULT_FONTS file is one copy-render-assets.mjs produces", () => {
  it("names only files the script copies", () => {
    const script = readFileSync(join(__dirname, "../../../scripts/copy-render-assets.mjs"), "utf8");
    for (const font of DEFAULT_FONTS) {
      expect(script, `${font.file} is never copied into public/fonts`).toContain(`"${font.file}"`);
    }
  });
});

describe("loadFonts", () => {
  afterEach(() => {
    resetRenderer();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const faces = [
    { id: "a", family: "A", weight: 400, italic: false, file: "a.ttf" },
    { id: "b", family: "B", weight: 400, italic: false, file: "b.ttf" },
  ];

  it("skips a face that 404s instead of failing every caption surface", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("b.ttf")
            ? new Response(null, { status: 404 })
            : new Response(new Uint8Array([1, 2, 3])),
        ),
      ),
    );
    const fonts = await loadFonts("/fonts/", faces);
    expect(fonts.map((font) => font.id)).toEqual(["a"]);
  });

  it("fails only when no face loads at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
    await expect(loadFonts("/fonts/", faces)).rejects.toThrow("could not fetch any caption font");
  });
});
