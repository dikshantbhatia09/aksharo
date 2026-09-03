"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/cn";
import { ProgressBar } from "../primitives/surface";

/** The stage chips of 08 §2: Uploading → Transcribing → Aligning → Ready. */
export const JOB_STAGES = ["uploading", "transcribing", "aligning", "ready"] as const;

export type JobStage = (typeof JOB_STAGES)[number];

const STAGE_LABEL: Record<JobStage, string> = {
  uploading: "Uploading",
  transcribing: "Transcribing",
  aligning: "Aligning",
  ready: "Ready",
};

export interface JobProgressProps {
  stage: JobStage;
  /** 0–100 for the current stage. */
  progress?: number;
  /** From the `job.progress` realtime event (CONTRACTS §7). */
  etaMs?: number;
  /** Set when the job failed; the chip row freezes and the message is shown. */
  error?: string;
  onRetry?: () => void;
  className?: string;
}

/** "about 2 min left" / "about 40 s left". Rounded: an exact ETA reads as a lie. */
export function formatEta(etaMs: number | undefined): string | undefined {
  if (etaMs === undefined || !Number.isFinite(etaMs) || etaMs < 0) return undefined;
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 10) return "almost done";
  if (seconds < 90) return `about ${String(Math.round(seconds / 10) * 10)} s left`;
  return `about ${String(Math.round(seconds / 60))} min left`;
}

export function JobProgress({
  stage,
  progress,
  etaMs,
  error,
  onRetry,
  className,
}: JobProgressProps): React.JSX.Element {
  const currentIndex = JOB_STAGES.indexOf(stage);
  const eta = formatEta(etaMs);
  const failed = error !== undefined;

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="job-progress">
      <ol className="flex flex-wrap items-center gap-1.5" aria-label="Job progress">
        {JOB_STAGES.map((item, index) => {
          const current = index === currentIndex;
          const done = (index < currentIndex || stage === "ready") && !(failed && current);
          const active = current && stage !== "ready" && !failed;
          return (
            <li key={item}>
              <span
                data-stage={item}
                data-state={
                  failed && current ? "failed" : done ? "done" : active ? "active" : "pending"
                }
                aria-current={active ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium",
                  done && "border-accepted/40 bg-accepted/10 text-accepted",
                  active && "border-lime-500/40 bg-lime-500/10 text-lime-500",
                  !done && !active && "border-border text-fg-2",
                  failed && current && "border-rejected/40 bg-rejected/10 text-rejected",
                )}
              >
                {done ? <Check className="size-3" aria-hidden="true" /> : null}
                {active ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
                {failed && current ? <AlertTriangle className="size-3" aria-hidden="true" /> : null}
                {/* eslint-disable-next-line security/detect-object-injection -- bracket access on `item`, a typed enum value, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion */}
                {STAGE_LABEL[item]}
              </span>
            </li>
          );
        })}
      </ol>

      {progress !== undefined && !failed && stage !== "ready" ? (
        // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
        <ProgressBar value={progress} label={`${STAGE_LABEL[stage]} progress`} />
      ) : null}

      {failed ? (
        <p className="text-rejected flex items-center gap-2 text-xs" role="alert">
          {error}
          {onRetry === undefined ? null : (
            <button type="button" onClick={onRetry} className="rounded-sm underline">
              Retry
            </button>
          )}
        </p>
      ) : eta === undefined ? null : (
        <p className="text-fg-2 text-xs" data-testid="job-progress-eta">
          {eta}
        </p>
      )}
    </div>
  );
}
