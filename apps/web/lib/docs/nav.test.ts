import { describe, expect, it } from "vitest";

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

describe("buildDocsNav", () => {
  it("omits plugins section by default when plugins launch surface is disabled", () => {
    const nav = buildDocsNav(HELP_ARTICLES, { includePlugins: false });
    expect(nav.map((section) => section.id)).toEqual(["guides", "developers", "legal"]);
  });

  it("has exactly the four sections in a stable order when plugins are enabled", () => {
    const nav = buildDocsNav(HELP_ARTICLES, { includePlugins: true });
    expect(nav.map((section) => section.id)).toEqual(["guides", "plugins", "developers", "legal"]);
  });

  it("lists every help article under Guides", () => {
    const nav = buildDocsNav(HELP_ARTICLES);
    const guides = nav.find((section) => section.id === "guides")!;
    expect(guides.items).toEqual([
      { label: "Getting started", href: "/docs/guides/getting-started" },
    ]);
  });

  it("lists every plugin guide and every API group under their sections when plugins enabled", () => {
    const nav = buildDocsNav(HELP_ARTICLES, { includePlugins: true });
    const plugins = nav.find((section) => section.id === "plugins")!;
    expect(plugins.items.length).toBe(loadPluginGuides().length);
    const developers = nav.find((section) => section.id === "developers")!;
    expect(developers.items.some((item) => item.href === "/docs/developers/v1/projects")).toBe(
      true,
    );
  });
});
