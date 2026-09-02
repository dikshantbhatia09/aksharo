"use client";

import { Flame, Zap } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/cn";
import { ProgressBar } from "../primitives/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/tooltip";

/**
 * Credits are stored as integer tenths (CONTRACTS §0). One credit is one minute
 * of transcription at the base rate, and 08 §6 forbids saying "credits" without
 * the minute equivalence nearby — so the meter always shows both.
 */
export interface CreditMeterProps {
  /** Remaining balance, in tenths of a credit. */
  remainingTenths: number;
  /** Allowance for the period, in tenths. `0` means "no included allowance". */
  includedTenths: number;
  /** ISO-8601 date the allowance resets. */
  resetsAt?: string;
  /** Tenths spent per day over the trailing week, for the burn-rate tooltip. */
  burnRateTenthsPerDay?: number;
  /** Consecutive active days. Rendered only when `showStreak` is on. */
  streakDays?: number;
  /**
   * The streak badge is an experiment (B06) and is off for declared minors
   * (D60), so it stays behind a flag the shell passes in.
   */
  showStreak?: boolean;
  /** Rendered as a button when given — the sidebar links it to Subscription. */
  onTopUp?: () => void;
  className?: string;
}

/** Tenths → a human string. 205 tenths is "20.5", 200 tenths is "20". */
export function formatCredits(tenths: number): string {
  const value = tenths / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** One credit is one minute at the base burn rate (`packages/config/credits`). */
export function formatMinutes(tenths: number): string {
  return `${formatCredits(tenths)} min`;
}

/** "3 May" — short, unambiguous and locale-independent enough for a meter. */
export function formatResetDate(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

/** Days until the balance is gone at the trailing burn rate, or `undefined`. */
export function daysOfRunway(
  remainingTenths: number,
  burnRateTenthsPerDay: number | undefined,
): number | undefined {
  if (burnRateTenthsPerDay === undefined || burnRateTenthsPerDay <= 0) return undefined;
  return Math.floor(remainingTenths / burnRateTenthsPerDay);
}

export function CreditMeter({
  remainingTenths,
  includedTenths,
  resetsAt,
  burnRateTenthsPerDay,
  streakDays,
  showStreak = false,
  onTopUp,
  className,
}: CreditMeterProps): React.JSX.Element {
  const percent = includedTenths > 0 ? (remainingTenths / includedTenths) * 100 : 0;
  const tone = percent <= 10 ? "rejected" : percent <= 25 ? "warning" : "accent";
  const reset = formatResetDate(resetsAt);
  const runway = daysOfRunway(remainingTenths, burnRateTenthsPerDay);

  const body = (
    <div className={cn("flex flex-col gap-2", className)} data-testid="credit-meter">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-2 flex items-center gap-1.5 text-2xs font-medium tracking-wide uppercase">
          <Zap className="size-3.5" aria-hidden="true" />
          Credits
        </span>
        {showStreak && streakDays !== undefined && streakDays > 0 ? (
          <span
            className="text-proposed flex items-center gap-1 text-2xs font-medium"
            data-testid="credit-meter-streak"
          >
            <Flame className="size-3.5" aria-hidden="true" />
            {streakDays}-day streak
          </span>
        ) : null}
      </div>

      <p className="text-fg-0 text-sm font-medium" data-testid="credit-meter-balance">
        {formatCredits(remainingTenths)} left
        <span className="text-fg-2 font-normal"> · {formatMinutes(remainingTenths)}</span>
      </p>

      <ProgressBar
        value={percent}
        tone={tone}
        label={`${formatCredits(remainingTenths)} of ${formatCredits(includedTenths)} credits left`}
      />

      <p className="text-fg-2 text-2xs" data-testid="credit-meter-reset">
        {reset === undefined ? "No reset scheduled" : `Resets ${reset}`}
      </p>

      {onTopUp === undefined ? null : (
        <button
          type="button"
          onClick={onTopUp}
          className="text-lime-500 self-start rounded-sm text-2xs font-medium hover:underline"
        >
          Top up
        </button>
      )}
    </div>
  );

  if (burnRateTenthsPerDay === undefined) return body;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} aria-describedby="credit-meter-burn">
          {body}
        </div>
      </TooltipTrigger>
      <TooltipContent id="credit-meter-burn" side="right">
        <p className="font-medium">
          You are using about {formatCredits(burnRateTenthsPerDay)} credits a day
        </p>
        <p className="text-fg-2 mt-1">
          {runway === undefined
            ? "Not enough history to estimate how long this lasts."
            : `At that rate this balance lasts about ${String(runway)} more day${runway === 1 ? "" : "s"}.`}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
