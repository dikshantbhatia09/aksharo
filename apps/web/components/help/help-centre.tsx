"use client";

import { LifeBuoy, Search } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { Button, Card, Input, PageHeader } from "@montaj/ui";

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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <PageHeader title="Help centre" description="Search the articles, or browse by topic." />

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
        results.length === 0 ? (
          <p className="text-fg-2 text-sm" data-testid="help-search-results" role="status">
            No articles match &quot;{query}&quot;. Try a shorter word, or contact support below.
          </p>
        ) : (
          // One card with divided rows (DESIGN.md > Lists / tables) rather than
          // a stack of cards; the whole row is the link.
          <ul
            className="border-border bg-surface divide-border divide-y overflow-hidden rounded-md border"
            data-testid="help-search-results"
          >
            {results.map((result) => (
              <li key={result.id}>
                <Link
                  href={`/help/${result.id}`}
                  className="hover:bg-neutral-100/5 block p-4 transition-colors duration-[160ms] no-underline"
                >
                  <p className="text-fg-0 text-sm font-medium">{result.title}</p>
                  <p className="text-fg-2 text-xs">{result.summary}</p>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="flex flex-col gap-8">
          {Array.from(byCategory.entries()).map(([category, categoryArticles]) => (
            <section key={category} className="flex flex-col gap-3">
              <h2 className="text-fg-0 text-base font-semibold">
                {CATEGORY_LABEL[category as HelpCategory] ?? category}
              </h2>
              <ul className="border-border bg-surface divide-border divide-y overflow-hidden rounded-md border">
                {categoryArticles.map((article) => (
                  <li key={article.slug}>
                    <Link
                      href={`/help/${article.slug}`}
                      className="hover:bg-neutral-100/5 block p-4 transition-colors duration-[160ms] no-underline"
                      data-testid={`help-article-${article.slug}`}
                    >
                      <p className="text-fg-0 text-sm font-medium">{article.title}</p>
                      <p className="text-fg-2 text-xs">{article.summary}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LifeBuoy className="text-fg-2 size-4" aria-hidden strokeWidth={1.75} />
          <p className="text-fg-1 text-sm">Didn&apos;t find what you needed?</p>
        </div>
        <Button variant="secondary" size="sm" asChild>
          <Link href="/settings/support" data-testid="help-contact-support">
            Contact support
          </Link>
        </Button>
      </Card>
    </div>
  );
}
