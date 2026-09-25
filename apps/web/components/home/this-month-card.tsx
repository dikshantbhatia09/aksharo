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
      className={cn("border-border bg-surface flex flex-col gap-3 rounded-md border p-5", className)}
      data-testid="this-month"
      aria-labelledby="this-month-heading"
    >
      <h2 id="this-month-heading" className="text-fg-1 text-sm font-semibold">
        Credits this month
      </h2>

      <div className="flex items-end gap-2">
        <span
          className="font-display text-fg-0 text-4xl leading-none font-semibold tabular-nums [font-stretch:92%]"
          data-testid="this-month-balance"
        >
          {Math.round(balance / 10)}
        </span>
        <span className="text-fg-2 pb-1 text-sm">
          {
            // A workspace can carry an admin "adjustment" lot on top of its
            // monthly grant (Subscription -> Usage shows these as separate
            // "Grant" and "Adjust" lots). `balance` sums every lot, so once one
            // of those exists the balance can exceed the grant -- and "N left
            // of {grant}" reads as a broken counter the moment N > grant. Drop
            // the denominator rather than let the balance appear to be lying.
            grant > 0 && balance <= grant
              ? `credits left of ${String(Math.round(grant / 10))}`
              : "credits left"
          }
        </span>
      </div>

      {pct === null ? null : (
        <span
          role="meter"
          aria-label="Credits left this month"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          className="bg-bg-2 block h-1 overflow-hidden rounded-full"
        >
          <span className="bg-accent block h-full" style={{ width: `${String(pct)}%` }} />
        </span>
      )}

      <p className="text-fg-2 m-0 text-sm">
        About {formatCreditHours(balance)} of transcription.
      </p>

      {/*
        Both secondary: Home spends its one filled button on the upload flow,
        and topping up is a supporting task here, not the page's job.
      */}
      <div className="mt-auto flex flex-wrap gap-2">
        {razorpayEnabled ? (
          <Button variant="secondary" size="sm" asChild data-testid="this-month-topup">
            <Link href="/billing/plans">Top up credits</Link>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" asChild>
          <Link href="/billing/usage">See usage</Link>
        </Button>
      </div>
    </section>
  );
}
