import { notFound } from "next/navigation";

import { EditThisPage } from "../../edit-this-page";

import type { Metadata } from "next";

import { getHelpArticle, loadHelpArticles } from "@/lib/content/loader";
import { MarkdownBody } from "@/lib/content/markdown";

export function generateStaticParams(): { slug: string }[] {
  return loadHelpArticles().map((article) => ({ slug: article.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const article = getHelpArticle(params.slug);
  if (!article) return {};
  return {
    title: article.title,
    description: article.summary,
    alternates: { canonical: `/docs/guides/${article.slug}` },
  };
}

export default function DocsGuideArticlePage({
  params,
}: {
  params: { slug: string };
}): React.JSX.Element {
  const article = getHelpArticle(params.slug);
  if (!article) notFound();

  return (
    <article className="flex flex-col gap-4" data-testid="docs-guide-article">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">
          {article.title}
        </h1>
        <p className="text-fg-2 text-sm">{article.summary}</p>
        <EditThisPage repoPath={`apps/web/content/help/${article.slug}.mdx`} />
      </header>
      <MarkdownBody markdown={article.body} />
    </article>
  );
}
