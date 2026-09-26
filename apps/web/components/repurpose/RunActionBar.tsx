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
import { Button, ConfirmAction, ProgressBar, cn } from "@montaj/ui";

import { safeErrorCopy } from "@/components/repurpose/copy";


export interface RunAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
  /**
   * For an action that cannot be undone (stopping a run): the button then
   * asks first, through `ConfirmAction`, and `onClick` runs on the confirm.
   */
  readonly confirm?: {
    readonly title: string;
    readonly description: string;
    readonly confirmLabel: string;
    readonly testId: string;
  };
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
        "flex flex-wrap items-center gap-2 border-t border-border pt-4",
        className,
      )}
    >
      {primary !== undefined && (
        <Button
          variant="primary"
          size="sm"
          onClick={primary.onClick}
          disabled={primary.disabled ?? false}
          data-testid={primary.testId}
        >
          {primary.label}
        </Button>
      )}
      {secondary === undefined ? null : secondary.confirm === undefined ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={secondary.onClick}
          disabled={secondary.disabled ?? false}
          data-testid={secondary.testId}
        >
          {secondary.label}
        </Button>
      ) : (
        <ConfirmAction
          trigger={
            <Button
              variant="secondary"
              size="sm"
              disabled={secondary.disabled ?? false}
              data-testid={secondary.testId}
            >
              {secondary.label}
            </Button>
          }
          title={secondary.confirm.title}
          description={secondary.confirm.description}
          confirmLabel={secondary.confirm.confirmLabel}
          confirmTestId={secondary.confirm.testId}
          onConfirm={secondary.onClick}
        />
      )}
      {note === undefined ? null : <p className="m-0 text-xs text-fg-2">{note}</p>}
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
  // A run that stopped is not "0% complete" and its preview is not coming: the
  // projection zeroes progress on failure, and the old copy promised both.
  const stoppedLine =
    run.status === "failed"
      ? safeErrorCopy(run.failureCode).title
      : run.status === "cancelled"
        ? "You stopped this run"
        : null;
  const placeholder =
    stoppedLine ??
    (["draft", "acquiring", "preparing_media"].includes(run.status)
      ? "Preview appears once your video is ready"
      : "No preview yet");

  return (
    <aside
      aria-label="This video"
      data-testid="persistent-preview"
      className={cn(
        "flex flex-col gap-4 self-start rounded-md border border-border bg-surface p-5",
        className,
      )}
    >
      <h2 className="m-0 text-sm font-medium text-fg-0">This video</h2>

      {/* The video canvas colour, not a gradient: the frame is for footage. */}
      <div
        className="flex aspect-video items-center justify-center rounded-sm bg-ink px-3 text-center text-xs text-fg-2"
        data-testid="preview-placeholder"
      >
        {/* A poster arrives with the media; until then the box holds its shape so
            nothing jumps when it does (§13.6). */}
        {placeholder}
      </div>

      <dl className="m-0 flex flex-col gap-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-fg-2">Source</dt>
          <dd className="m-0 min-w-0 truncate text-fg-0" data-testid="preview-source">
            {run.sourceDisplay ?? (run.sourceKind === "upload" ? "Your upload" : "Link")}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-fg-2">Suggested moments</dt>
          <dd className="m-0 font-mono text-fg-0 tabular-nums" data-testid="preview-candidates">
            {run.candidateCount}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-fg-2">Videos being made</dt>
          <dd className="m-0 font-mono text-fg-0 tabular-nums" data-testid="preview-variants">
            {run.variantCount}
          </dd>
        </div>
      </dl>

      <div>
        {stoppedLine === null ? (
          <>
            <ProgressBar value={run.progress} label="How far along your video is" />
            <p className="mt-1.5 text-xs text-fg-2" data-testid="preview-progress">
              {run.progress}% complete
            </p>
          </>
        ) : (
          <p className="m-0 text-xs text-fg-2" data-testid="preview-progress">
            Stopped
          </p>
        )}
      </div>
    </aside>
  );
}
