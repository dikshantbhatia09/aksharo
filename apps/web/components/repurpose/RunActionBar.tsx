"use client";

/**
 * The bottom action bar and the sticky preview column (REP-007, §3.1).
 *
 * One primary action, at most one secondary — the rule the whole flow is built
 * on, so it is enforced by the component's shape rather than by review: there is
 * exactly one `primary` prop and one `secondary` prop, and no children slot to
 * smuggle a third button through.
 */
import * as React from "react";

import type { RepurposeRunView } from "@montaj/api-client";
import { Button, ProgressBar, cn } from "@montaj/ui";


export interface RunAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
}

export function RunActionBar({
  primary,
  secondary,
  note,
  className,
}: {
  readonly primary?: RunAction;
  readonly secondary?: RunAction;
  /** One line stating exactly what the primary action will do (§3.8). */
  readonly note?: string;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid="run-action-bar"
      className={cn(
        // The canvas puts the run's actions inside the stage card, reading
        // left to right: the primary, the way out, then the sentence saying
        // what the primary will cost. Not a sticky footer bar — the stage
        // panel is short enough that a bar pinned to the viewport spent most
        // of its time floating over nothing.
        "flex flex-wrap items-center gap-[9px] pt-1",
        className,
      )}
    >
      {primary !== undefined && (
        <Button
          variant="primary"
          size="sm"
          className="h-8"
          onClick={primary.onClick}
          disabled={primary.disabled ?? false}
          data-testid={primary.testId}
        >
          {primary.label}
        </Button>
      )}
      {secondary !== undefined && (
        <Button
          variant="secondary"
          size="sm"
          className="h-8"
          onClick={secondary.onClick}
          disabled={secondary.disabled ?? false}
          data-testid={secondary.testId}
        >
          {secondary.label}
        </Button>
      )}
      <p className="text-neutral-500 m-0 text-[11px]">{note ?? ""}</p>
    </div>
  );
}

/**
 * The persistent right-hand column: what this run is, and how far it has got.
 *
 * It shows the SOURCE's safe display form and never the pasted URL, because a
 * link can carry a token and this panel is the one thing on screen during a
 * screen share (§17.4).
 */
export function PersistentPreview({
  run,
  className,
}: {
  readonly run: RepurposeRunView;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <aside
      aria-label="This video"
      data-testid="persistent-preview"
      className={cn("bg-surface flex flex-col gap-[11px] self-start rounded-md p-3.5", className)}
    >
      <span className="text-neutral-500 text-[9.5px] tracking-[0.12em] uppercase">Source</span>

      <div
        className="text-neutral-500 flex aspect-video items-center justify-center rounded-sm bg-[radial-gradient(120%_90%_at_50%_20%,var(--color-accent-900),var(--color-ink))] px-3 text-center text-[11px]"
        data-testid="preview-placeholder"
      >
        {/* A poster arrives with the media; until then the box holds its shape so
            nothing jumps when it does (§13.6). */}
        Preview appears once your video is ready
      </div>

      <dl className="m-0 flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-neutral-500">Source</dt>
          <dd className="text-neutral-300 m-0 truncate" data-testid="preview-source">
            {run.sourceDisplay ?? (run.sourceKind === "upload" ? "Your upload" : "Link")}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-neutral-500">Suggested moments</dt>
          <dd className="text-neutral-300 m-0" data-testid="preview-candidates">
            {run.candidateCount}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-neutral-500">Videos being made</dt>
          <dd className="text-neutral-300 m-0" data-testid="preview-variants">
            {run.variantCount}
          </dd>
        </div>
      </dl>

      <div>
        <ProgressBar value={run.progress} label="How far along your video is" />
        <p className="text-neutral-500 mt-1 text-2xs" data-testid="preview-progress">
          {run.progress}% complete
        </p>
      </div>

      <span className="rule-fade" aria-hidden="true" />
      <span className="text-neutral-400 text-[11.5px]">
        Nothing is posted anywhere without your confirmation.
      </span>
    </aside>
  );
}
