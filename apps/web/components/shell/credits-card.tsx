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
 * The sidebar's credit block, as the canvas draws it: an accent kicker with
 * the balance on the right, a 3 px meter, and one plain sentence saying what
 * the balance means in minutes and when it refills.
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
      className={cn("bg-surface flex flex-col gap-[7px] rounded-sm px-3 py-[11px]", className)}
      data-testid="credits-card"
    >
      <span className="text-accent flex items-center justify-between text-[10px] tracking-[0.1em] uppercase">
        Credits
        <span
          className="text-neutral-400 text-[11px] tracking-normal normal-case tabular-nums"
          data-testid="credits-card-balance"
        >
          {grant > 0 ? `${Math.round(balance / 10)} / ${Math.round(grant / 10)}` : "—"}
        </span>
      </span>

      {pct === null ? null : (
        <span className="bg-neutral-800 block h-[3px] overflow-hidden rounded-full">
          <span className="bg-accent block h-full" style={{ width: `${pct}%` }} />
        </span>
      )}

      <span className="text-neutral-500 text-[11px]">
        {formatCreditHours(balance)} of transcription.
        {resets === undefined ? "" : ` Resets ${resets}.`}
      </span>
    </div>
  );
}
