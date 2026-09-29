"use client";

/**
 * A clip's review, on its card on the run page (2026-10-03): where it stands
 * (waiting, approved, changes requested - and by whom), the decision the
 * person may make, and the clip's comments.
 *
 *   * **Approve** is an owner's or admin's, **Request changes** an editor's and
 *     up; everyone comments (the API holds the same rule and says so if the
 *     page is out of date). The buttons are secondary and ghost: a run lists
 *     many clips, and a rani button on each would take the page's one primary.
 *   * **An approval covers the videos it was made on.** A shape made after it
 *     is named, with "Approve these too"; a clip whose video changed is back in
 *     review, and says why.
 *   * **What the reviewer saw is what is approved**: the decision carries the
 *     videos this card showed (`expect`), and the API refuses it if they have
 *     changed since.
 *   * **On a phone** the actions are full-height (44 px) targets, and the
 *     composer's "At 0:12" pins a comment to where the clip was playing.
 */
import { CheckCircle2, Clock, MessageSquare, PenLine, RotateCcw } from "lucide-react";
import * as React from "react";

import { Badge, Button, Checkbox, Textarea } from "@montaj/ui";

import {
  REVIEW_COPY,
  REVIEW_STATE_LABEL,
  actorName,
  clipClock,
  describeReviewError,
  sinceWords,
  uncoveredNote,
} from "./review-copy";
import {
  useAddClipComment,
  useClipReview,
  useDecideClip,
  useResolveClipComment,
  type ClipComment,
  type ClipReviewSummary,
  type ReviewPermissions,
  type ReviewState,
} from "./use-review";

/** Buttons a thumb can hit: 44 px on a phone, the compact size from `sm` up. */
const TOUCH = "h-11 sm:h-8";

const STATE_TONE: Readonly<Record<ReviewState, "neutral" | "accepted" | "proposed">> = {
  pending: "neutral",
  approved: "accepted",
  changes_requested: "proposed",
};

export interface ClipReviewProps {
  readonly runId: string;
  readonly clipId: string;
  readonly title: string;
  /** The clip's review, from the run's review; undefined while it loads (or on an older API). */
  readonly review: ClipReviewSummary | undefined;
  readonly permissions: ReviewPermissions | undefined;
  /** The workspace needs approval before posting. */
  readonly needsApproval: boolean;
  /** A run on Autopilot makes its own captioned videos; otherwise they are exported by hand. */
  readonly autopilot: boolean;
  /** The card shows no captioned video of its own: show the one under review here. */
  readonly showVideo: boolean;
  /** Where the card's player is, for "comment at 0:12"; null while nothing has played. */
  readonly playheadMs?: number | null;
  /** Move the card's player to a comment's moment. */
  readonly onSeek?: (ms: number) => void;
}

/** The state, who put it there, and when: "Approved · Client: Priya · 5 minutes ago". */
export function ReviewStateBadge({
  review,
  clipId,
}: {
  readonly review: ClipReviewSummary;
  readonly clipId: string;
}): React.JSX.Element {
  const who =
    review.decidedBy === null || review.state === "pending" ? null : actorName(review.decidedBy);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge tone={STATE_TONE[review.state]} data-testid={`review-state-${clipId}`}>
        {review.state === "approved" ? (
          <CheckCircle2 className="size-3" strokeWidth={2} aria-hidden="true" />
        ) : review.state === "changes_requested" ? (
          <PenLine className="size-3" strokeWidth={2} aria-hidden="true" />
        ) : (
          <Clock className="size-3" strokeWidth={2} aria-hidden="true" />
        )}
        {REVIEW_STATE_LABEL[review.state]}
      </Badge>
      {who === null ? null : (
        <span className="text-xs text-fg-2" data-testid={`review-by-${clipId}`}>
          {who}
          {review.decidedAt === null ? "" : ` · ${sinceWords(review.decidedAt)}`}
        </span>
      )}
    </span>
  );
}

export function ClipReview({
  runId,
  clipId,
  title,
  review,
  permissions,
  needsApproval,
  autopilot,
  showVideo,
  playheadMs = null,
  onSeek,
}: ClipReviewProps): React.JSX.Element | null {
  const decide = useDecideClip();
  const [asking, setAsking] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [threadOpen, setThreadOpen] = React.useState(false);
  const ownPlayer = React.useRef<HTMLVideoElement>(null);
  const [ownPlayhead, setOwnPlayhead] = React.useState<number | null>(null);

  if (review === undefined) return null;
  const hasVideo = Object.keys(review.videos).length > 0;
  const mayApprove =
    permissions?.approve === true &&
    hasVideo &&
    (review.state !== "approved" || review.uncovered.length > 0);
  const approveLabel =
    review.state === "approved" && review.uncovered.length > 0
      ? REVIEW_COPY.approveAlso
      : REVIEW_COPY.approve;
  const refusal = decide.isError ? describeReviewError(decide.error) : null;
  const videoUrl = showVideo ? (review.video?.url ?? null) : null;
  const playhead = videoUrl === null ? playheadMs : ownPlayhead;
  const seek = (ms: number): void => {
    if (videoUrl !== null && ownPlayer.current !== null) {
      ownPlayer.current.currentTime = ms / 1000;
      void ownPlayer.current.play().catch(() => undefined);
      return;
    }
    onSeek?.(ms);
  };

  const send = (decision: "approved" | "changes_requested"): void => {
    decide.mutate(
      {
        runId,
        clipId,
        decision,
        expect: review.videos,
        ...(decision === "changes_requested" && note.trim() !== "" ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          setAsking(false);
          setNote("");
        },
      },
    );
  };

  return (
    <section
      className="flex flex-col gap-2 rounded-sm border border-border bg-bg-0 p-3"
      aria-label={`${REVIEW_COPY.heading}: ${title}`}
      data-testid={`clip-review-${clipId}`}
      data-state={review.state}
    >
      <ReviewStateBadge review={review} clipId={clipId} />

      {review.reason === "video_changed" && review.state === "pending" ? (
        <p className="m-0 text-xs text-fg-1" data-testid={`review-reopened-${clipId}`}>
          {REVIEW_COPY.backInReview}
        </p>
      ) : null}
      {needsApproval && review.state !== "approved" ? (
        <p className="m-0 text-xs text-fg-2" data-testid={`review-needs-approval-${clipId}`}>
          {REVIEW_COPY.needsApproval}
        </p>
      ) : null}
      {review.state === "approved" && review.uncovered.length > 0 ? (
        <p className="m-0 text-xs text-fg-2" data-testid={`review-uncovered-${clipId}`}>
          {uncoveredNote(review.uncovered)}
        </p>
      ) : null}
      {!hasVideo && permissions?.approve === true && review.state !== "approved" ? (
        <p className="m-0 text-xs text-fg-2" data-testid={`review-no-video-${clipId}`}>
          {autopilot ? REVIEW_COPY.noVideoAutopilot : REVIEW_COPY.noVideoManual}
        </p>
      ) : null}

      {videoUrl === null ? null : (
        <div className="w-full max-w-[220px] overflow-hidden rounded-sm border border-border bg-ink">
          <video
            ref={ownPlayer}
            src={videoUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={REVIEW_COPY.videoLabel(title)}
            className="aspect-[9/16] w-full object-cover"
            data-testid={`review-video-${clipId}`}
            onTimeUpdate={(event) => {
              setOwnPlayhead(Math.round(event.currentTarget.currentTime * 1000));
            }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {mayApprove ? (
          <Button
            variant="secondary"
            size="sm"
            className={TOUCH}
            disabled={decide.isPending}
            aria-label={`${approveLabel}: ${title}`}
            onClick={() => {
              send("approved");
            }}
            data-testid={`review-approve-${clipId}`}
          >
            <CheckCircle2 strokeWidth={1.75} aria-hidden="true" />
            {decide.isPending && decide.variables?.decision === "approved"
              ? REVIEW_COPY.approving
              : approveLabel}
          </Button>
        ) : null}
        {permissions?.requestChanges === true ? (
          <Button
            variant="ghost"
            size="sm"
            className={TOUCH}
            aria-expanded={asking}
            aria-label={`${REVIEW_COPY.requestChanges}: ${title}`}
            onClick={() => {
              decide.reset();
              setAsking(!asking);
            }}
            data-testid={`review-request-${clipId}`}
          >
            <PenLine strokeWidth={1.75} aria-hidden="true" />
            {REVIEW_COPY.requestChanges}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className={TOUCH}
          aria-expanded={threadOpen}
          onClick={() => {
            setThreadOpen(!threadOpen);
          }}
          data-testid={`review-comments-${clipId}`}
        >
          <MessageSquare strokeWidth={1.75} aria-hidden="true" />
          {threadOpen
            ? REVIEW_COPY.hideComments
            : REVIEW_COPY.comments(review.comments.total, review.comments.open)}
        </Button>
      </div>

      {asking ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send("changes_requested");
          }}
          data-testid={`review-request-form-${clipId}`}
        >
          <label htmlFor={`review-note-${clipId}`} className="text-xs font-medium text-fg-1">
            {REVIEW_COPY.requestChangesLabel}
          </label>
          <Textarea
            id={`review-note-${clipId}`}
            rows={3}
            value={note}
            maxLength={2_000}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <p className="m-0 text-xs text-fg-2">{REVIEW_COPY.requestChangesHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className={TOUCH}
              disabled={decide.isPending}
              data-testid={`review-request-send-${clipId}`}
            >
              {decide.isPending ? REVIEW_COPY.sending : REVIEW_COPY.send}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={TOUCH}
              onClick={() => {
                setAsking(false);
                setNote("");
              }}
            >
              {REVIEW_COPY.cancel}
            </Button>
          </div>
        </form>
      ) : null}

      {refusal === null ? null : (
        <p
          role="alert"
          className="m-0 text-sm text-rejected"
          data-testid={`review-error-${clipId}`}
        >
          {refusal}
        </p>
      )}

      {threadOpen ? (
        <ClipThread
          runId={runId}
          clipId={clipId}
          title={title}
          canComment={permissions?.comment ?? true}
          playheadMs={playhead}
          onSeek={seek}
        />
      ) : null}
    </section>
  );
}

/** A clip's comments and history, and the box to add one. */
function ClipThread({
  runId,
  clipId,
  title,
  canComment,
  playheadMs,
  onSeek,
}: {
  readonly runId: string;
  readonly clipId: string;
  readonly title: string;
  readonly canComment: boolean;
  readonly playheadMs: number | null;
  readonly onSeek: (ms: number) => void;
}): React.JSX.Element {
  const detail = useClipReview(runId, clipId, true);
  const add = useAddClipComment();
  const [body, setBody] = React.useState("");
  const [atTime, setAtTime] = React.useState(true);
  const comments = detail.data?.comments ?? [];
  const history = detail.data?.events ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid={`clip-thread-${clipId}`}>
      <h4 className="m-0 text-xs font-semibold tracking-wide text-fg-2 uppercase">
        {REVIEW_COPY.commentsHeading}
      </h4>
      {detail.isError ? (
        <p role="alert" className="m-0 text-sm text-rejected">
          {describeReviewError(detail.error)}
        </p>
      ) : comments.length === 0 ? (
        <p className="m-0 text-sm text-fg-2">{detail.isPending ? "…" : REVIEW_COPY.noComments}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              runId={runId}
              clipId={clipId}
              comment={comment}
              onSeek={onSeek}
            />
          ))}
        </ul>
      )}

      {canComment ? (
        <form
          className="flex flex-col gap-2"
          aria-label={`${REVIEW_COPY.commentLabel}: ${title}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() === "") return;
            add.mutate(
              {
                runId,
                clipId,
                body: body.trim(),
                ...(atTime && playheadMs !== null ? { atMs: playheadMs } : {}),
              },
              {
                onSuccess: () => {
                  setBody("");
                },
              },
            );
          }}
        >
          <label htmlFor={`review-comment-${clipId}`} className="sr-only">
            {REVIEW_COPY.commentLabel}
          </label>
          <Textarea
            id={`review-comment-${clipId}`}
            rows={2}
            maxLength={2_000}
            placeholder={REVIEW_COPY.commentPlaceholder}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            data-testid={`review-comment-body-${clipId}`}
          />
          <div className="flex flex-wrap items-center gap-3">
            {playheadMs === null ? null : (
              <label className="inline-flex min-h-11 items-center gap-2 text-xs text-fg-1 sm:min-h-0">
                <Checkbox
                  checked={atTime}
                  onCheckedChange={(value) => {
                    setAtTime(value === true);
                  }}
                  data-testid={`review-comment-at-${clipId}`}
                />
                {REVIEW_COPY.atTime(clipClock(playheadMs))}
              </label>
            )}
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className={TOUCH}
              disabled={add.isPending || body.trim() === ""}
              data-testid={`review-comment-post-${clipId}`}
            >
              {add.isPending ? REVIEW_COPY.posting : REVIEW_COPY.postComment}
            </Button>
          </div>
          {add.isError ? (
            <p role="alert" className="m-0 text-sm text-rejected">
              {describeReviewError(add.error)}
            </p>
          ) : null}
        </form>
      ) : null}

      {history.length === 0 ? null : (
        <details className="text-xs text-fg-2">
          <summary className="cursor-pointer select-none">{REVIEW_COPY.historyHeading}</summary>
          <ul
            className="m-0 mt-2 flex list-none flex-col gap-1 p-0"
            data-testid={`clip-history-${clipId}`}
          >
            {history.map((event) => (
              <li key={event.id}>
                <span className="text-fg-1">{REVIEW_STATE_LABEL[event.state]}</span>
                {" · "}
                {event.reason === "video_changed"
                  ? REVIEW_COPY.backInReview
                  : actorName(event.actor)}
                {" · "}
                {sinceWords(event.createdAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function CommentRow({
  runId,
  clipId,
  comment,
  onSeek,
}: {
  readonly runId: string;
  readonly clipId: string;
  readonly comment: ClipComment;
  readonly onSeek: (ms: number) => void;
}): React.JSX.Element {
  const resolve = useResolveClipComment();
  const resolved = comment.resolvedAt !== null;
  return (
    <li
      className={`flex flex-col gap-1 py-2 ${resolved ? "opacity-70" : ""}`}
      data-testid={`clip-comment-${comment.id}`}
      data-resolved={resolved}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
        <span className="font-medium text-fg-1">{actorName(comment.author)}</span>
        {comment.atMs === null ? null : (
          <button
            type="button"
            className="min-h-8 rounded-sm px-1 font-mono text-fg-1 underline underline-offset-4 hover:text-fg-0"
            aria-label={REVIEW_COPY.seek(clipClock(comment.atMs))}
            onClick={() => {
              if (comment.atMs !== null) onSeek(comment.atMs);
            }}
          >
            {clipClock(comment.atMs)}
          </button>
        )}
        <span>{sinceWords(comment.createdAt)}</span>
        {resolved ? <Badge tone="neutral">{REVIEW_COPY.resolved}</Badge> : null}
      </div>
      <p className="m-0 text-sm break-words whitespace-pre-line text-fg-0">{comment.body}</p>
      {comment.canResolve ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className={TOUCH}
            disabled={resolve.isPending}
            onClick={() => {
              resolve.mutate({ runId, clipId, commentId: comment.id, resolved: !resolved });
            }}
            data-testid={`clip-comment-resolve-${comment.id}`}
          >
            {resolved ? (
              <RotateCcw strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <CheckCircle2 strokeWidth={1.75} aria-hidden="true" />
            )}
            {resolved ? REVIEW_COPY.reopen : REVIEW_COPY.resolve}
          </Button>
        </div>
      ) : null}
      {resolve.isError ? (
        <p role="alert" className="m-0 text-xs text-rejected">
          {describeReviewError(resolve.error)}
        </p>
      ) : null}
    </li>
  );
}
