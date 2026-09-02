"use client";

import { LifeBuoy, Search } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { Card, Input } from "@montaj/ui";

import type { HelpArticle, HelpCategory } from "@/lib/content/schema";
import type { HelpSearchDoc } from "@/lib/content/search";

import { loadHelpSearchIndex } from "@/lib/content/search";

const CATEGORY_LABEL: Record<HelpCategory, string> = {
  "getting-started": "Getting started",
  editing: "Editing",
  "captions-and-styles": "Captions and styles",
  exporting: "Exporting",
  "billing-and-credits": "Billing and credits",
  "account-and-privacy": "Account and privacy",
  plugins: "Plugins",
  troubleshooting: "Troubleshooting",
};

/** `/help`: categories, plus a client-side search over the build-time MiniSearch index. */
export function HelpCentre({
  articles,
  searchIndex,
}: {
  readonly articles: readonly HelpArticle[];
  readonly searchIndex: string;
}): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const index = React.useMemo(() => loadHelpSearchIndex(searchIndex), [searchIndex]);
  const results: HelpSearchDoc[] = React.useMemo(() => {
    if (query.trim() === "") return [];
    return index.search(query).map((result) => ({
      id: String(result.id),
      title: String(result.title),
      summary: String(result.summary),
      body: "",
      category: String(result.category),
    }));
  }, [query, index]);

  const byCategory = React.useMemo(() => {
    const groups = new Map<string, HelpArticle[]>();
    for (const article of articles) {
      const list = groups.get(article.category) ?? [];
      list.push(article);
      groups.set(article.category, list);
    }
    return groups;
  }, [articles]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">
          Help centre
        </h1>
        <p className="text-fg-2 text-sm">Search, or browse by category.</p>
      </div>

      <div className="relative">
        <Search className="text-fg-2 absolute left-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the help centre"
          className="pl-9"
          data-testid="help-search-input"
          aria-label="Search the help centre"
        />
      </div>

      {query.trim() !== "" ? (
        <ul className="flex flex-col gap-2" data-testid="help-search-results">
          {results.length === 0 ? (
            <p className="text-fg-2 text-sm">No articles match &quot;{query}&quot;.</p>
          ) : (
            results.map((result) => (
              <li key={result.id}>
                <Link href={`/help/${result.id}`}>
                  <Card className="p-4 transition hover:shadow-sm">
                    <p className="text-fg-0 text-sm font-medium">{result.title}</p>
                    <p className="text-fg-2 text-xs">{result.summary}</p>
                  </Card>
                </Link>
              </li>
            ))
          )}
        </ul>
      ) : (
        <div className="flex flex-col gap-6">
          {Array.from(byCategory.entries()).map(([category, categoryArticles]) => (
            <div key={category}>
              <h2 className="text-fg-0 mb-2 text-sm font-semibold">
                {CATEGORY_LABEL[category as HelpCategory] ?? category}
              </h2>
              <ul className="flex flex-col gap-2">
                {categoryArticles.map((article) => (
                  <li key={article.slug}>
                    <Link
                      href={`/help/${article.slug}`}
                      data-testid={`help-article-${article.slug}`}
                    >
                      <Card className="p-4 transition hover:shadow-sm">
                        <p className="text-fg-0 text-sm font-medium">{article.title}</p>
                        <p className="text-fg-2 text-xs">{article.summary}</p>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <Card className="flex items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-2">
          <LifeBuoy className="text-accent size-4" aria-hidden />
          <p className="text-fg-1 text-sm">Didn&apos;t find what you needed?</p>
        </div>
        <Link
          href="/settings/support"
          className="text-accent text-sm hover:underline"
          data-testid="help-contact-support"
        >
          Contact support
        </Link>
      </Card>
    </div>
  );
}
