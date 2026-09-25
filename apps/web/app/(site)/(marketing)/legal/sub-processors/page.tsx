import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

import { LegalDraftBanner } from "../_components/legal-draft-banner";

import type { Metadata } from "next";

import subProcessors from "@/content/sub-processors.json";

export const metadata: Metadata = {
  title: "Sub-processors",
  description: `Every third party ${BRAND.name} shares personal data with, and why.`,
  alternates: { canonical: "/legal/sub-processors" },
  robots: { index: false, follow: true },
};

/**
 * The sub-processor list (X04 §4), mirroring
 * `apps/api/content/sub-processors.json` (also served live at the public
 * `GET /privacy/sub-processors`) verbatim — same reasoning as
 * `content/site/privacy-notice-mirror.ts`: `next build` must not depend on the
 * API being up, so this is a build-time copy rather than a fetch. Keep the two
 * files identical; a future work package can replace this with an ISR fetch of
 * the live endpoint without changing the shape.
 */
export default function SubProcessorsPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Legal"
        title="Sub-processors"
        description={`Every third party that processes personal data on ${BRAND.name}'s behalf, the purpose, and where it is processed. Referenced by the Data Processing Addendum.`}
      />

      <div className="mt-6">
        <LegalDraftBanner />
      </div>

      <p className="text-fg-2 mt-8 text-xs">List version {subProcessors.version}.</p>

      <div className="border-border bg-surface mt-3 overflow-x-auto rounded-md border px-5">
        <table className="w-full min-w-[32rem] text-left text-sm" data-testid="sub-processor-table">
          <thead>
            <tr className="border-border border-b">
              <th scope="col" className="text-fg-2 py-3 pr-4 font-medium">
                Processor
              </th>
              <th scope="col" className="text-fg-2 py-3 pr-4 font-medium">
                Purpose
              </th>
              <th scope="col" className="text-fg-2 py-3 font-medium">
                Region
              </th>
            </tr>
          </thead>
          <tbody>
            {subProcessors.processors.map((processor) => (
              <tr key={processor.name} className="border-border border-b last:border-0">
                <th scope="row" className="text-fg-0 py-3 pr-4 align-top font-medium">
                  {processor.name}
                </th>
                <td className="text-fg-1 py-3 pr-4 align-top">{processor.purpose}</td>
                <td className="text-fg-1 py-3 align-top">{processor.region}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
