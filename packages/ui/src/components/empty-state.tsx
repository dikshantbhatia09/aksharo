"use client";

import * as React from "react";

import { cn } from "../lib/cn";

/**
 * An empty list is a place to teach, not a blank. Copy rule (08 §6, and
 * DESIGN.md "Empty states"): a one-line headline, one sentence saying what goes
 * here, and exactly one action that starts the next step. It is a card like any
 * other (solid hairline, surface ground) — no dashed drop-zone look unless the
 * caller really is a drop target and says so through `className`.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "border-border bg-surface flex flex-col items-center gap-2 rounded-md border px-6 py-12 text-center",
        className,
      )}
      data-testid="empty-state"
    >
      {icon === undefined ? null : (
        <span className="text-fg-2 mb-1 [&_svg]:size-6 [&_svg]:stroke-[1.75]" aria-hidden="true">
          {icon}
        </span>
      )}
      <h3 className="text-fg-0 text-base font-semibold">{title}</h3>
      <p className="text-fg-2 max-w-sm text-sm">{description}</p>
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </div>
  );
}
