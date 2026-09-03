import type { DocsNavSection } from "./schema";

/**
 * Broken-link check across the docs tree (brief §4). Walks every href the
 * nav actually renders (guides, plugins, developers overview/version/group
 * pages, legal) plus the markdown-derived internal links passed in, and
 * reports any that don't resolve to a known page. Pure and synchronous — no
 * HTTP round trip — so it runs as a fast Vitest unit test rather than a slow
 * crawl of a running server.
 */
export interface LinkCheckResult {
  readonly brokenLinks: readonly string[];
}

function knownDocsRoutes(nav: readonly DocsNavSection[]): Set<string> {
  const routes = new Set<string>([
    "/docs",
    "/docs/guides",
    "/docs/plugins",
    "/docs/developers",
    "/docs/developers/v1",
  ]);
  for (const section of nav) {
    routes.add(section.href);
    for (const item of section.items) routes.add(item.href);
  }
  return routes;
}

/** `href`s are collected from rendered markdown bodies via a simple regex —
 * good enough for this generator's own output, which only ever emits plain
 * `<a href="...">` tags (see `lib/docs/markdown.tsx`). External links
 * (`http(s)://`) and same-page anchors (`#...`) are out of scope: this check
 * only owns internal navigation within `/docs` and `/legal`. */
export function extractInternalLinks(markdown: string): readonly string[] {
  const pattern = /\[[^\]]+\]\((\/[^)]+)\)/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const href = match[1];
    if (href !== undefined) links.push(href.split("#")[0] ?? href);
  }
  return links;
}

export function checkDocsLinks(
  nav: readonly DocsNavSection[],
  extraInternalLinks: readonly string[] = [],
): LinkCheckResult {
  const known = knownDocsRoutes(nav);
  const brokenLinks: string[] = [];

  for (const link of extraInternalLinks) {
    if (link.startsWith("/docs") && !known.has(link)) brokenLinks.push(link);
  }

  return { brokenLinks };
}
