"use client";

/**
 * The front door to the guided repurposing flow (master plan §24 step 1:
 * "Open **Create from a long video**").
 *
 * It renders only when `repurpose_flow` is on for THIS workspace. That is not
 * decoration: the flag is targeted, so the same home screen shows this to a
 * workspace in the cohort and shows nothing to everyone else — and a link to a
 * surface whose every API route answers 404 is worse than no link at all.
 *
 * Deliberately NOT a primary button. Home's primary action is the drop zone, and
 * §13.3 allows one primary per viewport section; this is the quieter second door
 * for a different job — one long video rather than a file to edit.
 */
import Link from "next/link";
import * as React from "react";

import { useFeatureFlag } from "@montaj/api-client";
import { cn } from "@montaj/ui";

/** The flag that gates the entire guided surface (REP-006). */
export const REPURPOSE_FLOW_FLAG = "repurpose_flow";

export function RepurposeEntryCard({
  className,
}: {
  readonly className?: string;
}): React.JSX.Element | null {
  const enabled = useFeatureFlag(REPURPOSE_FLOW_FLAG);
  if (!enabled) return null;

  return (
    <Link
      href="/repurpose/new"
      data-testid="repurpose-entry"
      className={cn(
        "group flex items-center justify-between gap-4 rounded-md border border-border bg-bg-1 px-4 py-3",
        "transition-colors hover:border-lime-500/45 hover:bg-bg-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-500",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm text-fg-0">Create from a long video</span>
        <span className="block text-xs text-fg-2">
          Turn one long video into short, captioned clips you review before anything is posted.
        </span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-fg-2 group-hover:text-fg-1">
        →
      </span>
    </Link>
  );
}
