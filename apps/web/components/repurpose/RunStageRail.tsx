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
    <li data-testid={`stage-node-${stage.stage}`} data-state={stage.state}>
      <button
        type="button"
        onClick={activate}
        aria-current={stage.state === "running" ? "step" : undefined}
        aria-label={`Step ${String(index + 1)} of ${String(total)}: ${copy.title}. ${STATE_WORD[stage.state]}.`}
        className={cn(
          // The canvas's stage pill: a 22 px state dot, then the title, on an
          // 8 px outlined chip. Not a card — the rail is a row of ten-ish
          // small things and a card each would be a wall.
          "flex shrink-0 items-center gap-[7px] rounded-sm border px-2.5 py-1.5",
          "text-[11.5px] whitespace-nowrap transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
          stage.state === "running" && "border-accent bg-accent/12 text-accent-200",
          stage.state === "complete" && "border-border text-neutral-300 hover:border-accent",
          stage.state === "failed" && "border-rejected text-rejected",
          stage.state === "waiting" && "border-border text-neutral-500",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px]",
            stage.state === "complete" && "bg-accent-800 text-accent-100",
            stage.state === "running" &&
              "bg-accent/18 text-accent-200 shadow-[inset_0_0_0_1px_var(--color-accent)]",
            stage.state === "failed" && "bg-rejected/20 text-rejected",
            stage.state === "waiting" && "bg-neutral-900 text-neutral-500",
          )}
          data-testid={`stage-icon-${stage.stage}`}
        >
          {STATE_ICON[stage.state]}
        </span>
        {copy.title}
        {/* The word, not just the colour or the glyph (§13.3). */}
        <span className="sr-only">{STATE_WORD[stage.state]}</span>
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
            {...(onOpenStage === undefined ? {} : { onOpen: onOpenStage })}
            {...(onBlockedStage === undefined ? {} : { onBlocked: onBlockedStage })}
          />
        ))}
      </ol>
    </nav>
  );
}
