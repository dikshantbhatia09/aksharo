import { describe, expect, it } from "vitest";

import { PANEL_HELP_SLUGS, PANEL_TABS } from "./RightPanel";

import { HELP_SLUGS, helpUrlFor, isHelpSlug } from "@/components/help/help-slug-map";

/**
 * The "?" affordance wiring (brief §4): every panel tab maps to a real,
 * published help slug, and that slug resolves to a real `/help/{slug}` URL.
 * Rendering `<RightPanel>` itself in jsdom is deliberately not attempted
 * here — its non-"style" tabs mount `StylePreviewCanvas`, which draws
 * through CanvasKit/wasm that jsdom has no runtime for (the same reason
 * `vitest.config.ts` excludes `components/editor/**\/*.tsx` from this
 * project's coverage gate and `style-quick-pick.test.tsx` stops short of
 * opening the style sheet) — so this tests the mapping as pure data instead.
 */
describe("RightPanel help wiring", () => {
  it("gives every panel tab a real help slug", () => {
    for (const tab of PANEL_TABS) {
      const slug = PANEL_HELP_SLUGS[tab.id];
      expect(isHelpSlug(slug), `${tab.id} -> ${slug}`).toBe(true);
      expect(HELP_SLUGS).toContain(slug);
    }
  });

  it("builds a /help/{slug} URL for each mapped tab", () => {
    for (const tab of PANEL_TABS) {
      expect(helpUrlFor(PANEL_HELP_SLUGS[tab.id])).toBe(`/help/${PANEL_HELP_SLUGS[tab.id]}`);
    }
  });

  it("sends Style, Colors and Look to the same caption-styles article", () => {
    expect(PANEL_HELP_SLUGS.style).toBe("caption-styles");
    expect(PANEL_HELP_SLUGS.colors).toBe("caption-styles");
    expect(PANEL_HELP_SLUGS.look).toBe("caption-styles");
  });

  it("sends Anim to the emphasis-timing article", () => {
    expect(PANEL_HELP_SLUGS.anim).toBe("emphasis-timing");
  });
});
