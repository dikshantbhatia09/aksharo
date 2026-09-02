"use client";

import * as React from "react";

import { cn } from "../lib/cn";

/**
 * An empty list is a place to teach, not a blank. Copy rule (08 §6): say what
 * goes here and give exactly one thing to do next.
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
        "border-border flex flex-col items-center gap-3 rounded-md border border-dashed px-6 py-12 text-center",
        className,
      )}
      data-testid="empty-state"
    >
      {icon === undefined ? null : (
        <span className="text-fg-2 [&_svg]:size-6" aria-hidden="true">
          {icon}
        </span>
      )}
      <h3 className="text-fg-0 text-base font-medium">{title}</h3>
      <p className="text-fg-2 max-w-sm text-sm">{description}</p>
      {action}
    </div>
  );
}
