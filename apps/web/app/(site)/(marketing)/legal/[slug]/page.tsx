import { Check } from "lucide-react";
import { notFound } from "next/navigation";

import { BRAND } from "@montaj/config";
import { Badge, PageHeader } from "@montaj/ui";

import { LegalDraftBanner } from "../_components/legal-draft-banner";

import type { Metadata } from "next";

import { legalDocBySlug, LEGAL_DOCS } from "@/content/site/legal";
import { PRIVACY_NOTICE_MIRROR } from "@/content/site/privacy-notice-mirror";

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

/** A URL-safe anchor for a section heading, for the "On this page" list. */
function sectionId(heading: string): string {
  return `s-${heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

export function generateStaticParams(): { slug: string }[] {
  return LEGAL_DOCS.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = legalDocBySlug(slug);
  if (doc === undefined) return { title: "Not found" };
  return {
    title: doc.title,
    description: doc.summary,
    alternates: { canonical: `/legal/${doc.slug}` },
    robots: { index: false, follow: true },
  };
}

export default async function LegalDocPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const doc = legalDocBySlug(slug);
  if (doc === undefined) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader eyebrow="Legal" title={doc.title} description={doc.summary} />

      <div className="mt-6">
        <LegalDraftBanner />
      </div>

      {doc.sections.length > 2 ? (
        <nav aria-label="On this page" className="border-border mt-8 rounded-md border p-5">
          <p className="text-fg-2 text-xs font-medium">On this page</p>
          <ol className="mt-2 flex list-none flex-col p-0">
            {doc.sections.map((section) => (
              <li key={section.heading}>
                <a
                  href={`#${sectionId(section.heading)}`}
                  className="text-fg-1 hover:text-fg-0 inline-flex min-h-8 items-center text-sm no-underline"
                >
                  {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div className="mt-10 flex flex-col gap-10">
        {doc.sections.map((section) => (
          <section
            key={section.heading}
            id={sectionId(section.heading)}
            aria-labelledby={`section-${section.heading}`}
            className="scroll-mt-24"
          >
            <h2 id={`section-${section.heading}`} className="text-fg-0 text-lg">
              {section.heading}
            </h2>
            <div className="mt-3 flex flex-col gap-3">
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-fg-1 max-w-[68ch] text-base leading-relaxed">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}

        {doc.slug === "privacy" ? (
          <section aria-labelledby="notice-purposes-heading" data-testid="privacy-notice-purposes">
            <h2 id="notice-purposes-heading" className="text-fg-0 text-lg">
              What we collect, purpose by purpose
            </h2>
            <p className="text-fg-2 mt-2 text-xs">
              Notice version {PRIVACY_NOTICE_MIRROR.version}. This is the same itemised list
              {BRAND.name}&apos;s sign-up and settings screens use — a purpose marked essential is
              never asked for, because the product cannot run without it.
            </p>
            <dl className="mt-4 flex flex-col gap-4">
              {PRIVACY_NOTICE_MIRROR.purposes.map((purpose) => (
                <div key={purpose.purpose} className="border-border border-b pb-4 last:border-0">
                  <dt className="text-fg-0 flex items-center gap-2 font-medium">
                    {purpose.title}
                    <Badge tone="neutral">
                      {purpose.essential ? "Essential" : "Off by default"}
                    </Badge>
                  </dt>
                  <dd className="text-fg-1 mt-1 text-sm">{purpose.summary}</dd>
                </div>
              ))}
            </dl>
            <h3 className="text-fg-0 mt-6 text-sm font-semibold">Your rights</h3>
            <ul className="text-fg-1 mt-2 flex flex-col gap-1.5 text-sm">
              {PRIVACY_NOTICE_MIRROR.rights.map((right) => (
                <li key={right} className="flex gap-2">
                  <Check
                    aria-hidden="true"
                    className="text-fg-2 mt-0.5 size-4 shrink-0"
                    strokeWidth={1.75}
                  />
                  <span>{right}</span>
                </li>
              ))}
            </ul>
            <p className="text-fg-2 mt-4 text-xs">
              We respond within {PRIVACY_NOTICE_MIRROR.responseDays} days of a rights request.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
