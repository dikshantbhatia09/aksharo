import { notFound } from "next/navigation";

import { BRAND } from "@montaj/config";

import { LegalDraftBanner } from "../_components/legal-draft-banner";

import type { Metadata } from "next";

import { legalDocBySlug, LEGAL_DOCS } from "@/content/site/legal";
import { PRIVACY_NOTICE_MIRROR } from "@/content/site/privacy-notice-mirror";

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
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
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-fg-0 text-3xl font-semibold tracking-tight sm:text-4xl">
        {doc.title}
      </h1>
      <p className="text-fg-1 mt-3 text-base">{doc.summary}</p>

      <div className="mt-6">
        <LegalDraftBanner />
      </div>

      <div className="mt-10 flex flex-col gap-10">
        {doc.sections.map((section) => (
          <section key={section.heading} aria-labelledby={`section-${section.heading}`}>
            <h2 id={`section-${section.heading}`} className="text-fg-0 text-lg font-semibold">
              {section.heading}
            </h2>
            <div className="mt-3 flex flex-col gap-3">
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-fg-1 text-sm leading-relaxed">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}

        {doc.slug === "privacy" ? (
          <section aria-labelledby="notice-purposes-heading" data-testid="privacy-notice-purposes">
            <h2 id="notice-purposes-heading" className="text-fg-0 text-lg font-semibold">
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
                    {purpose.essential ? (
                      <span className="text-fg-2 bg-bg-2 rounded-full px-2 py-0.5 text-2xs">
                        Essential
                      </span>
                    ) : (
                      <span className="text-fg-2 bg-bg-2 rounded-full px-2 py-0.5 text-2xs">
                        Off by default
                      </span>
                    )}
                  </dt>
                  <dd className="text-fg-1 mt-1 text-sm">{purpose.summary}</dd>
                </div>
              ))}
            </dl>
            <h3 className="text-fg-0 mt-6 text-sm font-semibold">Your rights</h3>
            <ul className="text-fg-1 mt-2 flex flex-col gap-1.5 text-sm">
              {PRIVACY_NOTICE_MIRROR.rights.map((right) => (
                <li key={right} className="flex gap-2">
                  <span aria-hidden="true" className="text-lime-500">
                    ✓
                  </span>
                  {right}
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
