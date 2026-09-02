import {
  CreditCard,
  Folder,
  Gift,
  GraduationCap,
  Home,
  LifeBuoy,
  LayoutTemplate,
  Plug,
} from "lucide-react";

import type { LucideIcon } from "lucide-react";

/**
 * The sidebar of 08 §3, in order.
 *
 * `ready` says whether the destination exists yet. An item that is not ready
 * renders as a disabled row with a "Soon" chip rather than a link to a 404 —
 * the shell ships before most of the pages it points at, and a dead link is a
 * worse first impression than an honest one. The owning work package flips the
 * flag when its route lands.
 */

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly ready: boolean;
  /** The work package that builds the destination, shown in the tooltip. */
  readonly owner?: string;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { key: "home", label: "Home", href: "/", icon: Home, ready: true },
  {
    key: "projects",
    label: "Projects",
    href: "/projects",
    icon: Folder,
    ready: false,
    owner: "A14",
  },
  {
    key: "templates",
    label: "Templates",
    href: "/templates",
    icon: LayoutTemplate,
    ready: false,
    owner: "A16",
  },
  {
    key: "academy",
    label: "Academy",
    href: "/academy",
    icon: GraduationCap,
    ready: false,
    owner: "B12",
  },
  { key: "plugins", label: "Plugins", href: "/plugins", icon: Plug, ready: false, owner: "A24" },
  {
    key: "subscription",
    label: "Subscription",
    href: "/billing",
    icon: CreditCard,
    ready: true,
    owner: "B03",
  },
  {
    key: "affiliate",
    label: "Refer & Earn",
    href: "/affiliate",
    icon: Gift,
    ready: false,
    owner: "B07",
  },
  { key: "help", label: "Help", href: "/help", icon: LifeBuoy, ready: false, owner: "B12" },
];

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
    label: "What Aksharo learned",
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
