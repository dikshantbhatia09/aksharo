"use client";

/**
 * One stage's panel, and the pieces around it (REP-007).
 *
 * `StagePanel` is the expanded stage; `StageSummary` is what a completed stage
 * collapses into. Only one stage is expanded at a time (§3.1), which is enforced
 * by the workspace that renders them, not by each panel guessing.
 */
import { AlertTriangle, Check } from "lucide-react";
import * as React from "react";

import { Button, cn } from "@montaj/ui";

import { BACKGROUND_NOTE, STAGE_COPY, safeErrorCopy, type StageKey } from "@/components/repurpose/copy";

export interface StagePanelProps {
  readonly stage: StageKey;
  /** 1-based position in the rail, shown as the canvas's monospace "02". */
  readonly index?: number;
  /** The short right-aligned status the canvas puts on the panel's header. */
  readonly note?: string;
  /** Shown while the stage is doing something, under a live region. */
  readonly message?: string;
  readonly busy?: boolean;
  readonly children?: React.ReactNode;
  readonly className?: string;
}

export function StagePanel({
  stage,
  index,
  note,
  message,
  busy = false,
  children,
  className,
}: StagePanelProps): React.JSX.Element {
  // eslint-disable-next-line security/detect-object-injection -- lookup on a closed literal key, not attacker-controlled
  const copy = STAGE_COPY[stage];
  return (
    <section
      aria-labelledby={`stage-heading-${stage}`}
      data-testid={`stage-panel-${stage}`}
      className={cn("flex flex-col gap-3 rounded-md border border-border bg-surface p-5", className)}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {index === undefined ? null : (
          // The step number is a quiet index, not an accent: the rail above
          // already marks the current step.
          <span className="font-mono text-xs text-fg-2">
            <span className="sr-only">Step </span>
            {String(index).padStart(2, "0")}
          </span>
        )}
        <h2 id={`stage-heading-${stage}`} className="m-0 text-lg text-fg-0">
          {copy.title}
        </h2>
        {note === undefined ? null : (
          <span className="ml-auto text-xs text-fg-2">{note}</span>
        )}
      </div>
      <p className="m-0 text-sm text-fg-2">{copy.helper}</p>

      {message !== undefined && (
        <p
          // Progress has to be announced, not just animated (§13.3).
          role="status"
          aria-live="polite"
          data-testid={`stage-status-${stage}`}
          className="text-fg-1 m-0 text-sm"
        >
          {message}
        </p>
      )}
      {busy && (
        <p className="m-0 text-xs text-fg-2" data-testid="background-note">
          {BACKGROUND_NOTE}
        </p>
      )}

      {children !== undefined && <div>{children}</div>}
    </section>
  );
}

/** A finished stage, collapsed to one line with a way back in (§3.1). */
export function StageSummary({
  stage,
  summary,
  onEdit,
}: {
  readonly stage: StageKey;
  readonly summary: string;
  readonly onEdit?: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid={`stage-summary-${stage}`}
      className="flex items-center justify-between gap-3 rounded-sm bg-sunken px-3 py-2"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-fg-1">
        <Check className="size-4 shrink-0 text-accepted" strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only">Done: </span>
        <span className="truncate">{summary}</span>
      </span>
      {onEdit !== undefined && (
        <Button variant="ghost" size="sm" onClick={onEdit} data-testid={`stage-edit-${stage}`}>
          Edit
        </Button>
      )}
    </div>
  );
}

export interface StageErrorCardProps {
  /** A safe code from the API. Never a provider or worker message. */
  readonly code: string | null;
  /** Maps to the run, so support can find it without asking for a screenshot. */
  readonly supportCode: string;
  readonly onRetry?: () => void;
  readonly onChooseAnother?: () => void;
  readonly retrying?: boolean;
}

/**
 * What a failed stage shows (§3.4).
 *
 * Four things, always in this order: what happened, whether their work is safe,
 * one recommended action, and a support code. A raw error never appears — the
 * code is looked up, and an unknown code still produces a sentence.
 */
export function StageErrorCard({
  code,
  supportCode,
  onRetry,
  onChooseAnother,
  retrying = false,
}: StageErrorCardProps): React.JSX.Element {
  const copy = safeErrorCopy(code);
  const retryable = copy.action === "retry";
  const showRetry = retryable && onRetry !== undefined;

  return (
    <div
      role="alert"
      data-testid="stage-error"
      data-error-code={code ?? "unknown"}
      className="rounded-md border border-rejected/60 bg-surface p-5"
    >
      <p className="flex items-center gap-2 text-base font-medium text-fg-0">
        {/* Icon plus text, so the state does not depend on colour (§13.3). */}
        <AlertTriangle
          className="size-4 shrink-0 text-rejected"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        {copy.title}
      </p>
      <p className="mt-1 text-sm text-fg-1">{copy.reassurance}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* One primary: the recommended action. Retrying when it can help,
            otherwise the card's own next step. */}
        {showRetry && (
          <Button variant="primary" size="sm" onClick={onRetry} disabled={retrying} data-testid="stage-error-retry">
            {retrying ? "Trying again…" : copy.actionLabel}
          </Button>
        )}
        {onChooseAnother !== undefined && (
          <Button
            // The only action on the card becomes its primary.
            variant={showRetry ? "ghost" : "primary"}
            size="sm"
            onClick={onChooseAnother}
            data-testid="stage-error-choose-another"
          >
            {retryable ? "Choose another video" : copy.actionLabel}
          </Button>
        )}
      </div>

      <p className="mt-4 text-2xs text-fg-2" data-testid="support-code">
        Support code: <span className="font-mono select-all">{supportCode}</span>
      </p>
    </div>
  );
}
