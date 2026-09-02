/**
 * Legal page scaffolding (A24 brief: "privacy notice, terms, AUP, refunds, DPA
 * download placeholder pages with clear 'draft — pending counsel' banners
 * (A00-13), grievance officer contact placeholder, attribution line").
 *
 * `docs/PLAN.md` lists A00-13 ("Legal documents... Dikshant + counsel") as
 * `todo`: nobody has drafted these documents yet. Every section below is
 * therefore a **structural placeholder** — the headings a document of this kind
 * needs, and, where a fact is already a decided product commitment (retention
 * windows, refund windows, the grievance response-time targets), that decided
 * fact stated plainly. Nothing that requires legal drafting (liability
 * language, indemnification, governing law, arbitration) is invented; those
 * sections say so explicitly and wait for counsel.
 */

export interface LegalSection {
  readonly heading: string;
  /** Plain paragraphs. A placeholder paragraph is prefixed `[DRAFT]` in the copy itself. */
  readonly body: readonly string[];
}

export interface LegalDoc {
  readonly slug: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly summary: string;
  readonly sections: readonly LegalSection[];
}

/** Every legal page carries this banner (D66, A00-13). */
export const DRAFT_BANNER =
  "Draft — pending counsel review. This page states our decided product commitments and the structure the final document will follow; it is not yet the legally reviewed, effective version.";

export const ATTRIBUTION_LINE =
  "Adobe, Premiere Pro and After Effects are trademarks of Adobe Inc.; DaVinci Resolve is a trademark of Blackmagic Design. Aksharo is not affiliated with or endorsed by Adobe or Blackmagic Design.";

export const GRIEVANCE_OFFICER = {
  title: "Grievance Officer",
  name: "[DRAFT — name pending appointment]",
  email: "grievance@aksharo.ai",
  responseAcknowledgeDays: 1,
  responseResolveDays: 15,
  takedownCourtOrGovernmentHours: 3,
  takedownIndividualComplaintHours: 36,
  note: "Timelines above are the IT Rules 2021 (as amended) obligations we are building to; the officer's name and postal address are placeholders until A00-13 appoints one.",
};

export const LEGAL_DOCS: readonly LegalDoc[] = [
  {
    slug: "privacy",
    title: "Privacy notice",
    shortTitle: "Privacy",
    summary:
      "What we collect, why, and how to exercise your rights over it — DPDP Act, Rule 3 shape.",
    sections: [
      {
        heading: "The itemised notice",
        body: [
          "The purpose-by-purpose list below — what we collect for each purpose, whether it's essential, and what you agreed to by default — is served live from our API's published privacy notice, not authored on this page. It is the same list a sign-up form and the settings page both read, so it cannot drift from what the product actually asks for.",
        ],
      },
      {
        heading: "Sub-processors and international transfer",
        body: [
          "[DRAFT] The published sub-processor list (routed ASR, translation, LLM, hosting, mail, analytics and payment providers, each named with purpose and location) is pending A00-13. Provider terms are contractually required to include no-training and zero-retention clauses before any provider is used in production (02-product-vision.md §Value propositions, point 8).",
        ],
      },
      {
        heading: "Cookies and similar technology",
        body: [
          "[DRAFT] The cookie and local-storage inventory (session, analytics-consent-gated, and none else without a further update to this notice) is pending A00-13.",
        ],
      },
      {
        heading: "Children's data",
        body: [
          "Sign-up is blocked for anyone under 18 in India and under 16 in the EU until a verifiable parental-consent flow ships; a friendly waitlist is offered instead. We do not knowingly collect data from a blocked account.",
        ],
      },
      {
        heading: "Grievance and Data Protection Board",
        body: [
          "You may complain to our Grievance Officer (contact below) or to the Data Protection Board of India. [DRAFT] The Board's current complaint process is linked here once counsel confirms the citation.",
        ],
      },
    ],
  },
  {
    slug: "terms",
    title: "Terms of Service",
    shortTitle: "Terms",
    summary: "The agreement between you and Aksharo for using the product.",
    sections: [
      {
        heading: "The account and the service",
        body: [
          "[DRAFT] Eligibility, account responsibilities, and the surfaces the agreement covers (Web, Desktop, the Premiere Pro / After Effects panel, the DaVinci Resolve integration and the API) are pending counsel's drafting pass over A00-13.",
        ],
      },
      {
        heading: "Plans, credits and billing",
        body: [
          "The commercial terms already decided — the credit meter, the plan ladder, offer pricing, refund and cancellation windows — are published in full on the Pricing page and do not wait on counsel to be accurate; this section will restate them in agreement language once drafted.",
        ],
      },
      {
        heading: "Your content and our licence to it",
        body: [
          "[DRAFT] The scope of licence we need to process your media (transcribe, render, store per the retention table) and the confirmation that we do not use it to train models, ours or a provider's, is pending final drafting.",
        ],
      },
      {
        heading: "Acceptable use",
        body: [
          "Covered in full on the Acceptable Use Policy page, incorporated here by reference once drafted.",
        ],
      },
      {
        heading: "Liability, disputes and governing law",
        body: [
          "[DRAFT] Liability limitations, dispute resolution and the governing law/jurisdiction clause are exactly the kind of language this work package will not invent; they wait for counsel.",
        ],
      },
    ],
  },
  {
    slug: "aup",
    title: "Acceptable Use Policy",
    shortTitle: "AUP",
    summary: "What you may not do with Aksharo, and how we respond when you do.",
    sections: [
      {
        heading: "Prohibited content and conduct",
        body: [
          "No non-consensual intimate imagery (NCII), impersonation, or deepfakes. No content that infringes someone else's rights or breaks the law. No attempt to use the product to generate synthetic avatars, voice clones or dubbing — those are explicit non-goals of the product itself (02-product-vision.md), not only a policy line.",
        ],
      },
      {
        heading: "Share links",
        body: [
          "A review link (`/share/{token}`) is link-only and unindexed, and may be password-protected. Every shared page carries a visible Report button. [DRAFT] The full takedown workflow narrative is pending counsel; the response-time targets we are building to are published on the Grievance page.",
        ],
      },
      {
        heading: "Enforcement",
        body: [
          "[DRAFT] The enforcement ladder (warning, suspension, termination, and law-enforcement referral where required) is pending A00-13.",
        ],
      },
    ],
  },
  {
    slug: "refunds",
    title: "Refunds & Cancellation",
    shortTitle: "Refunds",
    summary: "When you get money back, and how cancellation works.",
    sections: [
      {
        heading: "Monthly plans",
        body: [
          "Cancel any time; you keep access until the current period ends. A 7-day money-back window applies to your first monthly purchase if you used fewer than 20 credits in that period.",
        ],
      },
      {
        heading: "Yearly plans",
        body: ["A 14-day refund window, pro-rated by the credits you actually used."],
      },
      {
        heading: "Failed jobs and bad output",
        body: [
          "A job that fails releases its credit hold automatically — you are not charged and do not need to ask. A settled job that produced a bad result is eligible for a reversal (credits restored with the original expiry) on a manual claim within 7 days.",
        ],
      },
      {
        heading: "Passes and top-ups",
        body: [
          "The ₹9 clean export, the ₹59 Week Pass and credit top-ups are one-time purchases; refund eligibility follows the same failed-job and bad-output rules above. [DRAFT] Any additional consumer-protection language required by counsel is pending A00-13.",
        ],
      },
      {
        heading: "How a refund is issued",
        body: [
          "Every money refund issues a GST credit note against the original invoice and, where the purchase was attributed to an affiliate, claws back the associated commission.",
        ],
      },
    ],
  },
  {
    slug: "dpa",
    title: "Data Processing Addendum",
    shortTitle: "DPA",
    summary: "For Agency and Studio customers who need a signed data-processing agreement.",
    sections: [
      {
        heading: "Status",
        body: [
          "[DRAFT — download placeholder] The Data Processing Addendum itself, and its sub-processor annex, are pending A00-13 and are not yet available to sign or download. If your workspace needs one now, contact us at the address below and we will follow up once it is ready.",
        ],
      },
      {
        heading: "What it will cover",
        body: [
          "The categories of personal data processed on a customer's behalf, the sub-processor list (with the same no-training, zero-retention contractual requirement that already applies to every routed provider), international transfer mechanism, and each party's security obligations.",
        ],
      },
    ],
  },
];

export function legalDocBySlug(slug: string): LegalDoc | undefined {
  return LEGAL_DOCS.find((doc) => doc.slug === slug);
}
