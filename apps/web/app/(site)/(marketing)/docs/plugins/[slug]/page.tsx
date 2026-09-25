import { notFound } from "next/navigation";

import { PageHeader } from "@montaj/ui";

import { EditThisPage } from "../../edit-this-page";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";
import { DocsMarkdownBody } from "@/lib/docs/markdown";
import { getPluginGuide, loadPluginGuides } from "@/lib/docs/plugin-guides";

export function generateStaticParams(): { slug: string }[] {
  return loadPluginGuides().map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({
  params: pendingParams,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  assertServerSurfaceEnabled("plugins");
  const params = await pendingParams;
  const guide = getPluginGuide(params.slug);
  if (!guide) return {};
  return {
    title: guide.title,
    description: `${guide.title} plugin guide.`,
    alternates: { canonical: `/docs/plugins/${guide.slug}` },
  };
}

export default async function DocsPluginGuidePage({
  params: pendingParams,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  assertServerSurfaceEnabled("plugins");
  const params = await pendingParams;
  const guide = getPluginGuide(params.slug);
  if (!guide) notFound();

  return (
    <article className="flex flex-col gap-6" data-testid="docs-plugin-guide">
      <PageHeader title={guide.title} actions={<EditThisPage repoPath={guide.sourcePath} />} />
      <DocsMarkdownBody markdown={guide.body} />
    </article>
  );
}
