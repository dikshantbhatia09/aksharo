"use client";

/**
 * The five-stage rail (REP-007, master plan §13.2).
 *
 * It has the calm rhythm of a flow diagram and none of its machinery: the order
 * is fixed, nothing drags, nothing branches, and no node can be added or deleted.
 * The user edits the content, not the pipeline (DEC-001).
 *
 * Accessibility decisions worth keeping:
 *
 *   * every state is an icon AND a word — never colour alone (§13.3);
 *   * the rail is an ordered list, so a screen reader reads "3 of 5" without any
 *     ARIA invention;
 *   * a future node explains its prerequisite when clicked rather than doing
 *     nothing, which is the difference between "not yet" and "broken";
 *   * on a narrow screen the same markup becomes a vertical stepper — one
 *     component, not a second mobile one that drifts.
 */
import * as React from "react";

import type { RepurposeStageView } from "@montaj/api-client";
import { cn } from "@montaj/ui";

import type { RunActivity } from "@/components/repurpose/run-activity";

import { STAGE_COPY, type StageKey } from "@/components/repurpose/copy";

export interface RunStageRailProps {
  readonly stages: readonly RepurposeStageView[];
  /**
   * What the run is doing (`runActivity`). The API marks the current stage
   * `running` for a run that is waiting on the person and for one they
   * stopped; this is what lets the rail say "Your turn" or "Stopped" there
   * instead of "In progress".
   */
  readonly activity?: RunActivity;
  /** Opening a completed stage is a read; it never changes server state. */
  readonly onOpenStage?: (stage: StageKey) => void;
  /** Explains a prerequisite when someone reaches ahead. */
  readonly onBlockedStage?: (stage: StageKey, reason: string) => void;
  readonly className?: string;
}

const STATE_ICON: Readonly<Record<RepurposeStageView["state"], string>> = Object.freeze({
  complete: "✓",
  running: "●",
  failed: "!",
  waiting: "○",
});

/** Said out loud by a screen reader, so it must be a word, not a symbol. */
const STATE_WORD: Readonly<Record<RepurposeStageView["state"], string>> = Object.freeze({
  complete: "Done",
  running: "In progress",
  failed: "Needs attention",
  waiting: "Not started",
});

export function RunStageNode({
  stage,
  index,
  total,
  activity,
  onOpen,
  onBlocked,
}: {
  readonly stage: RepurposeStageView;
  readonly index: number;
  readonly total: number;
  readonly activity?: RunActivity;
  readonly onOpen?: (stage: StageKey) => void;
  readonly onBlocked?: (stage: StageKey, reason: string) => void;
}): React.JSX.Element {
  const key = stage.stage as StageKey;
  // eslint-disable-next-line security/detect-object-injection -- lookup on a closed literal key, not attacker-controlled
  const copy = STAGE_COPY[key];
  // A failed step is where the run stopped, so it opens like the current one;
  // it used to answer "opens once the earlier steps are done" about step 1.
  const reachable = stage.state !== "waiting";
  // A stopped run's last step is not in progress, and nothing is "current".
  const stopped = stage.state === "running" && activity === "stopped";
  const current = stage.state === "running" && !stopped;
  const word = stopped
    ? "Stopped"
    : current && activity === "needs_you"
      ? "Your turn"
      : STATE_WORD[stage.state];

  const activate = (): void => {
    if (reachable) {
      onOpen?.(key);
      return;
    }
    onBlocked?.(key, `${copy.title} opens once the earlier steps are done.`);
  };

  return (
    <li
      data-testid={`stage-node-${stage.stage}`}
      data-state={stage.state}
      {...(stopped ? { "data-stopped": "true" } : {})}
    >
      <button
        type="button"
        onClick={activate}
        aria-current={current ? "step" : undefined}
        aria-label={`Step ${String(index + 1)} of ${String(total)}: ${copy.title}. ${word}.`}
        className={cn(
          // The canvas's stage pill: a 20 px state dot, then the title, on an
          // outlined chip at least 32 px tall. Not a card — the rail is a row
          // of small things and a card each would be a wall.
          //
          // Accent budget: only the CURRENT step carries the accent (the
          // "active nav row" recipe). Done steps are neutral with a check;
          // hover is the system's neutral tint, never an accent border.
          "flex min-h-8 shrink-0 items-center gap-2 rounded-sm border px-2.5 py-1",
          "text-xs whitespace-nowrap transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
          current && "border-accent/60 bg-accent/14 text-accent-200",
          stopped && "border-border text-fg-1",
          stage.state === "complete" && "border-border text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
          stage.state === "failed" && "border-rejected/60 text-rejected",
          stage.state === "waiting" && "border-border text-fg-2",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-2xs",
            stage.state === "complete" && "bg-bg-2 text-accepted",
            current && "bg-accent text-on-accent",
            stopped && "bg-bg-2 text-fg-1",
            stage.state === "failed" && "bg-rejected/20 text-rejected",
            stage.state === "waiting" && "bg-bg-2 text-fg-2",
          )}
          data-testid={`stage-icon-${stage.stage}`}
        >
          {stopped ? "■" : STATE_ICON[stage.state]}
        </span>
        {copy.title}
        {/* The word, not just the colour or the glyph (§13.3). */}
        <span className="sr-only">{word}</span>
      </button>
    </li>
  );
}

export function RunStageRail({
  stages,
  activity,
  onOpenStage,
  onBlockedStage,
  className,
}: RunStageRailProps): React.JSX.Element {
  return (
    <nav aria-label="Your progress" data-testid="run-stage-rail" className={className}>
      {/*
        The canvas's rail wraps rather than scrolling: every stage stays
        visible at every width, which is the whole point of showing the shape
        of the pipeline. It is still one ordered list, not a second mobile
        component (§3.1).
      */}
      <ol className="flex flex-wrap gap-1.5">
        {stages.map((stage, index) => (
          <RunStageNode
            key={stage.stage}
            stage={stage}
            index={index}
            total={stages.length}
            {...(activity === undefined ? {} : { activity })}
            {...(onOpenStage === undefined ? {} : { onOpen: onOpenStage })}
            {...(onBlockedStage === undefined ? {} : { onBlocked: onBlockedStage })}
          />
        ))}
      </ol>
    </nav>
  );
}
