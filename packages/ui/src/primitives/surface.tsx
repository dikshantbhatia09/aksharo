"use client";

import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

import type { VariantProps } from "class-variance-authority";

/** Elevation is a 1 px border plus a soft shadow, never a heavy blur (08 §1). */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cn("bg-bg-1 border-border rounded-md border p-5", className)} {...props} />
  );
}

export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border bg-bg-2 text-fg-1",
        accent: "border-accent/40 bg-accent/10 text-accent-300",
        proposed: "border-proposed/40 bg-proposed/10 text-proposed",
        accepted: "border-accepted/40 bg-accepted/10 text-accepted",
        rejected: "border-rejected/40 bg-rejected/10 text-rejected",
        info: "border-info/40 bg-info/10 text-info",
        warning: "border-warning/40 bg-warning/10 text-warning",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn("bg-bg-2 animate-pulse rounded-sm", className)}
      aria-hidden="true"
      {...props}
    />
  );
}

/**
 * A determinate progress bar. `role="progressbar"` with the value attributes is
 * what a screen reader announces, so the visual fill is purely decorative.
 */
export function ProgressBar({
  value,
  label,
  tone = "accent",
  className,
}: {
  value: number;
  label: string;
  tone?: "accent" | "warning" | "rejected";
  className?: string;
}): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const fill =
    tone === "rejected" ? "bg-rejected" : tone === "warning" ? "bg-warning" : "bg-lime-500";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("bg-bg-2 h-1.5 w-full overflow-hidden rounded-full", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-[200ms]", fill)}
        style={{ width: `${String(clamped)}%` }}
      />
    </div>
  );
}
