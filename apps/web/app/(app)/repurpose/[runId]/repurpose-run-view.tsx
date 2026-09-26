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
 *
 * Clips hardening (2026-09-26) changed three things about what a failure does
 * here. A failed run shows its error card ABOVE its moments and clips, never
 * instead of them, so a finished clip cannot disappear behind someone else's
 * failure. The card's action is the failure's own: the same link again, another
 * video with the setup kept, or the link pre-filled to fix. And every clip
 * carries its own state and its own "Try again".
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  isApiError,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  useCancelRepurposeRun,
  useRepurposeCandidates,
  useRepurposeClips,
  useRepurposePreview,
  useRepurposeRun,
  useRetryRepurposeRun,
} from "@montaj/api-client";
import { Button, PageHeader, Skeleton } from "@montaj/ui";

import type { StageKey } from "@/components/repurpose/copy";

import { AddMomentForm } from "@/components/repurpose/AddMomentForm";
import { CandidateCard } from "@/components/repurpose/CandidateCard";
import { describeRefusal, type Refusal } from "@/components/repurpose/refusal";
import { canAddMoments, runActivity } from "@/components/repurpose/run-activity";
import { newRunHref, recallRunSetup } from "@/components/repurpose/run-setup";
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

/** Statuses after discovery has had its say: an empty list now means "none found". */
const ANALYSIS_DONE: ReadonlySet<string> = new Set([
  "candidates_ready",
  "materializing",
  "rendering",
  "review_ready",
  "changes_requested",
  "approved",
  "publishing",
  "partially_published",
  "published",
]);

/** Discovery is under way: moments are expected any moment, so the list polls. */
const DISCOVERING: ReadonlySet<string> = new Set(["transcribing", "analyzing"]);

export function RepurposeRunView({ runId }: { readonly runId: string }): React.JSX.Element {
  const router = useRouter();
  const query = useRepurposeRun(runId);
  const cancel = useCancelRepurposeRun();
  const retry = useRetryRepurposeRun();
  // Every hook sits above the early returns, so the options read the run
  // through `query.data` rather than the narrowed `run` below.
  const candidatesQuery = useRepurposeCandidates(runId, {
    poll: DISCOVERING.has(query.data?.status ?? ""),
    ...(query.data === undefined ? {} : { expectedCount: query.data.candidateCount }),
  });
  // A stopped run's waiting clips never start, so they are not polled for.
  const clipsQuery = useRepurposeClips(runId, { runStopped: query.data?.status === "cancelled" });
  // A manual run shows the form from the start (disabled until the transcript
  // exists), except once it has failed before that point: then it never will.
  const momentsVisible =
    query.data !== undefined &&
    !["cancelled", "published"].includes(query.data.status) &&
    ((query.data.mode === "manual" && query.data.status !== "failed") || canAddMoments(query.data));
  // Only for the source's length, which bounds "Add a moment by time".
  const sourcePreview = useRepurposePreview(momentsVisible ? runId : null);
  const [openStage, setOpenStage] = React.useState<StageKey | null>(null);
  const [blockedNote, setBlockedNote] = React.useState<string | null>(null);
  const [retryError, setRetryError] = React.useState<Refusal | null>(null);
  // The one clip whose preview holds a live caption stage (`ClipPreview`).
  const [activePreview, setActivePreview] = React.useState<string | null>(null);
  const [momentFormOpened, setMomentFormOpened] = React.useState(false);
  const momentFormRef = React.useRef<HTMLDivElement>(null);

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
  const activity = runActivity(run);
  const failed = activity === "failed";
  // "We'll keep working" is only true while the server is: not on a run that
  // is waiting for the person, and not on one that stopped.
  const busy = activity === "working" && run.status !== "draft";

  const stageIndex = run.stages.findIndex((entry) => entry.stage === expanded);
  const candidates = candidatesQuery.data?.candidates ?? [];
  const clips = clipsQuery.data?.clips ?? [];
  const momentsAllowed = canAddMoments(run);
  // The run's own count says moments exist that the (separately polled) list
  // does not hold yet. For those few seconds the list is behind, not empty:
  // "we did not find a moment" under "your moments are ready" was wrong.
  const momentsLoading = candidates.length === 0 && run.candidateCount > 0;
  // Manual runs are MADE of moments added by time, so the form is always open
  // there; after an empty discovery it is the way forward, so it opens too.
  // Once the person uses it, it stays open (`onOpenChange`), so adding the first
  // moment — or discovery landing mid-typing — does not fold it away.
  const momentFormOpen =
    momentFormOpened ||
    run.mode === "manual" ||
    (candidates.length === 0 && run.candidateCount === 0);
  const sourceDurationMs =
    sourcePreview.data !== undefined && sourcePreview.data.durationMs > 0
      ? sourcePreview.data.durationMs
      : null;
  // A failed run with nothing to show below its card shows only the card.
  const showPanel = !failed || candidates.length > 0 || clips.length > 0 || momentsVisible;

  const setup = recallRunSetup(run.id);
  const chooseAnother = (): void => {
    router.push(newRunHref(setup, { keepLink: false }));
  };
  const checkLink = (): void => {
    router.push(newRunHref(setup, { keepLink: true }));
  };
  const openMomentForm = (): void => {
    setMomentFormOpened(true);
    momentFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const tryAgain = (): void => {
    setRetryError(null);
    retry.mutate(run.id, {
      onError: (error) => {
        // Refused because the same link was started again meanwhile: the way
        // forward is that run, so the card links to it.
        setRetryError(describeRefusal(error, "retry"));
        // A 409 usually means the run already moved on; show where it is.
        if (isApiError(error) && error.status === 409) void query.refetch();
      },
    });
  };

  let emptyNote: { readonly text: string; readonly testId: string } | null = null;
  if (candidates.length === 0) {
    if (candidatesQuery.isError) {
      emptyNote = {
        text: "Your moments could not be loaded. Refresh the page to try again.",
        testId: "candidates-error",
      };
    } else if (momentsLoading) {
      // The list's own poll (`expectedCount`) catches up within seconds.
      emptyNote = { text: "Loading your moments…", testId: "candidates-loading" };
    } else if (run.mode === "manual" && momentsAllowed) {
      emptyNote = {
        text: "Add each moment you want as a clip by its start and end time.",
        testId: "candidates-empty",
      };
    } else if (run.mode === "manual" && !failed && expanded === "finding_clips") {
      // Nothing is being suggested on a manual run, so "suggested moments
      // appear here" would promise something that is not coming.
      emptyNote = {
        text: "Once the transcript is ready, add each moment you want by its start and end time.",
        testId: "candidates-manual-wait",
      };
    } else if (
      ANALYSIS_DONE.has(run.status) &&
      candidatesQuery.isSuccess &&
      run.candidateCount === 0
    ) {
      // Discovery finished and found nothing. Say so, and hand over the tool
      // that still works, rather than promising moments that are not coming.
      emptyNote = {
        text: "We did not find a moment worth suggesting in this video. Add one by its start and end time below.",
        testId: "candidates-empty",
      };
    } else if (failed && momentsAllowed) {
      emptyNote = {
        text: "You can still add a moment by its start and end time.",
        testId: "candidates-empty",
      };
    }
  }

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
          description={
            <span data-testid="run-status">
              {/* The card below says what went wrong; the header only says
                  where the run is, instead of "Something went wrong" twice. */}
              {failed ? "This run stopped before it finished." : run.message}
            </span>
          }
        />

        <div className="flex flex-col gap-2">
          <RunStageRail
            stages={run.stages}
            activity={activity}
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
          {failed && (
            // ABOVE the moments and clips, never instead of them: a finished
            // clip must not disappear because something else went wrong.
            <StageErrorCard
              code={run.failureCode}
              // The run id IS the support code: it is already in every log line
              // and every audit row for this run.
              supportCode={run.id}
              retrying={retry.isPending}
              retryError={retryError?.text ?? null}
              existingRunId={retryError?.existingRunId ?? null}
              {...(run.canRetry ? { onRetry: tryAgain } : {})}
              onChooseAnother={chooseAnother}
              // Only a link can be checked; an upload has none to pre-fill.
              {...(run.sourceKind === "upload" ? {} : { onCheckLink: checkLink })}
              {...(momentsAllowed ? { onAddMoment: openMomentForm } : {})}
            />
          )}

          {showPanel && (
            <StagePanel
              stage={expanded}
              index={stageIndex < 0 ? undefined : stageIndex + 1}
              // eslint-disable-next-line security/detect-object-injection -- bounded stage index
              note={run.stages[stageIndex]?.label}
              // A failed run's card already says what happened.
              {...(failed ? {} : { message: run.message })}
              busy={busy && expanded === currentStage}
            >
              {candidates.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <p className="m-0 text-sm text-fg-1" data-testid={`stage-note-${expanded}`}>
                    {candidates.length === 1
                      ? "1 moment found."
                      : `${String(candidates.length)} moments found.`}
                    {/* A stopped run makes no new clips; it only keeps what it made. */}
                    {activity === "stopped" ? "" : " Create a vertical 9:16 clip from any of them."}
                  </p>

                  <ul
                    className="m-0 flex list-none flex-col gap-3 p-0"
                    data-testid="candidates-list"
                  >
                    {candidates.map((cand: RepurposeCandidateItem) => {
                      const clip = clips.find(
                        (entry: RepurposeClipItem) => entry.candidateId === cand.id,
                      );
                      return (
                        <CandidateCard
                          key={cand.id}
                          runId={runId}
                          candidate={cand}
                          clip={clip}
                          previewActive={clip !== undefined && activePreview === clip.id}
                          onActivatePreview={() => {
                            if (clip !== undefined) setActivePreview(clip.id);
                          }}
                          runStopped={activity === "stopped"}
                        />
                      );
                    })}
                  </ul>
                </div>
              ) : emptyNote === null ? (
                <p className="m-0 text-sm text-fg-2" data-testid={`stage-note-${expanded}`}>
                  {/* eslint-disable-next-line security/detect-object-injection -- bounded stage index */}
                  {STAGE_WAITING_NOTE[expanded]}
                </p>
              ) : (
                <p
                  className="m-0 text-sm text-fg-1"
                  data-testid={emptyNote.testId}
                  {...(emptyNote.testId === "candidates-error"
                    ? { role: "alert" }
                    : emptyNote.testId === "candidates-loading"
                      ? { role: "status" }
                      : {})}
                >
                  {emptyNote.text}
                </p>
              )}

              {momentsVisible && (
                <div ref={momentFormRef} className="mt-4">
                  <AddMomentForm
                    runId={run.id}
                    durationMs={sourceDurationMs}
                    available={momentsAllowed}
                    open={momentFormOpen}
                    onOpenChange={setMomentFormOpened}
                  />
                </div>
              )}

              <RunActionBar
                className="mt-4"
                note={
                  run.canCancel
                    ? "Nothing is posted anywhere without your confirmation."
                    : failed
                      ? "Nothing further will be spent unless you try again."
                      : "This run has finished; nothing further will be spent."
                }
                {...(run.canCancel
                  ? {
                      secondary: {
                        label: cancel.isPending ? "Stopping…" : "Stop this run",
                        disabled: cancel.isPending,
                        testId: "run-cancel",
                        // A stopped run cannot be started again: it asks first.
                        // What it says is what the API does — the download,
                        // transcript and discovery stop; a cut already under
                        // way finishes; a clip waiting for a slot never starts.
                        confirm: {
                          title: "Stop this run?",
                          description:
                            "Getting the video and finding moments stop, and this run cannot be started again. Clips already being cut still finish and stay, like the ones already made; clips still waiting for a slot are not made.",
                          confirmLabel: "Stop this run",
                          testId: "run-cancel-confirm",
                        },
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
