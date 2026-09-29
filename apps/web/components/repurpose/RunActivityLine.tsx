"use client";

/**
 * The step a run is on, with its own progress (2026-09-29):
 * "Downloading your video · 3.1 of 5.0 GB · about 2 min left", over a bar
 * that is THIS step's, not the run's.
 *
 * Every word comes from the API (`run.activity`, `run-activity.ts`), which
 * only sends a time left it can justify from how fast the step has actually
 * moved. This does not invent one either: no `etaSeconds`, no estimate.
 *
 * Not a live region. The stage's own sentence above it is one already, and a
 * percentage re-announced on every poll would talk over everything else.
 */
import * as React from "react";

import type { RepurposeRunActivity } from "@montaj/api-client";
import { cn, formatEta, ProgressBar } from "@montaj/ui";

/** "about 2 min left", or nothing when the API sent no estimate. */
export function activityEta(
  activity: Pick<RepurposeRunActivity, "etaSeconds">,
): string | undefined {
  return activity.etaSeconds === undefined ? undefined : formatEta(activity.etaSeconds * 1000);
}

/** The label, then what it is in units, then the time left: one line. */
export function activitySentence(activity: RepurposeRunActivity): string {
  const eta = activityEta(activity);
  return [activity.label, activity.detail, eta]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

export function RunActivityLine({
  activity,
  className,
}: {
  readonly activity: RepurposeRunActivity;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn("flex flex-col gap-1.5", className)}
      data-testid="run-activity"
      data-step={activity.step}
    >
      <p className="m-0 text-sm text-fg-1" data-testid="run-activity-text">
        {activitySentence(activity)}
      </p>
      {activity.percent === undefined ? null : (
        <ProgressBar
          value={activity.percent}
          label={`${activity.label}: ${String(activity.percent)}%`}
          className="max-w-md"
        />
      )}
    </div>
  );
}
