import { notFound } from "next/navigation";

import type { Metadata } from "next";

import { HelpArticleView } from "@/components/help/help-article-view";
import { getHelpArticle } from "@/lib/content/loader";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  return { title: article?.title ?? "Help centre" };
}

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) notFound();
  return <HelpArticleView article={article} />;
}
