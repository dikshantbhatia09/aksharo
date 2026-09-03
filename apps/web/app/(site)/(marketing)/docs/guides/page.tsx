import Link from "next/link";

import { Card } from "@montaj/ui";

import type { Metadata } from "next";

import { loadHelpArticles } from "@/lib/content/loader";
import { HELP_CATEGORIES, type HelpCategory } from "@/lib/content/schema";

export const metadata: Metadata = {
  title: "Guides",
  description:
    "Creator how-tos: getting started, editing, captions and styles, exporting, billing.",
  alternates: { canonical: "/docs/guides" },
};

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

/** `/docs/guides`: the same B12 help articles as `/help`, on the public docs
 * surface — one MDX source, two entry points (in-app help and public docs). */
export default function DocsGuidesPage(): React.JSX.Element {
  const articles = loadHelpArticles();
  const byCategory = HELP_CATEGORIES.map((category) => ({
    category,
    articles: articles.filter((article) => article.category === category),
  })).filter((group) => group.articles.length > 0);

  return (
    <div className="flex flex-col gap-8" data-testid="docs-guides-index">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">Guides</h1>
        <p className="text-fg-2 text-sm">Creator how-tos, grouped by category.</p>
      </div>
      {byCategory.map(({ category, articles: categoryArticles }) => (
        <div key={category}>
          <h2 className="text-fg-0 mb-3 text-sm font-semibold">{CATEGORY_LABEL[category]}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {categoryArticles.map((article) => (
              <Link
                key={article.slug}
                href={`/docs/guides/${article.slug}`}
                data-testid={`docs-guide-${article.slug}`}
              >
                <Card className="flex h-full flex-col gap-1 p-4 transition hover:shadow-sm">
                  <p className="text-fg-0 text-sm font-medium">{article.title}</p>
                  <p className="text-fg-2 text-xs">{article.summary}</p>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
