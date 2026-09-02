/**
 * A build-time mirror of `apps/api/src/privacy/privacy-notice.ts`'s
 * `PRIVACY_NOTICE` — the real, already-implemented itemised privacy notice
 * (DPDP Rule 3), served live at the public `GET /privacy/notice`.
 *
 * **Why a mirror instead of a fetch.** A server-component fetch to
 * `GET /privacy/notice` at build time would make `next build` depend on the API
 * being reachable — but this WP's own verification command
 * (`pnpm --filter @montaj/web build && pnpm --filter @montaj/web test:e2e`)
 * runs `build` on its own, before Playwright's `webServer` config brings the
 * API up. A build that only succeeds when another process happens to be
 * running is not the "static-friendly (SSG)" the brief asks for. So: this file
 * transcribes the real notice verbatim (every string copied, not
 * paraphrased or invented) rather than re-deriving it, and the privacy page
 * renders this. The live endpoint remains the source of truth for the
 * account-facing consent flow (A05's settings and sign-up screens already call
 * it); swapping this page to an ISR fetch of the same endpoint is a follow-up,
 * not a redesign — the shape below matches `PrivacyNotice` exactly.
 */

export interface NoticePurposeMirror {
  readonly purpose: string;
  readonly title: string;
  readonly summary: string;
  readonly essential: boolean;
  readonly defaultGranted: boolean;
}

export interface PrivacyNoticeMirror {
  readonly version: string;
  readonly purposes: readonly NoticePurposeMirror[];
  readonly rights: readonly string[];
  readonly responseDays: number;
}

export const PRIVACY_NOTICE_VERSION = "2026-09-01";

export const PRIVACY_NOTICE_MIRROR: PrivacyNoticeMirror = {
  version: PRIVACY_NOTICE_VERSION,
  purposes: [
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
        "Which features are used and where people get stuck, so the product can be improved. Off for declared minors, whatever is answered here.",
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
  ],
  rights: [
    "Access a copy of your data.",
    "Correct your profile.",
    "Withdraw any optional consent.",
    "Erase your account and everything in it.",
    "Nominate someone to exercise these rights on your behalf.",
    "Complain to the Data Protection Board of India.",
  ],
  responseDays: 30,
};
