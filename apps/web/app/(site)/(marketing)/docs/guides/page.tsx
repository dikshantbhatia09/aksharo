import Link from "next/link";

import { PageHeader } from "@montaj/ui";

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
      <PageHeader title="Guides" description="Creator how-tos, grouped by category." />
      {byCategory.map(({ category, articles: categoryArticles }) => (
        <section key={category} aria-labelledby={`guides-${category}`}>
          <h2 id={`guides-${category}`} className="text-fg-0 mb-3 text-base">
            {/* eslint-disable-next-line security/detect-object-injection -- bracket access on `category`, a typed enum value, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion */}
            {CATEGORY_LABEL[category]}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {categoryArticles.map((article) => (
              <Link
                key={article.slug}
                href={`/docs/guides/${article.slug}`}
                className="block h-full rounded-md no-underline"
                data-testid={`docs-guide-${article.slug}`}
              >
                <div className="border-border bg-surface hover:border-neutral-600 flex h-full flex-col gap-1 rounded-md border p-5 transition-colors">
                  <span className="text-fg-0 text-sm font-medium">{article.title}</span>
                  <span className="text-fg-2 text-sm">{article.summary}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
