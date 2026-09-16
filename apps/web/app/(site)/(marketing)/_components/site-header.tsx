"use client";

/**
 * The marketing site's own header: brand wordmark, primary nav, sign-in and the
 * "Start free" CTA.
 *
 * Deliberately not shared with `(app)`'s sidebar shell (`apps/web/components/
 * shell`, A13) or with the auth pages that sit alongside this route group
 * (`(site)/login`, `/signup`, …) — those keep their own minimal chrome, and
 * this header only wraps the nested `(marketing)` group.
 *
 * `data-testid="home-heading"` on the wordmark, not the hero `<h1>`: A13's
 * `apps/web/e2e/smoke.spec.ts` asserts `getByTestId("home-heading")` reads
 * exactly the brand name, so the hero's actual headline copy carries a
 * different test id (`hero-headline`) and this link is what satisfies that
 * assertion (present on every marketing page, since the header is shared).
 */

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { BRAND } from "@montaj/config";
import { Button } from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";
import { BrandMark } from "@/components/shell/brand-mark";
import { AUTH_NAV, PRIMARY_NAV, visibleNav } from "@/content/site/nav";
import { cn } from "@/lib/utils";

export function SiteHeader(): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Plugins and Download lead to products that are not in this release; the
  // nav drops them unless their surface flag says otherwise (P0-12).
  const nav = visibleNav(PRIMARY_NAV, useRuntimeConfig().flags);

  return (
    <header className="bg-bg-0/95 rule-fade-b sticky top-0 z-40 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          data-testid="home-heading"
          className="font-display text-fg-0 flex items-center gap-2.5 rounded-sm text-lg font-medium tracking-tight"
        >
          <BrandMark size={28} />
          {BRAND.name}
        </Link>

        <nav
          className="hidden items-center gap-6 md:flex"
          aria-label="Primary"
          data-testid="site-nav"
        >
          {nav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "text-sm font-medium transition-colors",
                  active ? "text-fg-0" : "text-fg-2 hover:text-fg-0",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Button variant="ghost" size="sm" asChild>
            <Link href={AUTH_NAV.signIn.href}>{AUTH_NAV.signIn.label}</Link>
          </Button>
          <Button variant="primary" size="sm" asChild>
            <Link href={AUTH_NAV.getStarted.href}>{AUTH_NAV.getStarted.label}</Link>
          </Button>
        </div>

        <button
          type="button"
          className="text-fg-1 -mr-2 inline-flex size-10 items-center justify-center rounded-sm md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </div>

      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Primary"
          className="border-border flex flex-col gap-1 border-t px-4 py-3 md:hidden"
        >
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-fg-1 hover:text-fg-0 rounded-sm px-2 py-2 text-sm font-medium"
              onClick={() => {
                setOpen(false);
              }}
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-2 flex gap-2">
            <Button variant="outline" size="sm" asChild className="flex-1">
              <Link href={AUTH_NAV.signIn.href}>{AUTH_NAV.signIn.label}</Link>
            </Button>
            <Button variant="primary" size="sm" asChild className="flex-1">
              <Link href={AUTH_NAV.getStarted.href}>{AUTH_NAV.getStarted.label}</Link>
            </Button>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
