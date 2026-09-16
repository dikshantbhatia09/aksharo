"use client";

/**
 * "What N credits buys" — the third card in the canvas's billing band.
 *
 * One credit is one minute of transcription at the base rate
 * (`packages/config/src/credits.ts`), and everything here is that one fact
 * divided three ways. Each row's label carries its own assumption — "Reels at
 * 40 seconds", "Podcast episodes at 45 minutes" — because a bare "60" against
 * "Reels" would be a number with a hidden denominator, and the reader cannot
 * check a denominator they cannot see.
 */
import * as React from "react";

import { cn } from "@montaj/ui";

const REEL_SECONDS = 40;
const EPISODE_MINUTES = 45;

export function CreditsBuyCard({
  /** The plan's monthly allowance, in tenths of a credit. */
  grantTenths,
  className,
}: {
  grantTenths: number;
  className?: string;
}): React.JSX.Element {
  const minutes = grantTenths / 10;
  const hours = minutes / 60;

  const rows: readonly { label: string; value: string }[] = [
    {
      label: "Transcription",
      value: hours >= 1 ? `${(Math.round(hours * 10) / 10).toString()} hours` : `${String(Math.round(minutes))} min`,
    },
    {
      label: `Reels at ${String(REEL_SECONDS)} seconds`,
      value: String(Math.floor((minutes * 60) / REEL_SECONDS)),
    },
    {
      label: `Podcast episodes at ${String(EPISODE_MINUTES)} minutes`,
      value: String(Math.floor(minutes / EPISODE_MINUTES)),
    },
  ];

  return (
    <div
      className={cn("bg-surface flex flex-col gap-[9px] rounded-md p-[18px]", className)}
      data-testid="credits-buy-card"
    >
      <span className="text-neutral-500 text-[10px] tracking-[0.12em] uppercase">
        What {String(Math.round(minutes))} credits buys
      </span>
      {rows.map((row) => (
        <span
          key={row.label}
          className="text-neutral-300 flex items-baseline gap-[9px] text-[12.5px]"
        >
          {row.label}
          <span className="text-fg-0 ml-auto font-mono text-xs">{row.value}</span>
        </span>
      ))}
      <p className="text-neutral-500 m-0 mt-1 text-[11px]">
        One credit is one minute of transcription at the base rate.
      </p>
    </div>
  );
}
