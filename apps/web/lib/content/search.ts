import MiniSearch from "minisearch";

import type { HelpArticle } from "./schema";

// No import of `./loader.js` here on purpose: this module is imported by a
// *client* component (`components/help/help-centre.tsx`, for
// `loadHelpSearchIndex`), and `loader.ts` is `server-only` (fs reads). Taking
// `articles` as a required argument rather than defaulting to
// `loadHelpArticles()` keeps this module's dependency graph free of the
// server-only loader, so the client bundle never touches it transitively.

export interface HelpSearchDoc {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly category: string;
}

function toDoc(article: HelpArticle): HelpSearchDoc {
  return {
    id: article.slug,
    title: article.title,
    summary: article.summary,
    body: article.body,
    category: article.category,
  };
}

/**
 * Build-time search index for `/help` (brief §4: "client-side search over a
 * build-time index (MiniSearch)"). `buildHelpSearchIndex` returns the
 * serialised index (a plain JSON string) the client component hydrates with
 * `MiniSearch.loadJSON`, so the search runs entirely in the browser with no
 * round trip — the same reason `content/**` is baked at build time rather
 * than served from an API.
 */
export function buildHelpSearchIndex(articles: readonly HelpArticle[]): string {
  const miniSearch = new MiniSearch<HelpSearchDoc>({
    fields: ["title", "summary", "body"],
    storeFields: ["title", "summary", "category"],
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 3, summary: 2 } },
  });
  miniSearch.addAll(articles.map(toDoc));
  return JSON.stringify(miniSearch.toJSON());
}

export function loadHelpSearchIndex(serialised: string): MiniSearch<HelpSearchDoc> {
  return MiniSearch.loadJSON<HelpSearchDoc>(serialised, {
    fields: ["title", "summary", "body"],
    storeFields: ["title", "summary", "category"],
  });
}
