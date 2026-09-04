"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@montaj/ui";

import type { ReactNode } from "react";

import { useRuntimeConfig } from "@/components/providers";
import { BILLING_NAV } from "@/lib/nav";

/**
 * Tabs that only mean something with a payment rail behind them (F07-C1).
 * `nav.ts` is a plain data module and cannot read the runtime config, so the
 * filter lives here, where the tabs are actually rendered.
 */
const RAIL_ONLY_TABS: readonly string[] = ["plans", "methods", "invoices"];

/**
 * `/billing/*` — Overview, Plans, Payment methods, Invoices, Usage (08
 * §Subscription). Same two-column shape `settings/layout.tsx` uses, with its
 * own navigation landmark so a screen reader tells this apart from the main
 * sidebar (08 §6).
 *
 * `isActive` is written locally rather than reusing `lib/nav.ts`'s
 * `isActivePath`: that helper's prefix match treats every `/billing/*` path
 * as "inside" `/billing`, which is exactly right for the sidebar's single
 * "Subscription" entry but would light up "Overview" on every sub-tab here —
 * `/billing` needs the same exact-match special case `isActivePath` already
 * gives `/`.
 */
export default function BillingLayout({ children }: { children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const { razorpayEnabled } = useRuntimeConfig();
  const sections = BILLING_NAV.filter(
    (tab) => razorpayEnabled || !RAIL_ONLY_TABS.includes(tab.key),
  );

  const isActive = (href: string): boolean =>
    href === "/billing" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 lg:flex-row lg:gap-10">
      <nav aria-label="Subscription" className="lg:w-56 lg:shrink-0">
        <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {sections.map((section) => {
            const active = isActive(section.href);
            return (
              <li key={section.key}>
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  data-testid={`billing-nav-${section.key}`}
                  className={cn(
                    "block rounded-sm px-3 py-2 text-sm whitespace-nowrap",
                    active ? "bg-bg-2 text-lime-500" : "text-fg-1 hover:bg-bg-2 hover:text-fg-0",
                  )}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
