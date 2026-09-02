import Link from "next/link";
import { notFound } from "next/navigation";

import { BRAND } from "@montaj/config";
import { Button } from "@montaj/ui";

import type { Metadata } from "next";

import { comparisonBySlug, COMPARISON_PAGES } from "@/content/site/comparisons";
import { AUTH_NAV } from "@/content/site/nav";

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return COMPARISON_PAGES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = comparisonBySlug(slug);
  if (page === undefined) return { title: "Not found" };
  return {
    title: `${BRAND.name} vs ${page.competitorName}`,
    description: page.summary,
    alternates: { canonical: `/vs/${page.slug}` },
    openGraph: {
      title: `${BRAND.name} vs ${page.competitorName}`,
      description: page.summary,
      url: `/vs/${page.slug}`,
      type: "website",
    },
  };
}

export default async function ComparisonPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const page = comparisonBySlug(slug);
  if (page === undefined) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <header>
        <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight sm:text-5xl">
          {BRAND.name} vs {page.competitorName}
        </h1>
        <p className="text-fg-1 mt-4 text-lg">{page.summary}</p>
        <p className="text-fg-2 mt-3 text-xs" data-testid="comparison-verified">
          Last verified {page.verifiedOn}. Source:{" "}
          {page.sourceUrl === undefined ? (
            page.sourceLabel
          ) : (
            <a
              href={page.sourceUrl}
              className="underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              {page.sourceLabel}
            </a>
          )}
          .
        </p>
      </header>

      <div className="mt-12 overflow-x-auto">
        <table
          className="w-full min-w-[560px] border-collapse text-left text-sm"
          data-testid="comparison-table"
        >
          <thead>
            <tr className="border-border border-b">
              <th scope="col" className="text-fg-2 py-3 pr-4 font-medium">
                {" "}
              </th>
              <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                {page.competitorName}
              </th>
              <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                {BRAND.name}
              </th>
            </tr>
          </thead>
          <tbody>
            {page.facts.map((fact) => (
              <tr key={fact.label} className="border-border border-b last:border-0">
                <th scope="row" className="text-fg-1 py-3 pr-4 font-normal">
                  {fact.label}
                </th>
                <td className="text-fg-2 px-4 py-3">{fact.them}</td>
                <td className="text-fg-0 px-4 py-3">{fact.us}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-12" aria-labelledby="weaknesses-heading">
        <h2 id="weaknesses-heading" className="text-fg-0 text-xl font-semibold">
          What we noted about {page.competitorName}
        </h2>
        <ul className="text-fg-1 mt-4 flex flex-col gap-2 text-sm">
          {page.weaknessesNoted.map((note) => (
            <li key={note} className="flex gap-2">
              <span aria-hidden="true" className="text-fg-2">
                –
              </span>
              {note}
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-14 flex flex-wrap gap-3">
        <Button variant="primary" size="lg" asChild>
          <Link href={AUTH_NAV.getStarted.href}>Start free — one clean export on us</Link>
        </Button>
        <Button variant="outline" size="lg" asChild>
          <Link href="/pricing">See pricing</Link>
        </Button>
      </div>
    </div>
  );
}
