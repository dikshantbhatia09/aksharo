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

import { surfaceEnabled, type LaunchSurface } from "./launch-surfaces";

export interface SiteNavItem {
  readonly label: string;
  readonly href: string;
  /**
   * The product surface this link leads to, when the link only makes sense if
   * that surface ships. Items with no `surface` are always shown.
   */
  readonly surface?: LaunchSurface;
}

/**
 * Drop the links whose product is not in this release.
 *
 * The nav offered Plugins and Download while `plugins/` and `apps/desktop` are
 * not in this Git HEAD — the pages existed, described the product, and led to
 * artefacts nobody could obtain (launch-readiness P0-12). Filtering at render
 * keeps one list rather than a launch fork of the whole nav, and makes turning
 * a surface back on a flag change rather than an edit here.
 */
export function visibleNav(
  items: readonly SiteNavItem[],
  flags: Readonly<Record<string, boolean>>,
): readonly SiteNavItem[] {
  return items.filter((item) => item.surface === undefined || surfaceEnabled(item.surface, flags));
}

export const PRIMARY_NAV: readonly SiteNavItem[] = [
  { label: "Features", href: "/features" },
  { label: "Styles", href: "/styles" },
  { label: "Plugins", href: "/plugins", surface: "plugins" },
  { label: "Pricing", href: "/pricing" },
  { label: "Download", href: "/download", surface: "desktop" },
];

export const FOOTER_PRODUCT_NAV: readonly SiteNavItem[] = [
  { label: "Features", href: "/features" },
  { label: "Styles gallery", href: "/styles" },
  { label: "Pricing", href: "/pricing" },
  { label: "Plugins", href: "/plugins", surface: "plugins" },
  { label: "Download", href: "/download", surface: "desktop" },
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
