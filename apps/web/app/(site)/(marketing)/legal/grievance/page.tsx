import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

import { LegalDraftBanner } from "../_components/legal-draft-banner";

import type { Metadata } from "next";

import { GRIEVANCE_OFFICER } from "@/content/site/legal";

export const metadata: Metadata = {
  title: "Grievance Officer",
  description: `How to reach ${BRAND.name}'s Grievance Officer and what response times to expect.`,
  alternates: { canonical: "/legal/grievance" },
  robots: { index: false, follow: true },
};

export default function GrievancePage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Legal"
        title="Grievance Officer"
        description="Published under the Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules."
      />

      <div className="mt-6">
        <LegalDraftBanner />
      </div>

      <dl
        className="border-border bg-surface mt-8 grid gap-x-6 gap-y-4 rounded-md border p-5 text-sm sm:grid-cols-[14rem_1fr] [&>div]:contents"
        data-testid="grievance-details"
      >
        <div>
          <dt className="text-fg-2">Name</dt>
          <dd className="text-fg-0">{GRIEVANCE_OFFICER.name}</dd>
        </div>
        <div>
          <dt className="text-fg-2">Email</dt>
          <dd className="text-fg-0">
            <a href={`mailto:${GRIEVANCE_OFFICER.email}`}>{GRIEVANCE_OFFICER.email}</a>
          </dd>
        </div>
        <div>
          <dt className="text-fg-2">Acknowledgement target</dt>
          <dd className="text-fg-0">Within {GRIEVANCE_OFFICER.responseAcknowledgeDays} day</dd>
        </div>
        <div>
          <dt className="text-fg-2">Resolution target</dt>
          <dd className="text-fg-0">Within {GRIEVANCE_OFFICER.responseResolveDays} days</dd>
        </div>
        <div>
          <dt className="text-fg-2">Court or government takedown order</dt>
          <dd className="text-fg-0">
            Actioned within {GRIEVANCE_OFFICER.takedownCourtOrGovernmentHours} hours
          </dd>
        </div>
        <div>
          <dt className="text-fg-2">Individual complaint (including NCII)</dt>
          <dd className="text-fg-0">
            Actioned within {GRIEVANCE_OFFICER.takedownIndividualComplaintHours} hours, with a fast
            path for non-consensual intimate imagery
          </dd>
        </div>
      </dl>

      <p className="text-fg-2 mt-8 text-xs">{GRIEVANCE_OFFICER.note}</p>
    </div>
  );
}
