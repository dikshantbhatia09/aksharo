import { BRAND } from "@montaj/config";

import { PRIVACY_NOTICE_VERSION } from "../users/users.service.js";

/**
 * The itemised privacy notice, as metadata (D61, Rule 3).
 *
 * Rule 3 requires a **standalone itemised notice**, separate from the terms of
 * service, that says for each purpose what is collected and why, and how to
 * withdraw. The prose belongs to the `content` module a later work package adds
 * (and to a translator); what the API owes a client now is the version it must
 * stamp onto a consent record, the purpose list to render, and the published
 * contact of Rule 9.
 *
 * `version` is a date string and is the same one `consent_records.notice_version`
 * carries. Bumping it makes every existing answer stale, which is exactly what
 * `GET /consents` reports as `reconsentRequired`.
 */

export interface NoticePurpose {
  readonly purpose: string;
  readonly title: string;
  readonly summary: string;
  /** `true` when the product cannot run without it, so it is never asked for. */
  readonly essential: boolean;
  /** Default answer on the sign-up form. Every optional purpose defaults to off. */
  readonly defaultGranted: boolean;
}

export interface PrivacyNotice {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly url: string;
  readonly contactEmail: string;
  readonly purposes: readonly NoticePurpose[];
  readonly rights: readonly string[];
  /** DPDP Rule 14 (D61): the target for answering a rights request. */
  readonly responseDays: number;
}

const PURPOSES: readonly NoticePurpose[] = [
  {
    purpose: "service",
    title: "Running the service",
    summary:
      "Your account, workspaces, media, transcripts and edits — the data the product is made of. Kept while your account exists.",
    essential: true,
    defaultGranted: true,
  },
  {
    purpose: "analytics",
    title: "Product analytics",
    summary:
      "Which features are used and where people get stuck, so the product can be improved. Off for declared minors, whatever is answered here (D60).",
    essential: false,
    defaultGranted: false,
  },
  {
    purpose: "memory",
    title: "Remembering your preferences",
    summary:
      "Spellings, glossary terms and style choices, so you do not correct the same word twice. Never used to train AI models on your footage. Viewable, editable and clearable at any time.",
    essential: false,
    defaultGranted: false,
  },
  {
    purpose: "marketing",
    title: "Product news by email",
    summary: "Occasional email about new features and offers. Unsubscribing is one click.",
    essential: false,
    defaultGranted: false,
  },
  {
    purpose: "share_upload",
    title: "Sharing a review link",
    summary:
      "Publishing a review link makes the clip reachable by anyone holding the link, for as long as the link lives.",
    essential: false,
    defaultGranted: false,
  },
  {
    purpose: "affiliate",
    title: "Referrals and affiliate payouts",
    summary:
      "Referral attribution and the identity and tax details a payout needs. Off for declared minors.",
    essential: false,
    defaultGranted: false,
  },
];

export const PRIVACY_NOTICE: PrivacyNotice = {
  version: PRIVACY_NOTICE_VERSION,
  effectiveFrom: `${PRIVACY_NOTICE_VERSION}T00:00:00.000Z`,
  url: `https://${BRAND.domain}/privacy`,
  contactEmail: BRAND.supportEmail,
  purposes: PURPOSES,
  rights: [
    "Access a copy of your data (GET /me/data).",
    "Correct your profile (PATCH /me).",
    "Withdraw any optional consent (POST /consents).",
    "Erase your account and everything in it (DELETE /me).",
    "Nominate someone to exercise these rights on your behalf.",
    "Complain to the Data Protection Board of India.",
  ],
  responseDays: 30,
};
