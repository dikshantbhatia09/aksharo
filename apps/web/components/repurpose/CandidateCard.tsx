"use client";

/**
 * One suggested (or hand-picked) moment on the run page, and its clip.
 *
 * The clip's row follows the clip's own state (`GET .../clips`, clips
 * hardening 2026-09-26), never the run's:
 *
 *   * none yet  → "Create 9:16 clip";
 *   * waiting   → the plan's lane is full; it starts by itself, so no button;
 *   * cutting   → a spinner;
 *   * ready     → open it in the editor, download it, preview it;
 *   * failed    → what went wrong and "Try again", for this clip only.
 *
 * Before this, a clip refused at admission or failed in the cut sat on
 * "Cutting the 9:16 clip…" for ever with no way to try again, and a refused
 * create said nothing at all. Each card owns its own create and retry, so an
 * error is shown next to the moment it belongs to.
 *
 * On a stopped run (`runStopped`) nothing new starts: the API refuses every
 * create and retry, and never enqueues a waiting clip. So the card offers
 * neither, and a waiting clip says it was not made rather than promising a
 * slot that will never come. A cut already in flight is left to finish.
 */
import { AlertTriangle, CircleSlash, Clock, Download, Loader2 } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  clipCopyOf,
  useCreateRepurposeClip,
  useRetryRepurposeClip,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  type RepurposeClipState,
} from "@montaj/api-client";
import { Badge, Button, Checkbox } from "@montaj/ui";

import { ClipControls, RemovedMoment } from "@/components/repurpose/ClipControls";
import { ClipCopyPanel } from "@/components/repurpose/ClipCopyPanel";
import { ClipFormats } from "@/components/repurpose/ClipFormats";
import { ClipLayoutControl } from "@/components/repurpose/ClipLayoutControl";
import { ClipPreview } from "@/components/repurpose/ClipPreview";
import { CAPTIONED_COPY, CLIP_STATE_COPY, clipFailureCopy } from "@/components/repurpose/copy";
import { formatClock } from "@/components/repurpose/moment-time";
import { ClipPosts } from "@/components/repurpose/publishing/ClipPosts";
import { describeRefusal } from "@/components/repurpose/refusal";
import { isRemovedCandidate } from "@/components/repurpose/steering";
import { useStableUrl } from "@/components/repurpose/use-stable-url";

const CLIP_STATES: ReadonlySet<string> = new Set(["waiting", "cutting", "ready", "failed"]);

/**
 * Where the captioned video's resting frame is taken from: a clip starts half a
 * second before its first word, so a moment in, the first caption is on screen.
 */
export const CAPTIONED_POSTER_S = 1.2;

/**
 * An Autopilot clip's finished video, captions burned in (2026-09-28). Resting,
 * it shows a frame {@link CAPTIONED_POSTER_S} in, so the captions are visible
 * before anyone presses play; the first play starts from the beginning.
 */
function CaptionedVideo({
  src,
  label,
  testId,
}: {
  readonly src: string;
  readonly label: string;
  readonly testId: string;
}): React.JSX.Element {
  const played = React.useRef(false);
  return (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      aria-label={label}
      className="clip-preview aspect-[9/16] w-full object-cover"
      data-testid={testId}
      data-preview="captioned"
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        if (!played.current && Number.isFinite(video.duration)) {
          video.currentTime = Math.min(CAPTIONED_POSTER_S, video.duration / 2);
        }
      }}
      onPlay={(event) => {
        if (played.current) return;
        played.current = true;
        event.currentTarget.currentTime = 0;
      }}
    />
  );
}

/**
 * A clip's state, from the API's `state` when it sends one. An API from before
 * that field only knows whether the mezzanine exists.
 */
export function clipStateOf(clip: RepurposeClipItem): RepurposeClipState {
  if (clip.state !== undefined && CLIP_STATES.has(clip.state)) return clip.state;
  return (clip.mezzanineKey ?? clip.mezzanineUrl ?? null) === null ? "cutting" : "ready";
}

export interface CandidateCardProps {
  readonly runId: string;
  readonly candidate: RepurposeCandidateItem;
  readonly clip: RepurposeClipItem | undefined;
  /** Whether this card's clip holds the page's one live preview stage. */
  readonly previewActive: boolean;
  readonly onActivatePreview: () => void;
  /** The run was cancelled: nothing new can be cut from it. */
  readonly runStopped?: boolean;
  /**
   * Where a new run of the same video starts (the link, or for an upload the
   * file, with the setup kept), for a clip whose original is no longer kept.
   * The run page works it out, because only the run knows its source: this
   * card used to build it from this browser's memory alone, and for a run it
   * never saw that opened an empty form under "Start again from the link".
   * Left out when there is nothing to start again from; the card then offers
   * only its sentence.
   */
  readonly startAgain?: { readonly href: string; readonly label: string };
  /**
   * Why a new run of the same video cannot start yet, said in place of the
   * reassurance when the original is gone and `startAgain` is left out: a link
   * run that is still open blocks a new run of its own link, so the card says
   * what unblocks it rather than "start again" with no button to do it.
   */
  readonly startAgainNote?: string;
  /**
   * Picking clips for a compilation or a series (2026-10-03): the card shows a
   * tick box. `disabled` when this clip cannot be picked for what is being
   * made (no captioned video in the shape yet); `note` says why.
   */
  readonly select?: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly note?: string;
    readonly onToggle: () => void;
  };
  /** "Part 2 of 4" when the clip is in a series (2026-10-03). */
  readonly seriesPart?: string;
}

export function CandidateCard({
  runId,
  candidate,
  clip: listedClip,
  previewActive,
  onActivatePreview,
  runStopped = false,
  startAgain,
  startAgainNote,
  select,
  seriesPart,
}: CandidateCardProps): React.JSX.Element {
  const createClip = useCreateRepurposeClip();
  const retryClip = useRetryRepurposeClip();
  // Between the create answering and the list catching up, the clip the create
  // returned stands in for the row. The card used to hold "Starting…" until the
  // list showed it — for good, if the list's next fetch failed or lagged.
  const created =
    createClip.data !== undefined && typeof createClip.data.id === "string"
      ? createClip.data
      : undefined;
  const clip = listedClip ?? created;
  const state = clip === undefined ? undefined : clipStateOf(clip);
  const checksum =
    typeof clip?.["mezzanineChecksum"] === "string" ? clip["mezzanineChecksum"] : undefined;
  // The list is polled while any clip is cutting, and every poll presigns
  // afresh; a playing preview must not restart because of it.
  const videoUrl = useStableUrl(clip?.mezzanineUrl ?? undefined, checksum);
  // An Autopilot clip's finished, captioned video: a new render is a new file
  // (a new key), which is what replaces the one held here.
  const captioned = clip?.captioned ?? null;
  const captionedUrl = useStableUrl(captioned?.playUrl ?? undefined);
  const captionedDownload = captioned?.downloadUrl ?? undefined;
  const captionedNote =
    captioned === null
      ? null
      : captioned.status === "failed"
        ? CAPTIONED_COPY.failed
        : captioned.status === "finishing"
          ? CAPTIONED_COPY.finishing
          : captioned.status === "rendering" || captioned.status === "stale"
            ? captionedUrl === undefined
              ? CAPTIONED_COPY.adding
              : CAPTIONED_COPY.updating
            : null;

  // Never invent a score: a candidate without one shows none.
  const score = candidate.potentialScore ?? candidate.score;
  // The words to post it with (2026-09-29): the clip's own once it has them,
  // else its moment's. Their title is the one a person would post.
  const copy = clipCopyOf(clip?.copy) ?? clipCopyOf(candidate.copy);
  const title = copy?.title ?? candidate.title ?? candidate.headline ?? "Suggested moment";
  const picked = candidate["source"] === "manual";
  // The clip's own project: where its captions live and are exported. The
  // 9:16 one: an Autopilot clip has a project per shape (2026-09-29).
  const clipProjectId = (
    clip?.variants?.find((variant) => variant.aspect === "r9x16") ?? clip?.variants?.[0]
  )?.projectId;
  const creating = createClip.isPending;
  // A stopped run's card offers neither, so a refusal from before the page saw
  // the stop (another tab) has nothing left to explain.
  const createError =
    createClip.isError && !runStopped ? describeRefusal(createClip.error, "clip").text : null;
  const retryError =
    retryClip.isError && !runStopped ? describeRefusal(retryClip.error, "clip").text : null;
  const failure = state === "failed" ? clipFailureCopy(clip?.failureCode) : null;
  // Waiting on a stopped run: the API never enqueues it now.
  const stoppedWaiting = runStopped && state === "waiting";

  // Removed by the person (steering): one line, with "Restore".
  if (isRemovedCandidate(candidate)) {
    return <RemovedMoment runId={runId} candidate={candidate} title={title} />;
  }

  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border bg-bg-0 p-4"
      data-testid={`candidate-card-${candidate.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {select === undefined ? null : (
          <div className="flex shrink-0 items-center pt-0.5">
            <Checkbox
              checked={select.checked}
              disabled={select.disabled}
              aria-label={`Pick this clip: ${title}`}
              onCheckedChange={() => {
                select.onToggle();
              }}
              data-testid={`pick-clip-${candidate.id}`}
            />
          </div>
        )}
        <div className="min-w-0 flex-[1_1_240px]">
          <div className="flex flex-wrap items-center gap-2">
            {score === undefined || score === null ? null : (
              <Badge tone="neutral">Potential {String(score)}%</Badge>
            )}
            {picked ? <Badge tone="neutral">Your pick</Badge> : null}
            {seriesPart === undefined ? null : (
              <Badge tone="neutral" data-testid={`series-part-${candidate.id}`}>
                {seriesPart}
              </Badge>
            )}
            <span className="font-mono text-2xs text-fg-2">
              {formatClock(candidate.startMs)} – {formatClock(candidate.endMs)} (
              {String(Math.round((candidate.endMs - candidate.startMs) / 1000))}s)
            </span>
          </div>
          <h3 className="mt-1.5 text-sm font-semibold text-fg-0">{title}</h3>
          {(candidate.transcriptExcerpt || candidate.reason) && (
            <p className="mt-1 line-clamp-2 text-sm text-fg-2">
              {candidate.transcriptExcerpt ?? candidate.reason}
            </p>
          )}
          {select?.note === undefined ? null : (
            <p className="m-0 mt-1 text-xs text-fg-2" data-testid={`pick-note-${candidate.id}`}>
              {select.note}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {clip === undefined && runStopped ? null : clip === undefined ? (
            // Secondary, not primary: a list of candidates would otherwise put
            // a rani button on every row.
            <Button
              variant="secondary"
              size="sm"
              disabled={creating}
              aria-label={creating ? undefined : `Create 9:16 clip: ${title}`}
              onClick={() => {
                createClip.mutate({ runId, candidateId: candidate.id, aspect: "r9x16" });
              }}
              data-testid={`create-clip-${candidate.id}`}
            >
              {creating ? "Starting…" : "Create 9:16 clip"}
            </Button>
          ) : state === "ready" ? (
            <>
              {/* The captioned video is an export from the clip's own project;
                  the download is the clean picture it starts from. */}
              {clipProjectId === undefined ? null : (
                <Button variant="secondary" size="sm" asChild>
                  <Link
                    href={`/p/${clipProjectId}`}
                    className="no-underline"
                    aria-label={`Open in editor: ${title}`}
                    data-testid={`open-clip-${candidate.id}`}
                  >
                    Open in editor
                  </Link>
                </Button>
              )}
              {captionedDownload === undefined ? null : (
                <Button variant="ghost" size="sm" asChild>
                  <a
                    href={captionedDownload}
                    download
                    className="no-underline"
                    aria-label={`Download video with captions: ${title}`}
                    data-testid={`download-captioned-${candidate.id}`}
                  >
                    <Download strokeWidth={1.75} aria-hidden="true" />
                    {CAPTIONED_COPY.download}
                  </a>
                </Button>
              )}
              {videoUrl === undefined || captionedDownload !== undefined ? null : (
                <Button variant="ghost" size="sm" asChild>
                  <a
                    href={videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={`clip-${candidate.id}.mp4`}
                    className="no-underline"
                    title="The 9:16 video without captions. Export from the editor for a captioned one."
                    aria-label={`Download video without captions: ${title}`}
                    data-testid={`download-clip-${candidate.id}`}
                  >
                    <Download strokeWidth={1.75} aria-hidden="true" />
                    Download video
                  </a>
                </Button>
              )}
            </>
          ) : state === "failed" ? null : stoppedWaiting ? (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-fg-1"
              data-testid={`clip-state-${candidate.id}`}
              data-state="stopped"
            >
              <CircleSlash className="size-4 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
              {CLIP_STATE_COPY.stopped}
            </span>
          ) : (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-xs text-fg-1"
              data-testid={`clip-state-${candidate.id}`}
              data-state={state}
            >
              {state === "waiting" ? (
                <Clock className="size-4 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Loader2
                  className="size-4 animate-spin text-fg-2"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              )}
              {state === "waiting" ? CLIP_STATE_COPY.waiting : CLIP_STATE_COPY.cutting}
            </span>
          )}
        </div>
      </div>

      {createError === null || clip !== undefined ? null : (
        <p
          role="alert"
          className="m-0 text-sm text-rejected"
          data-testid={`create-clip-error-${candidate.id}`}
        >
          {createError}
        </p>
      )}

      {failure === null || clip === undefined ? null : (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
          data-testid={`clip-state-${candidate.id}`}
          data-state="failed"
        >
          <p className="m-0 flex min-w-0 flex-[1_1_240px] items-start gap-2 text-sm">
            {/* Icon plus words, so the state does not depend on colour (§13.3). */}
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-rejected"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span>
              <span className="text-fg-0">{failure.title}.</span>{" "}
              <span className="text-fg-2">
                {runStopped && failure.retryable
                  ? CLIP_STATE_COPY.stoppedFailed
                  : failure.startAgain === true &&
                      startAgain === undefined &&
                      startAgainNote !== undefined
                    ? startAgainNote
                    : failure.reassurance}
              </span>
            </span>
          </p>
          {runStopped && failure.retryable ? null : failure.retryable ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={retryClip.isPending}
              aria-label={retryClip.isPending ? undefined : `Try this clip again: ${title}`}
              onClick={() => {
                retryClip.mutate({ runId, clipId: clip.id });
              }}
              data-testid={`retry-clip-${candidate.id}`}
            >
              {retryClip.isPending ? "Trying again…" : "Try again"}
            </Button>
          ) : failure.startAgain === true && startAgain !== undefined ? (
            // The original is gone, so a retry would only be refused: the way
            // forward is a new run of the same video, with the setup kept.
            <Button variant="secondary" size="sm" asChild>
              <Link
                href={startAgain.href}
                className="no-underline"
                data-testid={`restart-clip-${candidate.id}`}
              >
                {startAgain.label}
              </Link>
            </Button>
          ) : // No retry and no new run that would help (a clip that came out too
          // large would come out the same): the sentence says what will.
          null}
          {retryError === null ? null : (
            <p
              role="alert"
              className="m-0 w-full text-sm text-rejected"
              data-testid={`retry-clip-error-${candidate.id}`}
            >
              {retryError}
            </p>
          )}
        </div>
      )}

      {state === "ready" && videoUrl === undefined ? (
        <p className="m-0 text-xs text-fg-2" data-testid={`clip-unavailable-${candidate.id}`}>
          {CLIP_STATE_COPY.unavailable}
        </p>
      ) : null}

      {state === "ready" && captionedNote !== null ? (
        <p
          role="status"
          className="m-0 inline-flex items-center gap-1.5 text-xs text-fg-2"
          data-testid={`captioned-state-${candidate.id}`}
          data-state={captioned?.status}
        >
          {captioned?.status === "failed" ? (
            <AlertTriangle className="size-4 text-rejected" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
          )}
          {captionedNote}
        </p>
      ) : null}

      {state === "ready" && captionedUrl !== undefined ? (
        <div className="max-w-[220px] overflow-hidden rounded-sm border border-border bg-ink">
          <CaptionedVideo
            src={captionedUrl}
            label={`${title}, 9:16 clip with captions`}
            testId={`clip-video-${candidate.id}`}
          />
        </div>
      ) : null}

      {state === "ready" && captionedUrl === undefined && videoUrl !== undefined && (
        <div className="max-w-[220px] overflow-hidden rounded-sm border border-border bg-ink">
          <ClipPreview
            videoUrl={videoUrl}
            projectId={clipProjectId}
            label={`${title}, 9:16 clip`}
            testId={`clip-video-${candidate.id}`}
            active={previewActive}
            onActivate={onActivatePreview}
          />
        </div>
      )}

      {state === "ready" && captionedDownload !== undefined && videoUrl !== undefined ? (
        <a
          href={videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={`clip-${candidate.id}.mp4`}
          className="w-fit text-xs text-fg-2"
          aria-label={`Download video without captions: ${title}`}
          data-testid={`download-clip-${candidate.id}`}
        >
          {CAPTIONED_COPY.withoutCaptions}
        </a>
      ) : null}

      {state === "ready" && clip !== undefined && (clip.formats?.length ?? 0) > 0 ? (
        <ClipFormats
          candidateId={candidate.id}
          title={title}
          durationMs={candidate.endMs - candidate.startMs}
          formats={clip.formats ?? []}
          images={clip.images}
        />
      ) : null}

      {copy === null ? null : (
        <ClipCopyPanel candidateId={candidate.id} title={title} copy={copy} />
      )}

      {/* Posting to social accounts (2026-09-29): nothing while it is switched off. */}
      <ClipPosts runId={runId} clipId={clip?.id} title={title} ready={state === "ready"} />

      <ClipControls
        runId={runId}
        candidate={candidate}
        clip={clip}
        clipState={state}
        title={title}
        runStopped={runStopped}
      />
      <ClipLayoutControl
        runId={runId}
        candidateId={candidate.id}
        clip={clip}
        clipState={state}
        title={title}
        runStopped={runStopped}
      />
    </li>
  );
}
