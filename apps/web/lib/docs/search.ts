import MiniSearch from "minisearch";

import type { DocsSearchDoc } from "./schema";

// Mirrors `lib/content/search.ts`'s split: this module takes documents as a
// plain argument rather than reading the (`server-only`) loaders itself, so
// the client component that hydrates the index (`docs-search.tsx`) never
// pulls `node:fs` into the browser bundle transitively.

const SEARCH_OPTIONS = {
  fields: ["title", "summary", "body"],
  storeFields: ["title", "summary", "section", "href"],
  searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 3, summary: 2 } },
} as const;

/** Build-time search index over every `/docs` page (brief: "search
 * (client-side index built at build time, no external service)"). */
export function buildDocsSearchIndex(docs: readonly DocsSearchDoc[]): string {
  const miniSearch = new MiniSearch<DocsSearchDoc>({
    fields: [...SEARCH_OPTIONS.fields],
    storeFields: [...SEARCH_OPTIONS.storeFields],
    searchOptions: SEARCH_OPTIONS.searchOptions,
  });
  miniSearch.addAll(docs);
  return JSON.stringify(miniSearch.toJSON());
}

export function loadDocsSearchIndex(serialised: string): MiniSearch<DocsSearchDoc> {
  return MiniSearch.loadJSON<DocsSearchDoc>(serialised, {
    fields: [...SEARCH_OPTIONS.fields],
    storeFields: [...SEARCH_OPTIONS.storeFields],
  });
}
