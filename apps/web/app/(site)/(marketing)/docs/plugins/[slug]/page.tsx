import { notFound } from "next/navigation";

import { EditThisPage } from "../../edit-this-page";

import type { Metadata } from "next";

import { DocsMarkdownBody } from "@/lib/docs/markdown";
import { getPluginGuide, loadPluginGuides } from "@/lib/docs/plugin-guides";

export function generateStaticParams(): { slug: string }[] {
  return loadPluginGuides().map((guide) => ({ slug: guide.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const guide = getPluginGuide(params.slug);
  if (!guide) return {};
  return {
    title: guide.title,
    description: `${guide.title} plugin guide.`,
    alternates: { canonical: `/docs/plugins/${guide.slug}` },
  };
}

export default function DocsPluginGuidePage({
  params,
}: {
  params: { slug: string };
}): React.JSX.Element {
  const guide = getPluginGuide(params.slug);
  if (!guide) notFound();

  return (
    <article className="flex flex-col gap-4" data-testid="docs-plugin-guide">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">
          {guide.title}
        </h1>
        <EditThisPage repoPath={guide.sourcePath} />
      </header>
      <DocsMarkdownBody markdown={guide.body} />
    </article>
  );
}
