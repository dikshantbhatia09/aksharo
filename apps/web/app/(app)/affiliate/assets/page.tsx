import Link from "next/link";

import { Badge, Card } from "@montaj/ui";

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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight">Asset pack</h1>
        <p className="text-fg-2 text-sm">
          Scripts, demo cuts, and the disclosure labels ASCI requires. Everything here stays current
          without needing you to re-accept the programme terms.
        </p>
        <Link href="/affiliate" className="text-lime-500 mt-1 inline-block text-sm hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-fg-0 text-base font-medium">Scripts (Hindi + English)</h2>
        <ul className="flex flex-col gap-2" data-testid="affiliate-scripts">
          {SCRIPTS.map((script) => (
            <li key={script.title} className="flex items-center justify-between text-sm">
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

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-fg-0 text-base font-medium">9:16 demo cuts</h2>
        <p className="text-fg-2 text-sm">Vertical, platform-ready cuts of the product demo.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="affiliate-demo-cuts">
          {["Hook", "Feature tour", "Before/after", "CTA"].map((placeholder) => (
            <div
              key={placeholder}
              className="border-border bg-bg-2 text-fg-2 flex aspect-9/16 items-center justify-center rounded-md border text-center text-xs"
            >
              {placeholder}
              <br />
              (coming soon)
            </div>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-fg-0 text-base font-medium">Before/after Hinglish clips</h2>
        <p className="text-fg-2 text-sm">
          Side-by-side raw vs. captioned/dubbed output, in Hinglish, for a quick before/after cut.
        </p>
        <div
          className="border-border bg-bg-2 text-fg-2 flex h-24 items-center justify-center rounded-md border text-xs"
          data-testid="affiliate-before-after"
        >
          Coming soon
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-fg-0 text-base font-medium">Permitted disclosure labels</h2>
        <p className="text-fg-2 text-sm">{ASCI_DISCLOSURE_CLAUSE}</p>
        <table className="text-sm" data-testid="affiliate-disclosure-labels">
          <thead>
            <tr className="text-fg-2 text-left text-xs">
              <th className="pr-4 pb-1 font-medium">Label</th>
              <th className="pr-4 pb-1 font-medium">Language</th>
              <th className="pb-1 font-medium">Minimum on-screen time</th>
            </tr>
          </thead>
          <tbody>
            {DISCLOSURE_LABELS.map((row) => (
              <tr key={row.label} className="text-fg-0">
                <td className="pr-4 py-1">{row.label}</td>
                <td className="pr-4 py-1">{row.language}</td>
                <td className="py-1">{row.minDurationSeconds}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-fg-0 text-base font-medium">Programme rules</h2>
        <ul className="text-fg-2 flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>No self-referral, including through another account or email address you control.</li>
          <li>No paid search or brand-bidding on “Aksharo” or close misspellings.</li>
          <li>No listing on coupon or deal sites.</li>
          <li>Codes are personal, non-guessable, and revocable at any time.</li>
          <li>Top affiliates are spot-checked for disclosure compliance.</li>
        </ul>
      </Card>
    </div>
  );
}
