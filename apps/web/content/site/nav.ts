/**
 * The marketing site's own navigation (distinct from `apps/web/lib/nav.ts`,
 * which is the signed-in studio's sidebar).
 *
 * Deliberately lists only routes this work package actually builds. The 08 §3
 * information architecture also names Academy, About and Affiliate — owned by
 * B12 / B07 and not yet built — and a nav that links to them would fail this
 * WP's own link-checker and read as a broken product on day one. Add them here
 * when their work packages ship.
 */

export interface SiteNavItem {
  readonly label: string;
  readonly href: string;
}

export const PRIMARY_NAV: readonly SiteNavItem[] = [
  { label: "Features", href: "/features" },
  { label: "Styles", href: "/styles" },
  { label: "Plugins", href: "/plugins" },
  { label: "Pricing", href: "/pricing" },
  { label: "Download", href: "/download" },
];

export const FOOTER_PRODUCT_NAV: readonly SiteNavItem[] = [
  { label: "Features", href: "/features" },
  { label: "Styles gallery", href: "/styles" },
  { label: "Pricing", href: "/pricing" },
  { label: "Plugins", href: "/plugins" },
  { label: "Download", href: "/download" },
  { label: "Changelog", href: "/changelog" },
];

export const FOOTER_COMPARE_NAV: readonly SiteNavItem[] = [
  { label: "Aksharo vs Kalakar", href: "/vs/kalakar" },
  { label: "Aksharo vs Captik", href: "/vs/captik" },
  { label: "Aksharo vs Submagic", href: "/vs/submagic" },
  { label: "Aksharo vs AutoCut", href: "/vs/autocut" },
];

export const FOOTER_LEGAL_NAV: readonly SiteNavItem[] = [
  { label: "Privacy notice", href: "/legal/privacy" },
  { label: "Cookie notice", href: "/legal/cookies" },
  { label: "Terms of Service", href: "/legal/terms" },
  { label: "Acceptable Use Policy", href: "/legal/aup" },
  { label: "Refunds & Cancellation", href: "/legal/refunds" },
  { label: "Data Processing Addendum", href: "/legal/dpa" },
  { label: "Sub-processors", href: "/legal/sub-processors" },
  { label: "Grievance Officer", href: "/legal/grievance" },
  { label: "Status", href: "/status" },
];

export const AUTH_NAV = {
  signIn: { label: "Sign in", href: "/login" },
  getStarted: { label: "Start free", href: "/signup" },
} as const;
