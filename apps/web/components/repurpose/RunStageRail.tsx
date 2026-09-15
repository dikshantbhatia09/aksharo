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


import { STAGE_COPY, type StageKey } from "@/components/repurpose/copy";

export interface RunStageRailProps {
  readonly stages: readonly RepurposeStageView[];
  /** Opening a completed stage is a read; it never changes server state. */
  readonly onOpenStage?: (stage: StageKey) => void;
  /** Explains a prerequisite when someone reaches ahead. */
  readonly onBlockedStage?: (stage: StageKey, reason: string) => void;
  readonly className?: string;
}

const STATE_ICON: Readonly<Record<RepurposeStageView["state"], string>> = Object.freeze({
  complete: "✓",
  running: "•",
  failed: "!",
  waiting: "",
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
  onOpen,
  onBlocked,
}: {
  readonly stage: RepurposeStageView;
  readonly index: number;
  readonly total: number;
  readonly onOpen?: (stage: StageKey) => void;
  readonly onBlocked?: (stage: StageKey, reason: string) => void;
}): React.JSX.Element {
  const key = stage.stage as StageKey;
  // eslint-disable-next-line security/detect-object-injection -- lookup on a closed literal key, not attacker-controlled
  const copy = STAGE_COPY[key];
  const reachable = stage.state === "complete" || stage.state === "running";

  const activate = (): void => {
    if (reachable) {
      onOpen?.(key);
      return;
    }
    onBlocked?.(key, `${copy.title} opens once the earlier steps are done.`);
  };

  return (
    <li
      className="flex flex-1 items-center gap-2"
      data-testid={`stage-node-${stage.stage}`}
      data-state={stage.state}
    >
      <button
        type="button"
        onClick={activate}
        aria-current={stage.state === "running" ? "step" : undefined}
        aria-label={`Step ${String(index + 1)} of ${String(total)}: ${copy.title}. ${STATE_WORD[stage.state]}.`}
        className={cn(
          "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-500",
          stage.state === "running" && "border-lime-500/45 bg-lime-500/12",
          stage.state === "complete" && "border-border bg-bg-2",
          stage.state === "failed" && "border-rejected bg-bg-2",
          stage.state === "waiting" && "border-border bg-bg-1 text-fg-2",
        )}
      >
        <span className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-fg-2">
          <span aria-hidden="true" className="tabular-nums">
            {index + 1}
          </span>
          {STATE_ICON[stage.state] !== "" && (
            <span aria-hidden="true" data-testid={`stage-icon-${stage.stage}`}>
              {STATE_ICON[stage.state]}
            </span>
          )}
          {/* The word, not just the colour or the glyph. */}
          <span>{STATE_WORD[stage.state]}</span>
        </span>
        <span className="text-sm text-fg-0">{copy.title}</span>
        <span className="text-xs text-fg-2">{stage.label}</span>
      </button>
    </li>
  );
}

export function RunStageRail({
  stages,
  onOpenStage,
  onBlockedStage,
  className,
}: RunStageRailProps): React.JSX.Element {
  return (
    <nav aria-label="Your progress" data-testid="run-stage-rail" className={className}>
      <ol
        className={cn(
          "flex flex-col gap-2",
          // The horizontal rail is the desktop shape; the vertical stepper is
          // the same list, not a second component (§3.1).
          "md:flex-row md:items-stretch md:gap-3",
        )}
      >
        {stages.map((stage, index) => (
          <RunStageNode
            key={stage.stage}
            stage={stage}
            index={index}
            total={stages.length}
            {...(onOpenStage === undefined ? {} : { onOpen: onOpenStage })}
            {...(onBlockedStage === undefined ? {} : { onBlocked: onBlockedStage })}
          />
        ))}
      </ol>
    </nav>
  );
}
