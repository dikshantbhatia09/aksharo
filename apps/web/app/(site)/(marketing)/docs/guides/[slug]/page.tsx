import { notFound } from "next/navigation";

import { PageHeader } from "@montaj/ui";

import { EditThisPage } from "../../edit-this-page";

import type { Metadata } from "next";

import { getHelpArticle, loadHelpArticles } from "@/lib/content/loader";
import { MarkdownBody } from "@/lib/content/markdown";

export function generateStaticParams(): { slug: string }[] {
  return loadHelpArticles().map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({
  params: pendingParams,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await pendingParams;
  const article = getHelpArticle(params.slug);
  if (!article) return {};
  return {
    title: article.title,
    description: article.summary,
    alternates: { canonical: `/docs/guides/${article.slug}` },
  };
}

export default async function DocsGuideArticlePage({
  params: pendingParams,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const params = await pendingParams;
  const article = getHelpArticle(params.slug);
  if (!article) notFound();

  return (
    <article className="flex flex-col gap-6" data-testid="docs-guide-article">
      <PageHeader
        title={article.title}
        description={article.summary}
        actions={<EditThisPage repoPath={`apps/web/content/help/${article.slug}.mdx`} />}
      />
      <MarkdownBody markdown={article.body} />
    </article>
  );
}
