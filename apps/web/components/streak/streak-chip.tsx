"use client";

import * as React from "react";

import { useStreak } from "@montaj/api-client";
import { Badge } from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";

/**
 * Sidebar chip (08 §4 Streak widget): "3 of 3 publish days · L2 · 2 freezes
 * left"; paused reads "streak paused — one export restores it"; never a
 * reset. Renders nothing at all when the caller is not eligible (flag off,
 * declared minor, not yet assigned) or is in the holdout arm — a holdout
 * workspace answers `GET /streak` with real numbers so the cohort can be
 * measured, but must never see the widget (B06 acceptance criterion 2).
 */
export function StreakChip(): React.JSX.Element | null {
  const config = useRuntimeConfig();
  const streak = useStreak();

  const enabled = config.flags["growth.streakWidget"] === true;
  if (!enabled) return null;
  if (streak.data === undefined) return null;
  if (!streak.data.eligible || streak.data.holdout) return null;

  return (
    <div
      className="text-fg-2 flex items-center gap-2 px-2 text-xs"
      data-testid="streak-chip"
      title={streakSummary(streak.data)}
    >
      {streak.data.paused ? (
        <Badge tone="neutral" data-testid="streak-chip-paused">
          Streak paused — one export restores it
        </Badge>
      ) : (
        <span>{streakSummary(streak.data)}</span>
      )}
    </div>
  );
}

/** "3 of 3 publish days · L2 · 2 freezes left" — the exact 08 §4 copy shape. */
export function streakSummary(streak: {
  readonly publishDaysThisWeek: number;
  readonly bar: number;
  readonly level: number;
  readonly freezesRemaining: number;
  readonly creditsOnly: boolean;
}): string {
  const days = `${String(Math.min(streak.publishDaysThisWeek, streak.bar))} of ${String(streak.bar)} publish days`;
  if (streak.creditsOnly) return days;
  const freezes = `${String(streak.freezesRemaining)} freeze${streak.freezesRemaining === 1 ? "" : "s"} left`;
  return `${days} · L${String(streak.level)} · ${freezes}`;
}
