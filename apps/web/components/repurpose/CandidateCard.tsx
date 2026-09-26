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
  useCreateRepurposeClip,
  useRetryRepurposeClip,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  type RepurposeClipState,
} from "@montaj/api-client";
import { Badge, Button } from "@montaj/ui";

import { ClipPreview } from "@/components/repurpose/ClipPreview";
import { CLIP_STATE_COPY, clipFailureCopy } from "@/components/repurpose/copy";
import { formatClock } from "@/components/repurpose/moment-time";
import { describeRefusal } from "@/components/repurpose/refusal";
import { newRunHref, recallRunSetup } from "@/components/repurpose/run-setup";
import { useStableUrl } from "@/components/repurpose/use-stable-url";

const CLIP_STATES: ReadonlySet<string> = new Set(["waiting", "cutting", "ready", "failed"]);

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
}

export function CandidateCard({
  runId,
  candidate,
  clip: listedClip,
  previewActive,
  onActivatePreview,
  runStopped = false,
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

  // Never invent a score: a candidate without one shows none.
  const score = candidate.potentialScore ?? candidate.score;
  const title = candidate.title ?? candidate.headline ?? "Suggested moment";
  const picked = candidate["source"] === "manual";
  // The clip's own project: where its captions live and are exported.
  const clipProjectId = clip?.variants?.[0]?.projectId;
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

  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border bg-bg-0 p-4"
      data-testid={`candidate-card-${candidate.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_240px]">
          <div className="flex flex-wrap items-center gap-2">
            {score === undefined || score === null ? null : (
              <Badge tone="neutral">Potential {String(score)}%</Badge>
            )}
            {picked ? <Badge tone="neutral">Your pick</Badge> : null}
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
              {videoUrl === undefined ? null : (
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
          ) : (
            // The original is gone, so a retry would only be refused: the way
            // forward is a new run from the same link, with the setup kept.
            <Button variant="secondary" size="sm" asChild>
              <Link
                href={newRunHref(recallRunSetup(runId), { keepLink: true })}
                className="no-underline"
                data-testid={`restart-clip-${candidate.id}`}
              >
                Start again from the link
              </Link>
            </Button>
          )}
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

      {state === "ready" && videoUrl !== undefined && (
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
    </li>
  );
}
