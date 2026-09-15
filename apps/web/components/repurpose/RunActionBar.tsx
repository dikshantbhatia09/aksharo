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
        "sticky bottom-0 flex flex-wrap items-center justify-between gap-3",
        "border-t border-border bg-bg-1/95 px-4 py-3 backdrop-blur",
        className,
      )}
    >
      <p className="text-xs text-fg-2">{note ?? ""}</p>
      <div className="flex items-center gap-2">
        {secondary !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            onClick={secondary.onClick}
            disabled={secondary.disabled ?? false}
            data-testid={secondary.testId}
          >
            {secondary.label}
          </Button>
        )}
        {primary !== undefined && (
          <Button
            size="sm"
            onClick={primary.onClick}
            disabled={primary.disabled ?? false}
            data-testid={primary.testId}
          >
            {primary.label}
          </Button>
        )}
      </div>
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
      className={cn("rounded-md border border-border bg-bg-1 p-4", className)}
    >
      <div
        className="flex aspect-video items-center justify-center rounded-sm border border-border bg-bg-2 text-xs text-fg-2"
        data-testid="preview-placeholder"
      >
        {/* A poster arrives with the media; until then the box holds its shape so
            nothing jumps when it does (§13.6). */}
        Preview appears once your video is ready
      </div>

      <dl className="mt-3 space-y-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-fg-2">Source</dt>
          <dd className="truncate text-fg-1" data-testid="preview-source">
            {run.sourceDisplay ?? (run.sourceKind === "upload" ? "Your upload" : "Link")}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-fg-2">Suggested moments</dt>
          <dd className="text-fg-1" data-testid="preview-candidates">
            {run.candidateCount}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-fg-2">Videos being made</dt>
          <dd className="text-fg-1" data-testid="preview-variants">
            {run.variantCount}
          </dd>
        </div>
      </dl>

      <div className="mt-3">
        <ProgressBar value={run.progress} label="How far along your video is" />
        <p className="mt-1 text-2xs text-fg-2" data-testid="preview-progress">
          {run.progress}% complete
        </p>
      </div>
    </aside>
  );
}
