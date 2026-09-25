"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { Button, cn, PageHeader } from "@montaj/ui";

import { clearAdminSession, readAdminSession, type AdminSession } from "@/lib/admin/admin-session";

/**
 * Grouped by what an operator is doing, not by the order the panels were
 * built in: fifteen flat links is a list to read, four labelled groups is one
 * to scan (HIG sidebars › Best practices: "use succinct, descriptive labels
 * to title each group"). Two levels, never three.
 */
const NAV_GROUPS = [
  {
    label: "Overview",
    items: [{ href: "/admin", label: "Dashboard" }],
  },
  {
    label: "People",
    items: [
      { href: "/admin/users", label: "Users" },
      { href: "/admin/workspaces", label: "Workspaces" },
      { href: "/admin/support", label: "Support" },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/admin/credits", label: "Credits" },
      { href: "/admin/billing/refunds", label: "Refunds" },
      { href: "/admin/affiliates", label: "Affiliates" },
      { href: "/admin/referrals", label: "Referral review" },
    ],
  },
  {
    label: "Content",
    items: [
      { href: "/admin/styles", label: "Styles" },
      { href: "/admin/share-reports", label: "Share reports" },
      { href: "/admin/partner-catalogue", label: "Partner catalogue" },
    ],
  },
  {
    label: "Platform",
    items: [
      { href: "/admin/jobs", label: "Jobs" },
      { href: "/admin/flags", label: "Flags" },
      { href: "/admin/routing", label: "Routing weights" },
      { href: "/admin/evals", label: "Evals" },
    ],
  },
] as const;

function isUnderAdmin(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/** `/admin` is active only on itself; every other row also owns its detail pages. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * No product chrome (B13 scope §3): a separate, minimal shell. Client-side
 * only — the admin session lives in `sessionStorage` (`admin-session.ts`),
 * so this cannot be server-rendered with the session already known; a
 * visitor with no valid step-up sees the gate below instead of the panel,
 * and every panel's own data fetch is the real access check (`AdminGuard`
 * on the API side) regardless of what this shell shows.
 */
export function AdminShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = React.useState<AdminSession | null | undefined>(undefined);

  React.useEffect(() => {
    setSession(readAdminSession());
  }, [pathname]);

  // `(admin)/ui-kit/**` shares this layout only because it shares the route
  // group; it is served from `/ui-kit`, outside middleware's `/admin` gate,
  // and carries no admin data (see middleware.ts). It is its own page with
  // its own `<main>`, so it gets neither the step-up gate nor the console.
  if (!isUnderAdmin(pathname)) return <>{children}</>;

  if (session === undefined) {
    return (
      <div className="min-h-dvh bg-bg-0 p-6">
        <p role="status" className="text-sm text-fg-2">
          Loading…
        </p>
      </div>
    );
  }

  // Step-up itself needs no console around it: without a session every
  // link in the nav would only lead back to the gate.
  if (session === null && pathname === "/admin/step-up") {
    return <main className="min-h-dvh bg-bg-0 text-fg-0">{children}</main>;
  }

  if (session === null) {
    return (
      <main className="flex min-h-dvh flex-col justify-center bg-bg-0 px-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6">
          <PageHeader
            eyebrow="Admin console"
            title="Step up to continue"
            description="This session has no active admin step-up, or it expired. Admin sessions last 30 minutes."
          />
          <div>
            <Button asChild variant="primary">
              <Link href="/admin/step-up">Step up</Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg-0 text-fg-0 md:flex-row">
      <nav
        aria-label="Admin console"
        className="shrink-0 border-b border-border bg-sunken md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:flex-col md:border-r md:border-b-0"
      >
        <p className="px-4 pt-4 text-xs font-medium tracking-[0.08em] text-fg-2 uppercase md:px-5 md:pt-5">
          Admin console
        </p>
        <div className="flex gap-4 overflow-x-auto px-2 py-2 md:flex-1 md:flex-col md:gap-5 md:overflow-y-auto md:px-3 md:py-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex shrink-0 flex-col gap-1">
              <p className="hidden px-2 text-2xs font-medium text-fg-2 md:block">{group.label}</p>
              <ul className="flex gap-1 md:flex-col">
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-8 items-center rounded-sm px-2 text-sm whitespace-nowrap no-underline transition-colors",
                          active
                            ? "bg-accent/14 font-medium text-accent-200"
                            : "text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 md:flex-col md:items-start md:px-5 md:py-4">
          <p className="text-xs text-fg-2">
            Roles: <span className="text-fg-1">{session.adminRoles.join(", ")}</span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="md:-ml-2"
            onClick={() => {
              clearAdminSession();
              void fetch("/api/admin-hint", { method: "DELETE" }).catch(() => undefined);
              router.push("/admin/step-up");
            }}
          >
            End admin session
          </Button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:py-8">{children}</main>
    </div>
  );
}
