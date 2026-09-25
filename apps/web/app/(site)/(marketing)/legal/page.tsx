import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

import { LegalDraftBanner } from "./_components/legal-draft-banner";

import type { Metadata } from "next";

import { ATTRIBUTION_LINE, LEGAL_DOCS } from "@/content/site/legal";

export const metadata: Metadata = {
  title: "Legal",
  description: "Privacy notice, terms, acceptable use, refunds, DPA and grievance contact.",
  alternates: { canonical: "/legal" },
  robots: { index: false, follow: true },
};

const EXTRA_LEGAL_LINKS: readonly { href: string; title: string; summary: string }[] = [
  {
    href: "/legal/grievance",
    title: "Grievance Officer",
    summary: "Who to contact, and how quickly we respond, under the IT Rules.",
  },
  {
    href: "/legal/sub-processors",
    title: "Sub-processors",
    summary: "Every third party we share personal data with, and why.",
  },
];

export default function LegalIndexPage(): React.JSX.Element {
  const entries = [
    ...LEGAL_DOCS.map((doc) => ({
      href: `/legal/${doc.slug}`,
      title: doc.title,
      summary: doc.summary,
    })),
    ...EXTRA_LEGAL_LINKS,
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        title="Legal"
        description={`Every published legal document for ${BRAND.name}, in one place.`}
      />

      <div className="mt-6">
        <LegalDraftBanner />
      </div>

      <ul
        className="border-border bg-surface mt-8 flex flex-col rounded-md border"
        data-testid="legal-index-list"
      >
        {entries.map((entry) => (
          <li key={entry.href} className="border-border border-b last:border-0">
            <Link
              href={entry.href}
              className="group flex items-center gap-4 px-5 py-4 no-underline hover:bg-neutral-100/5"
            >
              <span className="min-w-0 flex-1">
                <span className="text-fg-0 block font-semibold">{entry.title}</span>
                <span className="text-fg-2 mt-1 block text-sm">{entry.summary}</span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="text-fg-2 group-hover:text-fg-0 size-4 shrink-0"
                strokeWidth={1.75}
              />
            </Link>
          </li>
        ))}
      </ul>

      <p className="text-fg-2 mt-8 text-xs">{ATTRIBUTION_LINE}</p>
    </div>
  );
}
