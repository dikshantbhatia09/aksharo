import { loadApiGroups } from "./openapi";
import { loadPluginGuides } from "./plugin-guides";

import type { DocsNavSection } from "./schema";
import type { HelpArticle } from "@/lib/content/schema";

/**
 * The `/docs` sidebar (brief §1: "navigation, search, version switcher").
 * Built from the same generators the pages render from, so a new plugin
 * guide, API group or help article appears in the nav without a second,
 * hand-maintained list — and so `link-check.ts`'s broken-link test walks
 * exactly what a visitor can click.
 */
export function buildDocsNav(helpArticles: readonly HelpArticle[]): readonly DocsNavSection[] {
  const guides: DocsNavSection = {
    id: "guides",
    label: "Guides",
    href: "/docs/guides",
    items: helpArticles.map((article) => ({
      label: article.title,
      href: `/docs/guides/${article.slug}`,
    })),
  };

  const plugins: DocsNavSection = {
    id: "plugins",
    label: "Plugins",
    href: "/docs/plugins",
    items: loadPluginGuides().map((guide) => ({
      label: guide.title,
      href: `/docs/plugins/${guide.slug}`,
    })),
  };

  const developers: DocsNavSection = {
    id: "developers",
    label: "Developers",
    href: "/docs/developers",
    items: [
      { label: "Overview", href: "/docs/developers" },
      { label: "API reference (v1)", href: "/docs/developers/v1" },
      ...loadApiGroups().map((group) => ({
        label: group.label,
        href: `/docs/developers/v1/${group.tag}`,
      })),
    ],
  };

  const legal: DocsNavSection = {
    id: "legal",
    label: "Legal",
    href: "/legal",
    items: [{ label: "Legal centre", href: "/legal" }],
  };

  return [guides, plugins, developers, legal];
}
