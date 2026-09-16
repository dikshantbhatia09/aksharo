import {
  Captions,
  Folder,
  Gift,
  GraduationCap,
  HandHeart,
  LayoutGrid,
  LifeBuoy,
  LayoutTemplate,
  Palette,
  Plug,
  SlidersHorizontal,
  Users,
  Waypoints,
  Zap,
} from "lucide-react";

import { BRAND } from "@montaj/config";

import type { LucideIcon } from "lucide-react";


/**
 * The navigation of the premium design canvas ("Aksharo Studio (premium)"), in
 * its order.
 *
 * The canvas's rail carries exactly eight destinations, and they are not the
 * eight this file used to list: the pipeline leads, the studio is second, and
 * Templates/Academy/Plugins/Team/Refer/Help are not on it at all. Those pages
 * are real and shipped, so dropping them outright would hide working features
 * behind a redesign — they moved to {@link SECONDARY_NAV}, which the expanded
 * sidebar renders under a "More" heading and the 68 px rail does not render at
 * all. That keeps the rail faithful to the canvas without losing a route.
 *
 * `short` is the rail's caption: the rail is 68 px wide and shows a 9 px label
 * under each icon, so an item needs a one-word name as well as its full one.
 *
 * `ready` says whether the destination exists yet. An item that is not ready
 * renders as a disabled row with a "Soon" chip rather than a link to a 404 —
 * the shell ships before some of the pages it points at, and a dead link is a
 * worse first impression than an honest one. The owning work package flips the
 * flag when its route lands.
 *
 * The icons are Lucide, not the canvas's Phosphor. Both are 1.5 px-stroke
 * outline sets and the named equivalents are near-identical at 14–19 px; the
 * rest of this app — the editor, every admin screen, a hundred-odd files — is
 * already Lucide, and shipping a second icon library for eight rail entries
 * would put two icon languages on the same screen, which is the one thing a
 * design system exists to prevent. Each item below names the Phosphor icon the
 * canvas asked for so the substitution is auditable.
 */

export interface NavItem {
  readonly key: string;
  readonly label: string;
  /** The rail's one-word caption under the icon. */
  readonly short: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly ready: boolean;
  /** The work package that builds the destination, shown in the tooltip. */
  readonly owner?: string;
  /**
   * What the chip on a disabled row says. Defaults to "Soon", which is right
   * for a destination that does not exist yet and wrong for one that exists
   * but has nothing to open — see the Editor entry.
   */
  readonly disabledBadge?: string;
  /** The tooltip on a disabled row. Defaults to "{label} is on its way." */
  readonly disabledNote?: string;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  {
    // canvas: ph-flow-arrow
    key: "repurpose",
    label: "Clips pipeline",
    short: "Clips",
    href: "/repurpose",
    icon: Waypoints,
    ready: true,
  },
  // canvas: ph-squares-four
  { key: "home", label: "Studio", short: "Studio", href: "/", icon: LayoutGrid, ready: true },
  {
    // canvas: ph-folders
    key: "projects",
    label: "Projects",
    short: "Files",
    href: "/projects",
    icon: Folder,
    ready: true,
  },
  {
    // canvas: ph-subtitles. `/p/[id]` needs a project, so the shell resolves
    // this one to the most recently updated project and disables it when the
    // workspace has none — see `components/shell/nav-items.ts`.
    key: "editor",
    label: "Editor",
    short: "Edit",
    href: "/projects",
    icon: Captions,
    ready: true,
  },
  {
    // canvas: ph-palette
    key: "styles",
    label: "Styles",
    short: "Styles",
    href: "/studio/styles",
    icon: Palette,
    ready: true,
  },
  {
    // canvas: ph-lightning
    key: "subscription",
    label: "Plan and credits",
    short: "Plan",
    href: "/billing",
    icon: Zap,
    ready: true,
    owner: "B03",
  },
  {
    // canvas: ph-sliders
    key: "settings",
    label: "Settings",
    short: "Setup",
    href: "/settings",
    icon: SlidersHorizontal,
    ready: true,
  },
  {
    // canvas: ph-hand-waving
    key: "onboarding",
    label: "First run",
    short: "Intro",
    href: "/onboarding",
    icon: HandHeart,
    ready: true,
  },
];

/**
 * Shipped destinations the canvas's rail has no room for.
 *
 * The expanded sidebar lists them under a "More" heading, below the primary
 * group and above the credits card; the rail omits them, which is what makes
 * the rail match the canvas. Nothing here is second-class — Academy, Plugins,
 * Team, Refer & Earn and Help are all live pages — they are simply not part of
 * the eight the design chose to put one click away.
 */
export const SECONDARY_NAV: readonly NavItem[] = [
  {
    key: "templates",
    label: "Templates",
    short: "Templates",
    href: "/templates",
    icon: LayoutTemplate,
    ready: false,
    owner: "A16",
  },
  {
    key: "academy",
    label: "Academy",
    short: "Academy",
    href: "/academy",
    icon: GraduationCap,
    ready: true,
  },
  {
    key: "plugins",
    label: "Plugins",
    short: "Plugins",
    href: "/plugins",
    icon: Plug,
    ready: true,
    owner: "C11",
  },
  { key: "team", label: "Team", short: "Team", href: "/team", icon: Users, ready: true },
  {
    key: "affiliate",
    label: "Refer & Earn",
    short: "Refer",
    href: "/affiliate",
    // B07 shipped: `/affiliate` renders stats and the programme rules, so the
    // row no longer says "Soon" over a page that works (F07-E9).
    icon: Gift,
    ready: true,
    owner: "B07",
  },
  { key: "help", label: "Help", short: "Help", href: "/help", icon: LifeBuoy, ready: true },
];

/** Every navigable item, primary group first. */
export const ALL_NAV: readonly NavItem[] = [...PRIMARY_NAV, ...SECONDARY_NAV];

/** Settings sections (08 §Settings, minus API keys which belongs to B14). */
export interface SettingsSection {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly description: string;
}

export const SETTINGS_NAV: readonly SettingsSection[] = [
  {
    key: "profile",
    label: "Profile",
    href: "/settings/profile",
    description: "Your name, email and how you sign in.",
  },
  {
    key: "languages",
    label: "Languages & defaults",
    href: "/settings/languages",
    description: "What we assume when you start a project.",
  },
  {
    key: "memory",
    label: `What ${BRAND.name} learned`,
    href: "/settings/memory",
    description: "Spellings, glossary and style preferences we remember for you.",
  },
  {
    key: "devices",
    label: "Devices & sessions",
    href: "/settings/devices",
    description: "Everywhere you are signed in.",
  },
  {
    key: "privacy",
    label: "Privacy",
    href: "/settings/privacy",
    description: "Consents, exporting your data and deleting your account.",
  },
  {
    key: "notifications",
    label: "Notifications",
    href: "/settings/notifications",
    description: "What we email you about.",
  },
  {
    key: "support",
    label: "Support",
    href: "/settings/support",
    description: "File a ticket and track its status.",
  },
  {
    key: "subscription",
    label: "Subscription",
    href: "/settings/subscription",
    description: "Your plan, passes and top-ups.",
  },
  {
    key: "plugin-keys",
    label: "Licence keys",
    href: "/plugins/keys",
    description: "Offline activation for plugins and the desktop app.",
  },
  {
    // B14: added additively — this file is outside B14's stated boundary
    // (`apps/web/app/(app)/settings/developers/**`), but the Developers
    // settings page is unreachable from the sidebar without a nav entry.
    // Flagged as a deviation in the WP's final report.
    key: "developers",
    label: "Developers",
    href: "/settings/developers",
    description: "API keys and webhooks.",
  },
];

/** `/billing/*` sub-navigation (08 §Subscription). */
export const BILLING_NAV: readonly SettingsSection[] = [
  { key: "overview", label: "Overview", href: "/billing", description: "Your plan and credits." },
  {
    key: "plans",
    label: "Plans",
    href: "/billing/plans",
    description: "Compare and change plans.",
  },
  {
    key: "methods",
    label: "Payment methods",
    href: "/billing/methods",
    description: "Cards, UPI and mandates.",
  },
  {
    key: "invoices",
    label: "Invoices",
    href: "/billing/invoices",
    description: "GST invoices and credit notes.",
  },
  {
    key: "usage",
    label: "Usage",
    href: "/billing/usage",
    description: "Credit ledger and CSV export.",
  },
];

/** True when `pathname` is inside `href`. `/` only matches itself. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
