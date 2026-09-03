import { describe, expect, it } from "vitest";

import { buildDocsSearchIndex, loadDocsSearchIndex } from "./search";

import type { DocsSearchDoc } from "./schema";

const DOCS: readonly DocsSearchDoc[] = [
  {
    id: "guides-export-your-video",
    title: "Export your video",
    summary: "How to export a finished caption pass.",
    body: "Click export, choose a format, download.",
    section: "guides",
    href: "/docs/guides/export-your-video",
  },
  {
    id: "plugins-premiere",
    title: "Premiere Pro",
    summary: "Premiere Pro plugin guide",
    body: "Install the panel via the ZXP.",
    section: "plugins",
    href: "/docs/plugins/premiere",
  },
];

describe("buildDocsSearchIndex / loadDocsSearchIndex", () => {
  it("round-trips through JSON and finds a document by title", () => {
    const index = loadDocsSearchIndex(buildDocsSearchIndex(DOCS));
    const results = index.search("export");
    expect(results.some((r) => r.id === "guides-export-your-video")).toBe(true);
  });

  it("finds a document by body text", () => {
    const index = loadDocsSearchIndex(buildDocsSearchIndex(DOCS));
    const results = index.search("panel");
    expect(results.some((r) => r.id === "plugins-premiere")).toBe(true);
  });

  it("stores href and section on results", () => {
    const index = loadDocsSearchIndex(buildDocsSearchIndex(DOCS));
    const [result] = index.search("premiere");
    expect(result?.["href"]).toBe("/docs/plugins/premiere");
    expect(result?.["section"]).toBe("plugins");
  });
});
