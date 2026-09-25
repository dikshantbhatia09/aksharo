"use client";

import { useEntitlement, useWorkspaceCredits } from "@montaj/api-client";
import { cn, formatResetDate } from "@montaj/ui";

import type * as React from "react";

/**
 * Tenths of a credit → "5h 42m".
 *
 * One credit is one minute of transcription at the base rate
 * (`packages/config/src/credits.ts`), which is what lets a credit balance be
 * stated as time at all. 08 §6 forbids saying "credits" without the minute
 * equivalence nearby, and the canvas's card says both — "342 / 500" over
 * "5h 42m of transcription".
 */
export function formatCreditHours(tenths: number): string {
  const minutes = Math.max(0, Math.round(tenths / 10));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${rest.toString().padStart(2, "0")}m`;
}

/**
 * The sidebar's credit block: a quiet label with the balance on the right, a
 * 4 px meter, and one plain sentence saying what the balance means in minutes
 * and when it refills. The filled meter is the only accent here (DESIGN.md's
 * budget allows "a filled meter"); the label used to be an accent kicker too,
 * which made the card read as a second active nav row.
 *
 * Every number is real. The monthly grant and the reset date come from the
 * credit account (`GET /workspaces/{id}/credits`); the plan's allowance is the
 * entitlement's, and is only used as the denominator when the account has not
 * loaded yet. A workspace with no grant at all gets no bar rather than a
 * divide-by-zero — see the launch-readiness note in CLAUDE.md §4b: a fresh
 * account with zero credits is a symptom to investigate, not a state to draw.
 */
export function CreditsCard({ className }: { className?: string }): React.JSX.Element {
  const entitlement = useEntitlement();
  const credits = useWorkspaceCredits();

  const allowance = entitlement.data?.creditsPerMonthTenths ?? 0;
  const balance = credits.data?.balanceTenths ?? allowance;
  const grant = credits.data?.monthlyGrantTenths ?? allowance;
  const resets = formatResetDate(credits.data?.grantResetAt ?? undefined);
  const pct = grant > 0 ? Math.min(100, Math.max(0, (balance / grant) * 100)) : null;

  return (
    <div
      className={cn(
        "border-border bg-surface flex flex-col gap-2 rounded-md border px-3 py-3",
        className,
      )}
      data-testid="credits-card"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-fg-2 text-2xs font-medium tracking-[0.08em] uppercase">Credits</span>
        <span className="text-fg-0 text-xs font-medium tabular-nums" data-testid="credits-card-balance">
          {
            // A workspace can carry an admin "adjustment" lot on top of its
            // monthly grant, and `balance` sums every lot -- so once one of
            // those exists the balance can exceed the grant, and "N / grant"
            // reads as a broken/overflowing counter the moment N > grant.
            // Same fix as `this-month-card.tsx` and the billing overview:
            // drop the denominator rather than let the balance appear to lie.
            grant <= 0
              ? "—"
              : balance <= grant
                ? `${Math.round(balance / 10)} / ${Math.round(grant / 10)}`
                : `${Math.round(balance / 10)}`
          }
        </span>
      </span>

      {pct === null ? null : (
        <span aria-hidden="true" className="bg-bg-2 block h-1 overflow-hidden rounded-full">
          <span className="bg-accent block h-full" style={{ width: `${pct}%` }} />
        </span>
      )}

      <span className="text-fg-2 text-2xs">
        {formatCreditHours(balance)} of transcription.
        {resets === undefined ? "" : ` Resets ${resets}.`}
      </span>
    </div>
  );
}
