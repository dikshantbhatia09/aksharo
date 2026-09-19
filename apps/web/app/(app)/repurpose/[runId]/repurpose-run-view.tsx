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

import {
  isApiError,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  useCancelRepurposeRun,
  useCreateRepurposeClip,
  useRepurposeCandidates,
  useRepurposeClips,
  useRepurposeRun,
  useRetryRepurposeRun,
} from "@montaj/api-client";
import { Button, Skeleton } from "@montaj/ui";

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
  const candidatesQuery = useRepurposeCandidates(runId);
  const clipsQuery = useRepurposeClips(runId);
  const createClip = useCreateRepurposeClip();
  const [openStage, setOpenStage] = React.useState<StageKey | null>(null);
  const [blockedNote, setBlockedNote] = React.useState<string | null>(null);

  if (query.isPending) {
    return (
      <div className="w-full" data-testid="run-loading">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-4 h-24 w-full" />
      </div>
    );
  }

  if (query.isError) {
    // 404 covers both "no such run" and "this workspace cannot see it" — the API
    // deliberately does not distinguish, and neither does this page.
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <div className="w-full max-w-2xl" data-testid="run-missing">
        <h1 className="font-display m-0 text-lg">
          {notFound ? "We could not find that video project" : "We could not load this just now"}
        </h1>
        <p className="text-neutral-400 mt-2 text-sm">
          {notFound
            ? "It may have been removed, or the link may belong to another workspace."
            : "Your work is safe. Please try again in a moment."}
        </p>
        <Link
          href="/repurpose/new"
          className="text-accent hover:text-accent-300 mt-4 inline-block text-sm underline"
        >
          Start a new one
        </Link>
      </div>
    );
  }

  const run = query.data;
  const currentStage = run.currentStage as StageKey;
  const expanded = openStage ?? currentStage;
  const busy = !["draft", "published", "failed", "cancelled"].includes(run.status);

  const stageIndex = run.stages.findIndex((entry) => entry.stage === expanded);

  return (
    <div
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,264px)]"
      data-testid="repurpose-run"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <header className="max-w-[60ch]">
          <h1 className="font-display m-0 mb-[5px] text-[23px] tracking-[-0.02em]">
            One long video, nine posts
          </h1>
          <p className="text-neutral-400 m-0 text-[13px]" data-testid="run-status">
            {run.message}
          </p>
        </header>

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

        {blockedNote !== null && (
          <p role="status" className="text-neutral-500 text-xs" data-testid="stage-blocked-note">
            {blockedNote}
          </p>
        )}

        <div className="flex flex-col gap-4">
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
            <StagePanel
              stage={expanded}
              index={stageIndex < 0 ? undefined : stageIndex + 1}
              // eslint-disable-next-line security/detect-object-injection -- bounded stage index
              note={run.stages[stageIndex]?.label}
              message={run.message}
              busy={busy && expanded === currentStage}
            >
              {candidatesQuery.data?.candidates && candidatesQuery.data.candidates.length > 0 ? (
                <div className="flex flex-col gap-3 py-1">
                  <p
                    className="text-neutral-400 text-[12.5px]"
                    data-testid={`stage-note-${expanded}`}
                  >
                    Discovered {candidatesQuery.data.candidates.length} highlight moments. Pick a
                    moment to generate your vertical 9:16 clip.
                  </p>

                  <div className="flex flex-col gap-3 mt-2" data-testid="candidates-list">
                    {candidatesQuery.data.candidates.map((cand: RepurposeCandidateItem) => {
                      const durationSec = Math.round((cand.endMs - cand.startMs) / 1000);
                      const matchingClip = clipsQuery.data?.clips?.find(
                        (c: RepurposeClipItem) => c.candidateId === cand.id,
                      );
                      const isCreating =
                        createClip.isPending && createClip.variables?.candidateId === cand.id;

                      return (
                        <div
                          key={cand.id}
                          className="flex flex-col gap-2.5 rounded-lg border border-neutral-800 bg-neutral-900/70 p-4 transition hover:border-neutral-700"
                          data-testid={`candidate-card-${cand.id}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
                                  Viral Score: {cand.potentialScore ?? cand.score ?? 80}%
                                </span>
                                <span className="text-[11px] text-neutral-400 font-mono">
                                  {Math.floor(cand.startMs / 60000)}:
                                  {String(Math.floor((cand.startMs % 60000) / 1000)).padStart(
                                    2,
                                    "0",
                                  )}{" "}
                                  - {Math.floor(cand.endMs / 60000)}:
                                  {String(Math.floor((cand.endMs % 60000) / 1000)).padStart(2, "0")}{" "}
                                  ({durationSec}s)
                                </span>
                              </div>
                              <h4 className="mt-1.5 text-sm font-semibold text-neutral-100">
                                {cand.title ?? cand.headline ?? "Highlight Moment"}
                              </h4>
                              {(cand.transcriptExcerpt || cand.reason) && (
                                <p className="mt-1 text-xs text-neutral-400 line-clamp-2">
                                  {cand.transcriptExcerpt ?? cand.reason}
                                </p>
                              )}
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              {matchingClip ? (
                                matchingClip.mezzanineUrl ? (
                                  <a
                                    href={matchingClip.mezzanineUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    download={`clip-${cand.id}.mp4`}
                                    className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/90"
                                    data-testid={`download-clip-${cand.id}`}
                                  >
                                    Download 9:16 Clip
                                  </a>
                                ) : (
                                  <span className="text-xs text-amber-400 font-medium animate-pulse">
                                    Cutting 9:16 clip…
                                  </span>
                                )
                              ) : (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  className="h-8 text-xs font-medium"
                                  disabled={isCreating}
                                  onClick={() =>
                                    createClip.mutate({
                                      runId,
                                      candidateId: cand.id,
                                      aspect: "r9x16",
                                    })
                                  }
                                  data-testid={`create-clip-${cand.id}`}
                                >
                                  {isCreating ? "Queuing…" : "Create 9:16 Clip"}
                                </Button>
                              )}
                            </div>
                          </div>

                          {matchingClip?.mezzanineUrl && (
                            <div className="mt-2 overflow-hidden rounded-md bg-black border border-neutral-800 max-w-[220px]">
                              <video
                                src={matchingClip.mezzanineUrl}
                                controls
                                playsInline
                                className="w-full aspect-[9/16] object-cover"
                                data-testid={`clip-video-${cand.id}`}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p
                  className="text-neutral-400 text-[12.5px]"
                  data-testid={`stage-note-${expanded}`}
                >
                  {/* eslint-disable-next-line security/detect-object-injection -- bounded stage index */}
                  {STAGE_WAITING_NOTE[expanded]}
                </p>
              )}

              <RunActionBar
                note={
                  run.canCancel
                    ? "Nothing is posted anywhere without your confirmation."
                    : "This run has finished; nothing further will be spent."
                }
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
            </StagePanel>
          )}
        </div>
      </div>

      <PersistentPreview run={run} />
    </div>
  );
}
