"use client";

/**
 * "This month" — the canvas's credit card on the studio.
 *
 * A 34 px figure with the allowance beside it, the meter, one sentence of
 * what the balance buys, then Top up and Usage.
 *
 * The canvas's sentence is "About 5h 42m of transcription, or 41 more Reels at
 * the length you usually post." The second clause needs a per-workspace median
 * clip length, which nothing computes and no endpoint returns, so it is not
 * written here: a made-up 41 on a real credit balance is worse than a shorter
 * sentence. The hours figure is real — one credit is one minute of
 * transcription at the base rate (`packages/config/src/credits.ts`).
 */
import Link from "next/link";
import * as React from "react";

import { useEntitlement, useWorkspaceCredits } from "@montaj/api-client";
import { Button, cn } from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";
import { formatCreditHours } from "@/components/shell/credits-card";

export function ThisMonthCard({ className }: { className?: string }): React.JSX.Element {
  const entitlement = useEntitlement();
  const credits = useWorkspaceCredits();
  const { razorpayEnabled } = useRuntimeConfig();

  const allowance = entitlement.data?.creditsPerMonthTenths ?? 0;
  const balance = credits.data?.balanceTenths ?? allowance;
  const grant = credits.data?.monthlyGrantTenths ?? allowance;
  const pct = grant > 0 ? Math.min(100, Math.max(0, (balance / grant) * 100)) : null;

  return (
    <section
      className={cn("bg-surface flex flex-col gap-[11px] rounded-lg px-4 py-3.5", className)}
      data-testid="this-month"
      aria-labelledby="this-month-heading"
    >
      <h2
        id="this-month-heading"
        className="text-neutral-500 text-[10px] tracking-[0.12em] uppercase"
      >
        This month
      </h2>

      <div className="flex items-end gap-[7px]">
        <span
          className="font-display text-[34px] leading-none tracking-[-0.02em] tabular-nums"
          data-testid="this-month-balance"
        >
          {Math.round(balance / 10)}
        </span>
        <span className="text-neutral-400 pb-1 text-xs">
          {grant > 0 ? `credits left of ${String(Math.round(grant / 10))}` : "credits left"}
        </span>
      </div>

      {pct === null ? null : (
        <span className="bg-neutral-800 block h-[3px] overflow-hidden rounded-full">
          <span className="bg-accent block h-full" style={{ width: `${String(pct)}%` }} />
        </span>
      )}

      <p className="text-neutral-400 m-0 text-xs">
        About {formatCreditHours(balance)} of transcription.
      </p>

      <div className="mt-auto flex gap-2">
        {razorpayEnabled ? (
          <Button variant="primary" size="sm" asChild data-testid="this-month-topup">
            <Link href="/billing/plans">Top up</Link>
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" asChild>
          <Link href="/billing/usage">Usage</Link>
        </Button>
      </div>
    </section>
  );
}
