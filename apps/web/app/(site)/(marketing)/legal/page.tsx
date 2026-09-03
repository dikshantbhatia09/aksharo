import Link from "next/link";

import { BRAND } from "@montaj/config";

import { LegalDraftBanner } from "./_components/legal-draft-banner";

import type { Metadata } from "next";

import { ATTRIBUTION_LINE, LEGAL_DOCS } from "@/content/site/legal";

export const metadata: Metadata = {
  title: "Legal",
  description: "Privacy notice, terms, acceptable use, refunds, DPA and grievance contact.",
  alternates: { canonical: "/legal" },
  robots: { index: false, follow: true },
};

export default function LegalIndexPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight">Legal</h1>
      <p className="text-fg-1 mt-4 text-lg">
        Every published legal document for {BRAND.name}, in one place.
      </p>

      <div className="mt-6">
        <LegalDraftBanner />
      </div>

      <ul className="mt-10 flex flex-col gap-4" data-testid="legal-index-list">
        {LEGAL_DOCS.map((doc) => (
          <li key={doc.slug} className="border-border border-b pb-4">
            <Link href={`/legal/${doc.slug}`} className="text-fg-0 font-semibold hover:underline">
              {doc.title}
            </Link>
            <p className="text-fg-2 mt-1 text-sm">{doc.summary}</p>
          </li>
        ))}
        <li className="border-border border-b pb-4">
          <Link href="/legal/grievance" className="text-fg-0 font-semibold hover:underline">
            Grievance Officer
          </Link>
          <p className="text-fg-2 mt-1 text-sm">
            Who to contact, and how quickly we respond, under the IT Rules.
          </p>
        </li>
        <li className="border-border border-b pb-4">
          <Link href="/legal/sub-processors" className="text-fg-0 font-semibold hover:underline">
            Sub-processors
          </Link>
          <p className="text-fg-2 mt-1 text-sm">
            Every third party we share personal data with, and why.
          </p>
        </li>
      </ul>

      <p className="text-fg-2 mt-10 text-xs">{ATTRIBUTION_LINE}</p>
    </div>
  );
}
