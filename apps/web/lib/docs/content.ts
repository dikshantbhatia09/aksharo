import "server-only";

import { loadApiGroups } from "./openapi";
import { loadPluginGuides } from "./plugin-guides";
import { buildDocsSearchIndex } from "./search";

import type { DocsSearchDoc } from "./schema";

import { loadHelpArticles } from "@/lib/content/loader";

/**
 * Single entry point every `/docs` server component reads from, so the
 * generators (OpenAPI, plugin READMEs, B12's help loader) are only ever
 * assembled in one place. `server-only` because `loadHelpArticles` reads
 * `fs`; the client-facing pieces (`docs-search.tsx`) get the *serialised*
 * search index instead, same as `/help`.
 */
// M07: `DocsLayout` (`app/(site)/(marketing)/docs/layout.tsx`) calls
// `loadDocsSearchIndexSerialised()` once per rendered `/docs/**` page, and
// during static generation that is once per page in the site (guides,
// plugin guides, every API version/tag), not once per build. Each call used
// to re-assemble every doc (including all 298 OpenAPI operations' summaries
// concatenated into search bodies) and rebuild the MiniSearch index from
// scratch — the accumulation across ~100+ `/docs` pages was a real
// contributor to the build OOM this WP fixes. The underlying MDX/plugin/API
// data is static per process, so both the doc list and the serialised index
// are memoised once per worker instead of rebuilt per page.
let searchDocsCache: readonly DocsSearchDoc[] | undefined;
let searchIndexCache: string | undefined;

export function loadDocsSearchDocs(): readonly DocsSearchDoc[] {
  if (searchDocsCache) return searchDocsCache;
  const helpDocs: DocsSearchDoc[] = loadHelpArticles().map((article) => ({
    id: `guides-${article.slug}`,
    title: article.title,
    summary: article.summary,
    body: article.body,
    section: "guides",
    href: `/docs/guides/${article.slug}`,
  }));

  const pluginDocs: DocsSearchDoc[] = loadPluginGuides().map((guide) => ({
    id: `plugins-${guide.slug}`,
    title: guide.title,
    summary: `${guide.title} plugin guide`,
    body: guide.body,
    section: "plugins",
    href: `/docs/plugins/${guide.slug}`,
  }));

  const apiDocs: DocsSearchDoc[] = loadApiGroups().map((group) => ({
    id: `developers-v1-${group.tag}`,
    title: group.label,
    summary: `${group.label} — API reference (v1)`,
    body: group.endpoints
      .map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.summary}`)
      .join(" "),
    section: "developers",
    href: `/docs/developers/v1/${group.tag}`,
  }));

  searchDocsCache = [...helpDocs, ...pluginDocs, ...apiDocs];
  return searchDocsCache;
}

export function loadDocsSearchIndexSerialised(): string {
  if (!searchIndexCache) {
    searchIndexCache = buildDocsSearchIndex(loadDocsSearchDocs());
  }
  return searchIndexCache;
}
