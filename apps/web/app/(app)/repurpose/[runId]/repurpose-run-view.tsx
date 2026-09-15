"use client";

/**
 * `/repurpose/[runId]` — the resumable guided workspace (REP-007, §3.1).
 *
 * Everything on this page is derived from the server's run projection. The
 * client owns which stage is EXPANDED and nothing else: status, progress, stage
 * states and every sentence come from the API, so two tabs open on the same run
 * cannot disagree, and a refresh mid-flight resumes rather than restarts.
 *
 * Downstream stages have no engine yet (Waves 3-10). Rather than pretend, each
 * one says what it is waiting for. That is the honest version of the "mock
 * fixture panel" the plan allows, and it needs no development-only branch that
 * could ship by accident.
 */
import Link from "next/link";
import * as React from "react";

import { isApiError, useCancelRepurposeRun, useRepurposeRun, useRetryRepurposeRun } from "@montaj/api-client";
import { Skeleton } from "@montaj/ui";

import type { StageKey } from "@/components/repurpose/copy";

import { PersistentPreview, RunActionBar } from "@/components/repurpose/RunActionBar";
import { RunStageRail } from "@/components/repurpose/RunStageRail";
import { StageErrorCard, StagePanel } from "@/components/repurpose/StagePanel";

/** What each not-yet-built stage honestly says while it waits. */
const STAGE_WAITING_NOTE: Readonly<Record<StageKey, string>> = Object.freeze({
  getting_video: "Your video is being prepared.",
  finding_clips: "Suggested moments appear here once your video is ready.",
  styles_formats: "Choose sizes and looks here once you have picked your moments.",
  review: "Your finished videos appear here for a final look before anything is posted.",
  publish: "Connect accounts and choose where each video goes. Nothing is posted without you.",
});

export function RepurposeRunView({ runId }: { readonly runId: string }): React.JSX.Element {
  const query = useRepurposeRun(runId);
  const cancel = useCancelRepurposeRun();
  const retry = useRetryRepurposeRun();
  const [openStage, setOpenStage] = React.useState<StageKey | null>(null);
  const [blockedNote, setBlockedNote] = React.useState<string | null>(null);

  if (query.isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8" data-testid="run-loading">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-4 h-24 w-full" />
      </main>
    );
  }

  if (query.isError) {
    // 404 covers both "no such run" and "this workspace cannot see it" — the API
    // deliberately does not distinguish, and neither does this page.
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-8" data-testid="run-missing">
        <h1 className="text-lg text-fg-0">
          {notFound ? "We could not find that video project" : "We could not load this just now"}
        </h1>
        <p className="mt-2 text-sm text-fg-2">
          {notFound
            ? "It may have been removed, or the link may belong to another workspace."
            : "Your work is safe. Please try again in a moment."}
        </p>
        <Link href="/repurpose/new" className="mt-4 inline-block text-sm text-lime-500 underline">
          Start a new one
        </Link>
      </main>
    );
  }

  const run = query.data;
  const currentStage = run.currentStage as StageKey;
  const expanded = openStage ?? currentStage;
  const busy = !["draft", "published", "failed", "cancelled"].includes(run.status);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8" data-testid="repurpose-run">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg text-fg-0">Your video</h1>
        <p className="text-xs text-fg-2" data-testid="run-status">
          {run.message}
        </p>
      </header>

      <div className="mt-6">
        <RunStageRail
          stages={run.stages}
          onOpenStage={(stage) => {
            setBlockedNote(null);
            setOpenStage(stage);
          }}
          onBlockedStage={(_stage, reason) => {
            // Clicking ahead explains the prerequisite rather than doing
            // nothing, which is the difference between "not yet" and "broken".
            setBlockedNote(reason);
          }}
        />
      </div>

      {blockedNote !== null && (
        <p role="status" className="mt-2 text-xs text-fg-2" data-testid="stage-blocked-note">
          {blockedNote}
        </p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          {run.status === "failed" ? (
            <StageErrorCard
              code={run.failureCode}
              // The run id IS the support code: it is already in every log line
              // and every audit row for this run.
              supportCode={run.id}
              retrying={retry.isPending}
              onRetry={
                run.canRetry
                  ? () => {
                      retry.mutate(run.id);
                    }
                  : undefined
              }
              onChooseAnother={() => {
                window.location.assign("/repurpose/new");
              }}
            />
          ) : (
            <StagePanel stage={expanded} message={run.message} busy={busy && expanded === currentStage}>
              <p className="text-xs text-fg-2" data-testid={`stage-note-${expanded}`}>
                {/* eslint-disable-next-line security/detect-object-injection -- `expanded` is one of the five stage literals */}
                {STAGE_WAITING_NOTE[expanded]}
              </p>
            </StagePanel>
          )}
        </div>

        <PersistentPreview run={run} />
      </div>

      <RunActionBar
        note={run.canCancel ? "Nothing is posted anywhere without your confirmation." : ""}
        {...(run.canCancel
          ? {
              secondary: {
                label: cancel.isPending ? "Stopping…" : "Stop this run",
                disabled: cancel.isPending,
                testId: "run-cancel",
                onClick: () => {
                  cancel.mutate(run.id);
                },
              },
            }
          : {})}
      />
    </main>
  );
}
