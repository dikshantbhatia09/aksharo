"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { clearAdminSession, readAdminSession, type AdminSession } from "@/lib/admin/admin-session";

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/workspaces", label: "Workspaces" },
  { href: "/admin/credits", label: "Credits" },
  { href: "/admin/billing/refunds", label: "Refunds" },
  { href: "/admin/flags", label: "Flags" },
  { href: "/admin/routing", label: "Routing weights" },
  { href: "/admin/styles", label: "Styles" },
  { href: "/admin/affiliates", label: "Affiliates" },
  { href: "/admin/referrals", label: "Referral review" },
  { href: "/admin/share-reports", label: "Share reports" },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/support", label: "Support" },
] as const;

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

  if (session === undefined) return <div className="p-6 text-sm text-neutral-400">Loading…</div>;

  if (session === null && pathname !== "/admin/step-up") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
        <h1 className="text-xl font-semibold text-neutral-100">Admin step-up required</h1>
        <p className="text-sm text-neutral-400">
          This session has no active admin step-up, or it expired (30 minutes, CONTRACTS §5).
        </p>
        <Link
          href="/admin/step-up"
          className="rounded bg-neutral-100 px-4 py-2 text-center text-sm font-medium text-neutral-900"
        >
          Step up
        </Link>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh bg-neutral-950 text-neutral-100">
      <nav className="w-56 shrink-0 border-r border-neutral-800 p-4">
        <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Admin console
        </p>
        <ul className="flex flex-col gap-1">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`block rounded px-2 py-1.5 text-sm ${
                  pathname === item.href
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        {session !== null && (
          <div className="mt-6 border-t border-neutral-800 pt-4">
            <p className="text-xs text-neutral-500">Roles: {session.adminRoles.join(", ")}</p>
            <button
              type="button"
              onClick={() => {
                clearAdminSession();
                void fetch("/api/admin-hint", { method: "DELETE" }).catch(() => undefined);
                router.push("/admin/step-up");
              }}
              className="mt-2 text-xs text-neutral-500 underline hover:text-neutral-300"
            >
              End admin session
            </button>
          </div>
        )}
      </nav>
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
