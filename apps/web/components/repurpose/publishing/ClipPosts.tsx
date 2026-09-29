"use client";

/**
 * A clip's posting, on its card (2026-09-29): the Post button, and where each
 * of its posts stands - scheduled for when, posted (with a link), or not
 * posted and why, with Try again. Cancel is offered while a post has not gone
 * out.
 *
 * Renders nothing while posting is switched off for the workspace, so a card
 * on a workspace without it looks exactly as it did. The button is secondary:
 * a list of clips would otherwise put a rani button on every card, and the
 * page's one primary stays where it is.
 */
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Loader2, Send } from "lucide-react";
import * as React from "react";

import { Button, ConfirmAction } from "@montaj/ui";

import { PUBLISH_COPY, describePublishError, postStatusLine } from "./publish-copy";
import { PublishDialog } from "./PublishDialog";
import {
  useCancelPost,
  usePublishingStatus,
  useRetryPost,
  useRunPosts,
  type PublishPost,
} from "./use-publishing";

export interface ClipPostsProps {
  readonly runId: string;
  readonly clipId: string | undefined;
  readonly title: string;
  /** The clip is cut and ready; only then can it be posted. */
  readonly ready: boolean;
}

function StatusIcon({ post }: { readonly post: PublishPost }): React.JSX.Element | null {
  const common = { className: "mt-0.5 size-4 shrink-0", strokeWidth: 1.75, "aria-hidden": true };
  switch (post.status) {
    case "posting":
      return <Loader2 {...common} className={`${common.className} animate-spin text-fg-2`} />;
    case "scheduled":
      return <Clock {...common} className={`${common.className} text-fg-2`} />;
    case "posted":
      return <CheckCircle2 {...common} className={`${common.className} text-accepted`} />;
    case "failed":
      return <AlertTriangle {...common} className={`${common.className} text-rejected`} />;
    default:
      return null;
  }
}

function PostRow({
  runId,
  post,
}: {
  readonly runId: string;
  readonly post: PublishPost;
}): React.JSX.Element {
  const retry = useRetryPost();
  const cancel = useCancelPost();
  const where = post.channel === null ? post.platform : `${post.platform}, ${post.channel.name}`;
  const error = retry.isError ? retry.error : cancel.isError ? cancel.error : null;
  return (
    <li
      className="flex flex-col gap-1 py-1.5"
      data-testid={`post-${post.id}`}
      data-status={post.status}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <p
          className={`m-0 flex min-w-0 flex-[1_1_220px] items-start gap-2 text-sm ${post.status === "cancelled" ? "text-fg-2" : "text-fg-1"}`}
        >
          <StatusIcon post={post} />
          <span>
            <span className="text-fg-0">{where}</span>
            {post.shape === null ? null : <span className="text-fg-2"> · {post.shape}</span>}
            <span className="block" role={post.status === "failed" ? "alert" : undefined}>
              {postStatusLine(post)}
            </span>
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {post.status === "posted" && post.url !== null ? (
            <Button variant="ghost" size="sm" asChild>
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline"
                aria-label={`${PUBLISH_COPY.viewPost} on ${post.platform}`}
                data-testid={`post-link-${post.id}`}
              >
                {PUBLISH_COPY.viewPost}
                <ExternalLink strokeWidth={1.75} aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          {post.canRetry ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate({ runId, postId: post.id });
              }}
              data-testid={`post-retry-${post.id}`}
            >
              {retry.isPending ? PUBLISH_COPY.retrying : PUBLISH_COPY.retry}
            </Button>
          ) : null}
          {post.canCancel ? (
            <ConfirmAction
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancel.isPending}
                  aria-label={`${PUBLISH_COPY.cancelPost}: ${where}`}
                  data-testid={`post-cancel-${post.id}`}
                >
                  {PUBLISH_COPY.cancelPost}
                </Button>
              }
              title={PUBLISH_COPY.cancelTitle}
              description={PUBLISH_COPY.cancelDescription}
              confirmLabel={PUBLISH_COPY.cancelPost}
              confirmTestId={`post-cancel-confirm-${post.id}`}
              onConfirm={() => {
                cancel.mutate({ runId, postId: post.id });
              }}
            />
          ) : null}
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-rejected" data-testid={`post-error-${post.id}`}>
          {describePublishError(error)}
        </p>
      )}
    </li>
  );
}

export function ClipPosts({
  runId,
  clipId,
  title,
  ready,
}: ClipPostsProps): React.JSX.Element | null {
  const { status } = usePublishingStatus();
  const posts = useRunPosts(runId, status.enabled);
  const [open, setOpen] = React.useState(false);
  if (!status.enabled || clipId === undefined) return null;
  const mine = (posts.data?.posts ?? []).filter((post) => post.clipId === clipId);
  if (!ready && mine.length === 0) return null;

  return (
    <div className="flex flex-col gap-1" data-testid={`clip-posts-${clipId}`}>
      {ready ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
            aria-label={`${PUBLISH_COPY.postButton}: ${title}`}
            data-testid={`post-clip-${clipId}`}
          >
            <Send strokeWidth={1.75} aria-hidden="true" />
            {PUBLISH_COPY.postButton}
          </Button>
        </div>
      ) : null}
      {mine.length === 0 ? null : (
        <section aria-label={`${PUBLISH_COPY.postsHeading}: ${title}`}>
          <ul className="m-0 list-none divide-y divide-border p-0">
            {mine.map((post) => (
              <PostRow key={post.id} runId={runId} post={post} />
            ))}
          </ul>
        </section>
      )}
      {open ? (
        <PublishDialog
          runId={runId}
          clipId={clipId}
          title={title}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </div>
  );
}
