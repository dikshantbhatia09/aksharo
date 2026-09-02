import { BRAND } from "@montaj/config";

import { renderOgImage, OG_SIZE } from "../../_components/og-template";

import { comparisonBySlug, COMPARISON_PAGES } from "@/content/site/comparisons";

export const alt = "Aksharo comparison.";
export const size = OG_SIZE;
export const contentType = "image/png";

/**
 * A metadata route is its own route handler, so it needs its own
 * `generateStaticParams` to be pre-rendered per slug at build time — the
 * sibling page's `generateStaticParams` (`vs/[slug]/page.tsx`) does not carry
 * over automatically. Without this it still works (rendered on demand), just
 * not "generated at build time" as the brief asks.
 */
export function generateStaticParams(): { slug: string }[] {
  return COMPARISON_PAGES.map((entry) => ({ slug: entry.slug }));
}

export default async function Image({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}): Promise<ReturnType<typeof renderOgImage>> {
  const { slug } = await params;
  const page = comparisonBySlug(slug);
  const competitor = page?.competitorName ?? "the field";
  return renderOgImage(`${BRAND.name} vs ${competitor}`, page?.summary ?? "");
}
