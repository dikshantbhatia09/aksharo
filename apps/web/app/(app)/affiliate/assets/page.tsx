import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Badge, Card, PageHeader } from "@montaj/ui";

import { ASCI_DISCLOSURE_CLAUSE } from "../affiliate-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Affiliate asset pack" };

/** Permitted, plain-language disclosure labels and their minimum on-screen duration (brief §6). */
const DISCLOSURE_LABELS: { label: string; language: string; minDurationSeconds: number }[] = [
  { label: "Paid partnership with Aksharo", language: "English", minDurationSeconds: 3 },
  { label: "Ad: Aksharo se banaya", language: "Hinglish", minDurationSeconds: 3 },
  { label: "विज्ञापन — Aksharo के साथ साझेदारी", language: "Hindi", minDurationSeconds: 3 },
];

const SCRIPTS = [
  { title: "60-second product walkthrough — English", language: "English" },
  { title: "60-second product walkthrough — Hindi", language: "Hindi" },
  { title: "15-second hook — English", language: "English" },
  { title: "15-second hook — Hindi", language: "Hindi" },
];

/**
 * `/affiliate/assets` (brief §6): downloadable Hindi + English scripts, 9:16
 * demo cuts, before/after Hinglish clips, the permitted disclosure labels
 * (kept current without re-signature per 04 §Affiliate), and programme
 * rules. Assets are placeholders until Marketing supplies the actual media —
 * this page is the structure and the copy that governs them.
 */
export default function AffiliateAssetsPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Link
          href="/affiliate"
          className="text-fg-2 hover:text-fg-0 inline-flex min-h-8 items-center self-start rounded-sm text-sm"
        >
          ← Refer &amp; earn
        </Link>
        <PageHeader
          title="Asset pack"
          description="Scripts, demo cuts, and the disclosure labels ASCI requires. Everything here stays current without needing you to re-accept the programme terms."
        />
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-base font-semibold">Scripts (Hindi + English)</h2>
        <ul className="flex flex-col gap-2" data-testid="affiliate-scripts">
          {SCRIPTS.map((script) => (
            <li key={script.title} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-fg-0">{script.title}</span>
              <Badge tone="neutral">{script.language}</Badge>
            </li>
          ))}
        </ul>
        <p className="text-fg-2 text-xs">
          Downloads are added by the marketing team as they are recorded — check back for the
          finished files.
        </p>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-base font-semibold">9:16 demo cuts</h2>
        <p className="text-fg-2 text-sm">Vertical, platform-ready cuts of the product demo.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="affiliate-demo-cuts">
          {["Hook", "Feature tour", "Before/after", "CTA"].map((placeholder) => (
            <div
              key={placeholder}
              className="border-border bg-sunken text-fg-2 flex aspect-9/16 items-center justify-center rounded-md border border-dashed text-center text-xs"
            >
              {placeholder}
              <br />
              (coming soon)
            </div>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-base font-semibold">Before/after Hinglish clips</h2>
        <p className="text-fg-2 text-sm">
          Side-by-side raw vs. captioned/dubbed output, in Hinglish, for a quick before/after cut.
        </p>
        <div
          className="border-border bg-sunken text-fg-2 flex h-24 items-center justify-center rounded-md border border-dashed text-xs"
          data-testid="affiliate-before-after"
        >
          Coming soon
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-base font-semibold">Permitted disclosure labels</h2>
        <p className="text-fg-2 text-sm">{ASCI_DISCLOSURE_CLAUSE}</p>
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[420px] border-collapse text-left text-sm"
            data-testid="affiliate-disclosure-labels"
          >
            <thead>
              <tr className="border-border text-fg-2 border-b text-xs">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Label
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Language
                </th>
                <th scope="col" className="py-2 font-medium">
                  Minimum on-screen time
                </th>
              </tr>
            </thead>
            <tbody>
              {DISCLOSURE_LABELS.map((row) => (
                <tr key={row.label} className="border-border text-fg-0 border-b last:border-0">
                  <td className="py-2 pr-4">{row.label}</td>
                  <td className="text-fg-1 py-2 pr-4">{row.language}</td>
                  <td className="text-fg-1 py-2 tabular-nums">{row.minDurationSeconds} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-base font-semibold">Programme rules</h2>
        <ul className="text-fg-2 flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>No self-referral, including through another account or email address you control.</li>
          <li>No paid search or brand-bidding on “{BRAND.name}” or close misspellings.</li>
          <li>No listing on coupon or deal sites.</li>
          <li>Codes are personal, non-guessable, and revocable at any time.</li>
          <li>Top affiliates are spot-checked for disclosure compliance.</li>
        </ul>
      </Card>
    </div>
  );
}
