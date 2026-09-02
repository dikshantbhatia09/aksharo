import { describe, expect, it } from "vitest";

import { loadHelpArticles } from "./loader.js";
import { buildHelpSearchIndex, loadHelpSearchIndex } from "./search.js";

describe("help search index (brief §4)", () => {
  it("builds an index that finds an article by a word in its title", () => {
    const articles = loadHelpArticles();
    const serialised = buildHelpSearchIndex(articles);
    const index = loadHelpSearchIndex(serialised);

    const results = index.search("transcript");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.id === "fixing-the-transcript")).toBe(true);
  });

  it("finds an article via a fuzzy/prefix match", () => {
    const articles = loadHelpArticles();
    const index = loadHelpSearchIndex(buildHelpSearchIndex(articles));
    const results = index.search("upload");
    expect(results.some((result) => result.id === "uploading-media")).toBe(true);
  });

  it("returns nothing for a nonsense query", () => {
    const articles = loadHelpArticles();
    const index = loadHelpSearchIndex(buildHelpSearchIndex(articles));
    expect(index.search("zzzznonexistentqueryzzzz")).toEqual([]);
  });
});
