"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn, PageHeader } from "@montaj/ui";

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
    <div className="flex w-full flex-col gap-8">
      {/*
        The page title lives here, once, above the section list: every
        `/billing/*` tab is a view of the same "Subscription" page, so the
        shirorekha stays put while the tab changes underneath it.
      */}
      <PageHeader
        title="Subscription"
        description={
          razorpayEnabled
            ? "Your plan, your credits, and what they were spent on."
            : "Your credits and what they were spent on."
        }
      />
      <div className="grid w-full grid-cols-1 gap-5 lg:grid-cols-[minmax(0,196px)_minmax(0,1fr)]">
        <nav aria-label="Subscription">
          <ul className="flex gap-0.5 overflow-x-auto lg:flex-col lg:overflow-visible">
            {sections.map((section) => {
              const active = isActive(section.href);
              return (
                <li key={section.key}>
                  <Link
                    href={section.href}
                    aria-current={active ? "page" : undefined}
                    data-testid={`billing-nav-${section.key}`}
                    className={cn(
                      // `no-underline`: the base stylesheet underlines any <a>
                      // inside an <li> for WCAG 1.4.1, which is right for a link
                      // in a sentence and wrong for a section list.
                      "flex min-h-9 items-center rounded-sm px-3 py-2 text-sm whitespace-nowrap no-underline",
                      "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
                      active
                        ? "bg-accent/14 text-accent-200 font-medium"
                        : "text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
                    )}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
