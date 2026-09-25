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
import { Download, Loader2 } from "lucide-react";
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
import { Badge, Button, PageHeader, Skeleton } from "@montaj/ui";

import type { StageKey } from "@/components/repurpose/copy";

import { ClipPreview } from "@/components/repurpose/ClipPreview";
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

/** `m:ss` for a position in the source video. */
function formatClock(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

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
      <div className="w-full" data-testid="run-loading" role="status" aria-label="Loading this run">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-6 h-8 w-full max-w-xl" />
        <Skeleton className="mt-6 h-40 w-full" />
      </div>
    );
  }

  if (query.isError) {
    // 404 covers both "no such run" and "this workspace cannot see it" — the API
    // deliberately does not distinguish, and neither does this page.
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <div className="flex w-full max-w-2xl flex-col gap-5" data-testid="run-missing">
        <PageHeader
          eyebrow="Clips pipeline"
          title={notFound ? "We could not find that video project" : "This run could not be loaded"}
          description={
            notFound
              ? "It may have been removed, or the link may belong to another workspace."
              : "Your work is safe. Refresh the page in a moment to try again."
          }
        />
        <div>
          <Button variant="secondary" asChild>
            <Link href="/repurpose/new" className="no-underline">
              Start a new run
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const run = query.data;
  const currentStage = run.currentStage as StageKey;
  const expanded = openStage ?? currentStage;
  const busy = !["draft", "published", "failed", "cancelled"].includes(run.status);

  const stageIndex = run.stages.findIndex((entry) => entry.stage === expanded);
  const candidates = candidatesQuery.data?.candidates ?? [];

  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(240px,280px)]"
      data-testid="repurpose-run"
    >
      <div className="flex min-w-0 flex-col gap-6">
        {/* The page is about THIS run, so its title is the run's source; the
            pipeline's pitch lives on /repurpose, not repeated on every run. */}
        <PageHeader
          eyebrow="Clips pipeline"
          className="[&>div]:w-full"
          title={
            <span className="block truncate">
              {run.sourceDisplay ?? (run.sourceKind === "upload" ? "Your upload" : "Your video")}
            </span>
          }
          description={<span data-testid="run-status">{run.message}</span>}
        />

        <div className="flex flex-col gap-2">
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
            <p role="status" className="text-xs text-fg-2" data-testid="stage-blocked-note">
              {blockedNote}
            </p>
          )}
        </div>

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
              {candidates.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <p className="m-0 text-sm text-fg-1" data-testid={`stage-note-${expanded}`}>
                    {candidates.length === 1
                      ? "1 moment found."
                      : `${String(candidates.length)} moments found.`}{" "}
                    Create a vertical 9:16 clip from any of them.
                  </p>

                  <ul
                    className="m-0 flex list-none flex-col gap-3 p-0"
                    data-testid="candidates-list"
                  >
                    {candidates.map((cand: RepurposeCandidateItem) => {
                      const matchingClip = clipsQuery.data?.clips?.find(
                        (c: RepurposeClipItem) => c.candidateId === cand.id,
                      );
                      const isCreating =
                        createClip.isPending && createClip.variables?.candidateId === cand.id;
                      // Never invent a score: a candidate without one shows none.
                      const score = cand.potentialScore ?? cand.score;
                      const title = cand.title ?? cand.headline ?? "Suggested moment";
                      // The clip's own project: where its captions live and are exported.
                      const clipProjectId = matchingClip?.variants?.[0]?.projectId;

                      return (
                        <li
                          key={cand.id}
                          className="flex flex-col gap-3 rounded-md border border-border bg-bg-0 p-4"
                          data-testid={`candidate-card-${cand.id}`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-[1_1_240px]">
                              <div className="flex flex-wrap items-center gap-2">
                                {score === undefined || score === null ? null : (
                                  <Badge tone="neutral">Potential {String(score)}%</Badge>
                                )}
                                <span className="font-mono text-2xs text-fg-2">
                                  {formatClock(cand.startMs)} – {formatClock(cand.endMs)} (
                                  {String(Math.round((cand.endMs - cand.startMs) / 1000))}s)
                                </span>
                              </div>
                              <h3 className="mt-1.5 text-sm font-semibold text-fg-0">{title}</h3>
                              {(cand.transcriptExcerpt || cand.reason) && (
                                <p className="mt-1 line-clamp-2 text-sm text-fg-2">
                                  {cand.transcriptExcerpt ?? cand.reason}
                                </p>
                              )}
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              {matchingClip ? (
                                matchingClip.mezzanineUrl ? (
                                  <>
                                    {/* The captioned video is an export from the clip's own
                                        project; the download is the clean picture it starts from. */}
                                    {clipProjectId === undefined ? null : (
                                      <Button variant="secondary" size="sm" asChild>
                                        <Link
                                          href={`/p/${clipProjectId}`}
                                          className="no-underline"
                                          aria-label={`Open in editor: ${title}`}
                                          data-testid={`open-clip-${cand.id}`}
                                        >
                                          Open in editor
                                        </Link>
                                      </Button>
                                    )}
                                    <Button variant="ghost" size="sm" asChild>
                                      <a
                                        href={matchingClip.mezzanineUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        download={`clip-${cand.id}.mp4`}
                                        className="no-underline"
                                        title="The 9:16 video without captions. Export from the editor for a captioned one."
                                        aria-label={`Download video without captions: ${title}`}
                                        data-testid={`download-clip-${cand.id}`}
                                      >
                                        <Download strokeWidth={1.75} aria-hidden="true" />
                                        Download video
                                      </a>
                                    </Button>
                                  </>
                                ) : (
                                  <span
                                    role="status"
                                    className="inline-flex items-center gap-1.5 text-xs text-fg-1"
                                  >
                                    <Loader2
                                      className="size-4 animate-spin text-fg-2"
                                      strokeWidth={1.75}
                                      aria-hidden="true"
                                    />
                                    Cutting the 9:16 clip…
                                  </span>
                                )
                              ) : (
                                // Secondary, not primary: a list of candidates
                                // would otherwise put a rani button on every row.
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={isCreating}
                                  aria-label={isCreating ? undefined : `Create 9:16 clip: ${title}`}
                                  onClick={() =>
                                    createClip.mutate({
                                      runId,
                                      candidateId: cand.id,
                                      aspect: "r9x16",
                                    })
                                  }
                                  data-testid={`create-clip-${cand.id}`}
                                >
                                  {isCreating ? "Queuing…" : "Create 9:16 clip"}
                                </Button>
                              )}
                            </div>
                          </div>

                          {matchingClip?.mezzanineUrl && (
                            <div className="max-w-[220px] overflow-hidden rounded-sm border border-border bg-ink">
                              <ClipPreview
                                videoUrl={matchingClip.mezzanineUrl}
                                projectId={clipProjectId}
                                label={`${title}, 9:16 clip`}
                                testId={`clip-video-${cand.id}`}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <p className="m-0 text-sm text-fg-2" data-testid={`stage-note-${expanded}`}>
                  {/* eslint-disable-next-line security/detect-object-injection -- bounded stage index */}
                  {STAGE_WAITING_NOTE[expanded]}
                </p>
              )}

              <RunActionBar
                className="mt-4"
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
