import { describe, expect, it } from "vitest";

import { HELP_SLUGS, helpUrlFor, isHelpSlug } from "./help-slug-map";

import { loadHelpArticles } from "@/lib/content/loader";

describe("help-slug map (contextual help links)", () => {
  it("every declared help slug resolves to a real, published article", () => {
    const bySlug = new Set(loadHelpArticles().map((article) => article.helpSlug));
    for (const helpSlug of HELP_SLUGS) {
      expect(bySlug.has(helpSlug), `${helpSlug} has no matching article`).toBe(true);
    }
  });

  it("builds a /help/{slug} URL", () => {
    expect(helpUrlFor("upload-media")).toBe("/help/upload-media");
  });

  it("recognises only its own members", () => {
    expect(isHelpSlug("upload-media")).toBe(true);
    expect(isHelpSlug("not-a-real-slug")).toBe(false);
  });
});
