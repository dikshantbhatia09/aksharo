"use client";

import * as React from "react";

import { useStreak } from "@montaj/api-client";
import { Badge, Card, ProgressBar } from "@montaj/ui";

import { streakSummary } from "./streak-chip";

/**
 * The Subscription overview's streak card (08 §4, B03's `streak-widget-slot`).
 * Renders nothing for an ineligible or holdout workspace — same rule as the
 * sidebar chip (B06 acceptance criterion 2: a holdout never sees the widget).
 */
export function StreakWidget(): React.JSX.Element | null {
  const streak = useStreak();

  if (streak.isPending) {
    return (
      <Card data-testid="streak-widget-slot" role="status">
        <p className="text-fg-2 text-xs">Loading streak…</p>
      </Card>
    );
  }
  // Not eligible (flag off, declared minor, unassigned) or holdout: render
  // nothing at all — not even the card shell (B06 acceptance criterion 2).
  if (streak.data === undefined || !streak.data.eligible || streak.data.holdout) {
    return null;
  }

  const data = streak.data;

  return (
    <Card data-testid="streak-widget-slot">
      <div className="flex flex-col gap-2" data-testid="streak-widget">
        <div className="flex items-center justify-between">
          <h3 className="text-fg-0 text-sm font-semibold">Streak</h3>
          {data.creditsOnly ? null : <Badge tone="neutral">L{data.level}</Badge>}
        </div>

        {data.paused ? (
          <p className="text-warning text-xs" data-testid="streak-widget-paused">
            streak paused — one export restores it
          </p>
        ) : (
          <>
            <p className="text-fg-1 text-xs" data-testid="streak-widget-summary">
              {streakSummary(data)}
            </p>
            {!data.creditsOnly ? (
              <ProgressBar
                value={(Math.min(data.publishDaysThisWeek, data.bar) / data.bar) * 100}
                label={`${String(Math.min(data.publishDaysThisWeek, data.bar))} of ${String(data.bar)} publish days this week`}
              />
            ) : null}
          </>
        )}

        {data.nextRewardLabel !== null ? (
          <p className="text-fg-2 text-xs" data-testid="streak-widget-next-reward">
            Next: {data.nextRewardLabel}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
