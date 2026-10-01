"use client";

/**
 * "You are running low on credits" (2026-10-01, OpusClip's low-credits card):
 * a small card in the corner once the balance falls under
 * {@link LOW_CREDITS_SHARE} of the monthly grant, so a workspace is told before
 * a run is refused for credits rather than by the refusal.
 *
 * It says how much is left in minutes of video (08 §6: never "credits" without
 * the minutes nearby) and when the grant comes back, and links to the balance.
 * Not now hides it until the grant next resets, in this browser. It never shows
 * on Billing itself, or for a workspace with no monthly grant (nothing to be
 * a share of; CLAUDE.md §4b calls that a symptom, not a state to draw).
 */
import { Coins, X } from "lucide-react";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { useWorkspaceCredits, useWorkspaceId } from "@montaj/api-client";
import { Button, formatResetDate } from "@montaj/ui";

import { formatCreditHours } from "./credits-card";

/** The card shows below this share of the monthly grant. */
export const LOW_CREDITS_SHARE = 0.15;

const DISMISS_KEY = "aksharo.low-credits.dismissed";

/** Whether a balance is low enough to say so. */
export function isLowOnCredits(balanceTenths: number, grantTenths: number): boolean {
  return grantTenths > 0 && balanceTenths < grantTenths * LOW_CREDITS_SHARE;
}

function dismissedFor(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function LowCreditsNudge(): React.JSX.Element | null {
  const credits = useWorkspaceCredits();
  const workspaceId = useWorkspaceId();
  const pathname = usePathname();
  // One dismissal per workspace per grant period: next month's low balance is news again.
  const period = `${workspaceId ?? "none"}:${credits.data?.grantResetAt ?? "never"}`;
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDismissed(dismissedFor());
  }, []);

  const data = credits.data;
  if (data === undefined || dismissed === period) return null;
  if (pathname?.startsWith("/billing") === true) return null;
  if (!isLowOnCredits(data.balanceTenths, data.monthlyGrantTenths)) return null;

  const dismiss = (): void => {
    try {
      window.localStorage.setItem(DISMISS_KEY, period);
    } catch {
      // Storage off: hidden for this visit.
    }
    setDismissed(period);
  };
  const left = Math.max(0, Math.floor(data.balanceTenths / 10));
  const resets = formatResetDate(data.grantResetAt ?? undefined);
  return (
    <aside
      aria-label="Credits running low"
      className="fixed right-4 bottom-4 z-40 w-[min(340px,calc(100vw-32px))] rounded-md border border-border bg-bg-2 p-4 shadow-lg"
      data-testid="low-credits-nudge"
    >
      <div className="flex items-start gap-3">
        <Coins
          className="mt-0.5 size-5 shrink-0 text-warning"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-medium text-fg-0">You are running low on credits</p>
          <p className="m-0 mt-1 text-xs text-fg-1">
            {left === 1 ? "1 credit" : `${String(left)} credits`} left: about{" "}
            {formatCreditHours(data.balanceTenths)} of video to find clips in.
            {resets === undefined ? "" : ` Your monthly credits come back ${resets}.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" asChild>
              <NextLink href="/billing" className="no-underline" data-testid="low-credits-see">
                See your credits
              </NextLink>
            </Button>
            <Button variant="ghost" size="sm" onClick={dismiss} data-testid="low-credits-dismiss">
              Not now
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-sm text-fg-2 hover:text-fg-0"
          onClick={dismiss}
        >
          <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
