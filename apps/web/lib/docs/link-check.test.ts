import { describe, expect, it } from "vitest";

import { checkDocsLinks, extractInternalLinks } from "./link-check";
import { buildDocsNav } from "./nav";
import { loadPluginGuides } from "./plugin-guides";

import type { HelpArticle } from "@/lib/content/schema";

const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    category: "getting-started",
    helpSlug: "getting-started",
    order: 0,
    summary: "Start here.",
    body: "Welcome.",
  },
];

describe("extractInternalLinks", () => {
  it("extracts internal markdown links and drops anchors/external ones", () => {
    const links = extractInternalLinks(
      "See [the guide](/docs/guides/getting-started#top), [plugins](/docs/plugins) and [Adobe](https://adobe.com).",
    );
    expect(links).toEqual(["/docs/guides/getting-started", "/docs/plugins"]);
  });
});

describe("checkDocsLinks", () => {
  it("reports no broken links across the full generated nav's own hrefs", () => {
    const nav = buildDocsNav(HELP_ARTICLES);
    const everyHref = nav.flatMap((section) => [section.href, ...section.items.map((i) => i.href)]);
    const result = checkDocsLinks(
      nav,
      everyHref.filter((href) => href.startsWith("/docs")),
    );
    expect(result.brokenLinks).toEqual([]);
  });

  it("flags a link to a docs page that does not exist in the nav", () => {
    const nav = buildDocsNav(HELP_ARTICLES);
    const result = checkDocsLinks(nav, ["/docs/guides/this-article-does-not-exist"]);
    expect(result.brokenLinks).toEqual(["/docs/guides/this-article-does-not-exist"]);
  });

  it("every plugin guide's own markdown body only links to real docs/legal pages", () => {
    const nav = buildDocsNav(HELP_ARTICLES);
    for (const guide of loadPluginGuides()) {
      const links = extractInternalLinks(guide.body).filter((link) => link.startsWith("/docs"));
      const result = checkDocsLinks(nav, links);
      expect(result.brokenLinks).toEqual([]);
    }
  });
});
