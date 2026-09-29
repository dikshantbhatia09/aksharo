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
 *
 * Plan limits (2026-09-27) added three more. A plan limits the minutes a run
 * processes, so a long video's run says which part it processed and offers
 * the next part as a new run. A refusal carries its numbers ("This video is
 * 34:37. Your plan processes 20:00 per video.") and a too-long link offers a
 * part of it rather than only another video. And the run is titled by the
 * video's real title, not "youtube.com · <id>".
 *
 * Clip review (2026-10-03) reads the run's review once for the page
 * (`useRunReview`, polled so a client's decision shows up) and hands each
 * card its clip's part; "Share for review" sits beside "Post one a day".
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  isApiError,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  type RepurposeCompilationShape,
  useCancelRepurposeRun,
  useEntitlement,
  useNextWindow,
  useRepurposeCandidates,
  useRepurposeClips,
  useRepurposeDubs,
  useRepurposePreview,
  useRepurposeRun,
  useRepurposeSeries,
  useRetryRepurposeRun,
} from "@montaj/api-client";
import { Button, PageHeader, Skeleton } from "@montaj/ui";

import type { StageKey } from "@/components/repurpose/copy";

import { AddMomentForm } from "@/components/repurpose/AddMomentForm";
import { CandidateCard } from "@/components/repurpose/CandidateCard";
import { CompilationBuilder, type BuilderMode } from "@/components/repurpose/CompilationBuilder";
import {
  COMPILATION_LIMITS,
  SERIES_LIMITS,
  pickableClips,
  seriesClips,
} from "@/components/repurpose/compilations";
import { CompilationsPanel } from "@/components/repurpose/CompilationsPanel";
import { AUTOPILOT_COPY, CLIP_STATE_COPY } from "@/components/repurpose/copy";
import { EpisodePackPanel } from "@/components/repurpose/EpisodePackPanel";
import { RunPublishing } from "@/components/repurpose/publishing/RunPublishing";
import { describeRefusal, type Refusal } from "@/components/repurpose/refusal";
import { ShareForReview } from "@/components/repurpose/review/ShareForReview";
import { useRunReview } from "@/components/repurpose/review/use-review";
import { canAddMoments, runActivity, serverIsWorking } from "@/components/repurpose/run-activity";
import {
  linkFromSourceDisplay,
  newRunHref,
  recallRunSetup,
  rememberRunSetup,
} from "@/components/repurpose/run-setup";
import {
  nextWindowOffer,
  retryWindowOf,
  runFailureDetail,
  runTitle,
  runWindowOf,
  windowPhase,
  windowSummary,
} from "@/components/repurpose/run-window";
import { PersistentPreview, RunActionBar } from "@/components/repurpose/RunActionBar";
import { RunActivityLine } from "@/components/repurpose/RunActivityLine";
import { RunStageRail } from "@/components/repurpose/RunStageRail";
import { SourceUploadOffer } from "@/components/repurpose/SourceUploadOffer";
import { StageErrorCard, StagePanel } from "@/components/repurpose/StagePanel";
import { isRemovedCandidate, steeringSummary } from "@/components/repurpose/steering";

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
  const nextWindow = useNextWindow();
  // The plan's window, for how much "Process the next …" promises. Unknown
  // until it loads (or on an API older than windows), when this run's own
  // part stands in for it.
  const entitlement = useEntitlement();
  const planWindowMs = Number(entitlement.data?.entitlements["clipsWindowMs"]);
  const [nextWindowError, setNextWindowError] = React.useState<Refusal | null>(null);
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
  // Each clip's review, once there are clips to review (2026-10-03).
  const reviewQuery = useRunReview(runId, (clipsQuery.data?.clips.length ?? 0) > 0);
  // Dubbing (2026-10-04): the run's dubs and what each clip can be dubbed into,
  // read once for the page and handed to each card, like its review.
  const dubsQuery = useRepurposeDubs(runId, {
    enabled: (clipsQuery.data?.clips.length ?? 0) > 0,
  });
  // A review notification links to its clip (`#clip-<id>`), which only exists
  // once the clips have loaded - after the browser's own jump has come and gone.
  const jumpedToClip = React.useRef(false);
  const clipCount = clipsQuery.data?.clips.length ?? 0;
  React.useEffect(() => {
    if (jumpedToClip.current || clipCount === 0) return;
    const hash = window.location.hash;
    if (!hash.startsWith("#clip-")) return;
    const card = document.getElementById(hash.slice(1));
    if (card === null) return;
    jumpedToClip.current = true;
    card.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [clipCount]);
  const [openStage, setOpenStage] = React.useState<StageKey | null>(null);
  const [blockedNote, setBlockedNote] = React.useState<string | null>(null);
  const [retryError, setRetryError] = React.useState<Refusal | null>(null);
  // The one clip whose preview holds a live caption stage (`ClipPreview`).
  const [activePreview, setActivePreview] = React.useState<string | null>(null);
  const [momentFormOpened, setMomentFormOpened] = React.useState(false);
  const momentFormRef = React.useRef<HTMLDivElement>(null);
  // Compilations and series (2026-10-03): picking clips on their cards.
  const [building, setBuilding] = React.useState(false);
  const [builderMode, setBuilderMode] = React.useState<BuilderMode>("compilation");
  const [shape, setShape] = React.useState<RepurposeCompilationShape>("9:16");
  const [picked, setPicked] = React.useState<string[]>([]);
  const builderRef = React.useRef<HTMLDivElement>(null);
  const seriesQuery = useRepurposeSeries(runId);

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
  // is waiting for the person or for its upload, and not on one that stopped.
  // The same rule as Home's banner (`serverIsWorking`).
  const busy = serverIsWorking(run);
  // The step under way (absent from an API older than it, and null once the
  // run has stopped or is past its clips).
  const stepActivity =
    failed || run.activity === undefined || run.activity === null || run.activity.step === "done"
      ? null
      : run.activity;

  const stageIndex = run.stages.findIndex((entry) => entry.stage === expanded);
  const candidates = candidatesQuery.data?.candidates ?? [];
  // Moments the person removed stay listed, folded, for "Restore"; they are
  // not counted as found (steering, 2026-09-29).
  const keptCount = candidates.filter((cand) => !isRemovedCandidate(cand)).length;
  const steeringLine = steeringSummary(run.steering);
  const clips = clipsQuery.data?.clips ?? [];
  const momentsAllowed = canAddMoments(run);
  // While picking: the clips that can be ticked for what is being made.
  const pickableFor = (
    mode: BuilderMode,
    forShape: RepurposeCompilationShape,
  ): ReadonlySet<string> =>
    mode === "series"
      ? seriesClips(clips, candidates)
      : new Set(pickableClips(clips, candidates, forShape).map((clip) => clip.clipId));
  const pickable = building ? pickableFor(builderMode, shape) : null;
  const togglePick = (clipId: string): void => {
    const most = builderMode === "series" ? SERIES_LIMITS.maxClips : COMPILATION_LIMITS.maxClips;
    setPicked((current) =>
      current.includes(clipId)
        ? current.filter((entry) => entry !== clipId)
        : current.length >= most
          ? current
          : [...current, clipId],
    );
  };
  const openBuilder = (): void => {
    setBuilding(true);
    window.requestAnimationFrame(() => {
      builderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  // "Part 2 of 4" on each clip of a series.
  const seriesPartOf = new Map<string, string>();
  for (const entry of seriesQuery.data?.series ?? []) {
    for (const part of entry.parts) {
      seriesPartOf.set(part.clipId, `Part ${String(part.part)} of ${String(entry.parts.length)}`);
    }
  }
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
  // The link this run came from: as this browser remembered it, else read
  // back from the run's own display (a run started in another browser, or
  // before setups were remembered). An upload has none, and neither does a
  // link run whose display names no video.
  const link =
    run.sourceKind === "upload"
      ? undefined
      : (setup?.link ?? linkFromSourceDisplay(run.sourceDisplay));
  // The same link and setup in a fresh run: to correct the link ("Check the
  // link"), or as it is ("Start again with this video"). With no link to carry
  // it would open an empty form under a button that promised this video, so
  // those buttons are not offered and the card falls back to another video.
  const sameLinkHref = link === undefined ? undefined : newRunHref(setup, { keepLink: true, link });
  const chooseAnother = (): void => {
    // An upload run's way out is most likely another file, so the form opens
    // on its upload tab.
    router.push(newRunHref(setup, { keepLink: false, upload: run.sourceKind === "upload" }));
  };
  const sameLinkAgain = (): void => {
    if (sameLinkHref !== undefined) router.push(sameLinkHref);
  };
  // A clip whose original is no longer kept can only be cut in a new run of
  // the same video: the link again, or for an upload, the file again.
  //
  // Not while a link run is still open: the API allows one open run per link
  // (`duplicateOf` skips only published, failed and stopped runs), so the new
  // run would be refused with "Open the existing run" — this one. The card
  // then says to stop this run first (or, once it cannot be stopped, to wait
  // for it to finish); after that it offers the new run. An upload has no
  // link to collide on.
  const linkRunOpen =
    run.sourceKind !== "upload" && (activity === "working" || activity === "needs_you");
  const clipStartAgain =
    run.sourceKind === "upload"
      ? {
          href: newRunHref(setup, { keepLink: false, upload: true }),
          label: "Upload the video again",
        }
      : sameLinkHref === undefined || linkRunOpen
        ? undefined
        : { href: sameLinkHref, label: "Start again from the link" };
  const clipStartAgainNote =
    sameLinkHref === undefined || !linkRunOpen
      ? undefined
      : run.canCancel
        ? CLIP_STATE_COPY.sourceGoneStopFirst
        : CLIP_STATE_COPY.sourceGoneRunOpen;
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

  // The numbers behind a refusal, and the part of the video this run
  // processed (both absent on an API older than 2026-09-27).
  const failureDetail = runFailureDetail(run);
  const processed = runWindowOf(run);
  const nextOffer = nextWindowOffer(
    run,
    Number.isFinite(planWindowMs) && planWindowMs > 0 ? planWindowMs : undefined,
  );
  // A too-long link's "Pick where to start": a fresh run of the same link and
  // setup, the cursor in "Start at", and the length so a start past the end is
  // caught at the field. An upload has no window to pick.
  const pickStartHref =
    link === undefined
      ? undefined
      : newRunHref(setup, {
          keepLink: true,
          link,
          pickStart: true,
          ...(failureDetail?.durationMs === undefined
            ? {}
            : { lengthMs: failureDetail.durationMs }),
        });
  const processNextWindow = (): void => {
    setNextWindowError(null);
    nextWindow.mutate(run.id, {
      onSuccess: (created) => {
        // The next part keeps this run's setup, so its own failure card can
        // offer it back, with the start the server gave it: where this part
        // ended (`nextWindow` in the API). Its card then says a retry fetches
        // from there, which it does, rather than "the most-replayed part".
        if (setup !== undefined) {
          const { startMs: _startMs, ...carried } = setup;
          rememberRunSetup(
            created.id,
            processed === null ? carried : { ...carried, startMs: processed.endMs },
          );
        }
        router.push(`/repurpose/${created.id}`);
      },
      onError: (error) => {
        setNextWindowError(describeRefusal(error, "nextWindow"));
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
            // The video's real title when the API has it; the full text on
            // hover, since a long one is truncated to one line.
            <span className="block truncate" title={runTitle(run)} data-testid="run-title">
              {runTitle(run)}
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

        {run.automation === "auto" && activity !== "stopped" ? (
          <p className="m-0 text-sm text-fg-2" data-testid="run-autopilot">
            {AUTOPILOT_COPY.runOn}
          </p>
        ) : null}

        {/* How the run was steered: "About: money habits · Short clips". */}
        {steeringLine === null ? null : (
          <p className="m-0 text-sm text-fg-2" data-testid="run-steering">
            {steeringLine}
          </p>
        )}

        {processed === null ? null : (
          // Which part of the video this run is about, so "20 moments" reads
          // against 20 minutes of a 3-hour podcast, and the way to the next part.
          <div className="flex flex-col gap-2" data-testid="run-window">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="m-0 text-sm text-fg-1" data-testid="run-window-summary">
                {windowSummary(processed, windowPhase(run))}
              </p>
              {nextOffer === null ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={nextWindow.isPending}
                  onClick={processNextWindow}
                  data-testid="run-next-window"
                >
                  {nextWindow.isPending ? "Starting…" : nextOffer.label}
                </Button>
              )}
            </div>
            {nextWindowError === null ? null : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p
                  className="m-0 text-sm text-fg-1"
                  role="alert"
                  data-testid="run-next-window-error"
                >
                  {nextWindowError.text}
                </p>
                {nextWindowError.existingRunId === undefined ||
                nextWindowError.existingRunId === run.id ? null : (
                  <Button variant="secondary" size="sm" asChild>
                    <Link
                      href={`/repurpose/${nextWindowError.existingRunId}`}
                      className="no-underline"
                      data-testid="run-next-window-existing"
                    >
                      Open the existing run
                    </Link>
                  </Button>
                )}
                {nextWindowError.seeCredits === true ? (
                  <Button variant="secondary" size="sm" asChild>
                    <Link
                      href="/billing"
                      className="no-underline"
                      data-testid="run-next-window-credits"
                    >
                      See your credits
                    </Link>
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        )}

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
              detail={failureDetail}
              // Too long: the most-replayed part is a retry the server windows
              // (only a link can be windowed, and only if it can be retried);
              // a start of their own is a fresh run of the same link.
              {...(run.canRetry && run.sourceKind !== "upload" ? { onUseWindow: tryAgain } : {})}
              // Which part that retry fetches, so its label does not promise
              // the most-replayed part to a run that asked for its own start.
              retryWindow={retryWindowOf(run, setup)}
              {...(pickStartHref === undefined
                ? {}
                : {
                    onPickStart: () => {
                      router.push(pickStartHref);
                    },
                  })}
              retrying={retry.isPending}
              retryError={retryError?.text ?? null}
              retrySeeCredits={retryError?.seeCredits === true}
              existingRunId={retryError?.existingRunId ?? null}
              // `canRetry` is false when the API knows the retry would only be
              // refused (a deleted source, an upload it could not read): the
              // card then leads with its way out rather than a dead button.
              {...(run.canRetry ? { onRetry: tryAgain } : {})}
              onChooseAnother={chooseAnother}
              // Only a link can be checked or started again; an upload (or a
              // run whose link cannot be recovered) has none to pre-fill, so its
              // card offers another video instead.
              {...(sameLinkHref === undefined
                ? {}
                : { onCheckLink: sameLinkAgain, onStartAgain: sameLinkAgain })}
              {...(momentsAllowed ? { onAddMoment: openMomentForm } : {})}
            />
          )}

          {/* Waiting for YouTube, or a download a copy of the file gets round:
              the file can go up into this same run (Wave B). */}
          <SourceUploadOffer run={run} />

          {showPanel && (
            <StagePanel
              stage={expanded}
              index={stageIndex < 0 ? undefined : stageIndex + 1}
              // eslint-disable-next-line security/detect-object-injection -- bounded stage index
              note={run.stages[stageIndex]?.label}
              // A failed run's card already says what happened.
              {...(failed ? {} : { message: run.message })}
              // The step under way, in numbers, on the stage it belongs to. Not
              // once it is all done: the stage's sentence says that already.
              {...(stepActivity === null || expanded !== currentStage
                ? {}
                : { progress: <RunActivityLine activity={stepActivity} /> })}
              busy={busy && expanded === currentStage}
            >
              {candidates.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <p className="m-0 text-sm text-fg-1" data-testid={`stage-note-${expanded}`}>
                    {keptCount === 1 ? "1 moment found." : `${String(keptCount)} moments found.`}
                    {/* A stopped run makes no new clips; it only keeps what it made. */}
                    {activity === "stopped"
                      ? ""
                      : run.automation === "auto"
                        ? AUTOPILOT_COPY.cutting
                        : " Create a vertical 9:16 clip from any of them."}
                  </p>

                  {/* "Post one a day" (2026-09-29): nothing while posting is switched off.
                      "Share for review" (2026-10-03): nothing while public links are. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <RunPublishing
                      runId={runId}
                      clips={clips}
                      candidates={candidates}
                      {...(reviewQuery.data === undefined || reviewQuery.data === null
                        ? {}
                        : { review: reviewQuery.data })}
                    />
                    {clips.length === 0 ? null : (
                      <ShareForReview runId={runId} permissions={reviewQuery.data?.permissions} />
                    )}
                  </div>

                  {building ? (
                    <div ref={builderRef} className="scroll-mt-4">
                      <CompilationBuilder
                        runId={runId}
                        clips={clips}
                        candidates={candidates}
                        mode={builderMode}
                        onModeChange={(next) => {
                          setBuilderMode(next);
                          const allowed = pickableFor(next, shape);
                          setPicked((current) => current.filter((entry) => allowed.has(entry)));
                        }}
                        shape={shape}
                        onShapeChange={(next) => {
                          setShape(next);
                          const allowed = pickableFor(builderMode, next);
                          setPicked((current) => current.filter((entry) => allowed.has(entry)));
                        }}
                        picked={picked}
                        onPickedChange={setPicked}
                        onClose={() => {
                          setBuilding(false);
                        }}
                      />
                    </div>
                  ) : null}

                  <ul
                    className="m-0 flex list-none flex-col gap-3 p-0"
                    data-testid="candidates-list"
                  >
                    {candidates.map((cand: RepurposeCandidateItem) => {
                      const clip = clips.find(
                        (entry: RepurposeClipItem) => entry.candidateId === cand.id,
                      );
                      const canPick = clip !== undefined && pickable?.has(clip.id) === true;
                      const isPicked = clip !== undefined && picked.includes(clip.id);
                      const part = clip === undefined ? undefined : seriesPartOf.get(clip.id);
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
                          autopilot={run.automation === "auto"}
                          {...(reviewQuery.data === undefined || reviewQuery.data === null
                            ? {}
                            : {
                                reviewPermissions: reviewQuery.data.permissions,
                                needsApproval: reviewQuery.data.needsApproval,
                                ...(clip === undefined
                                  ? {}
                                  : {
                                      review: reviewQuery.data.clips.find(
                                        (entry) => entry.clipId === clip.id,
                                      ),
                                    }),
                              })}
                          {...(clipStartAgain === undefined ? {} : { startAgain: clipStartAgain })}
                          {...(clipStartAgainNote === undefined
                            ? {}
                            : { startAgainNote: clipStartAgainNote })}
                          {...(pickable === null || clip === undefined
                            ? {}
                            : {
                                select: {
                                  checked: isPicked,
                                  disabled: !canPick && !isPicked,
                                  // Only a made clip that cannot be picked needs saying why.
                                  ...(canPick || clip.state !== "ready"
                                    ? {}
                                    : {
                                        note:
                                          builderMode === "series"
                                            ? "This clip cannot be part of a series."
                                            : `No captioned ${shape} video of this clip yet.`,
                                      }),
                                  onToggle: () => {
                                    togglePick(clip.id);
                                  },
                                },
                              })}
                          {...(part === undefined ? {} : { seriesPart: part })}
                          {...(dubsQuery.data === undefined ? {} : { dubs: dubsQuery.data })}
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
                      ? // No "unless you try again" on a run that cannot be.
                        run.canRetry
                        ? "Nothing further will be spent unless you try again."
                        : "Nothing further will be spent on this run."
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

          {/* A run's clips joined into one video, and its series (2026-10-03). */}
          <CompilationsPanel
            runId={runId}
            clips={clips}
            candidates={candidates}
            building={building}
            onBuild={openBuilder}
          />

          {/* The text for the whole video, beside its clips (2026-09-29). */}
          <EpisodePackPanel run={run} />
        </div>
      </div>

      <PersistentPreview run={run} />
    </div>
  );
}
