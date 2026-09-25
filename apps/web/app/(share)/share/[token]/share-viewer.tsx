"use client";

/**
 * The public review surface (B15 brief §1, §3): renders the proxy video with
 * live captions via `CaptionStage` (read-only — no `onOp`, no
 * `selectedSegmentId`, `showSafeZones={false}`), a password gate, comments
 * (scope `comment`/`approve`), approve/request-changes (scope `approve`), a
 * report-abuse form (F-504) and a legal footer with the grievance officer.
 *
 * No `JwtAuthGuard`-equivalent here — this page never assumes a session. It
 * calls only `auth: "public"` endpoints and the `X-Share-Session` header is
 * this visit's *entire* credential (`lib/share/session.ts`).
 */

import * as React from "react";

import { isApiError } from "@montaj/api-client";
import type { EdgProjection } from "@montaj/render-core";
import { Badge, Button, Field, Input, PageHeader, Textarea } from "@montaj/ui";

import type { ShareReportCategory } from "@/lib/share/types";

import { CaptionStage } from "@/components/editor/canvas/CaptionStage";
import { aspectRatioOf, containWidth } from "@/components/editor/canvas/stage-fit";
import { SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";
import { ATTRIBUTION_LINE, GRIEVANCE_OFFICER } from "@/content/site/legal";
import { useFaceTrack } from "@/lib/edg/use-face-track";
import {
  useAddShareComment,
  useDecideShareLink,
  useReportShareLink,
  useShareComments,
  useSharePreview,
  useShareResolve,
  useUnlockShareLink,
} from "@/lib/share/hooks";

const REPORT_CATEGORIES: readonly { value: ShareReportCategory; label: string }[] = [
  { value: "ncii", label: "Non-consensual intimate imagery" },
  { value: "impersonation", label: "Impersonation" },
  { value: "copyright", label: "Copyright" },
  { value: "other", label: "Other" },
];

/** What each link scope lets the viewer do, in words (never the raw enum). */
const SCOPE_LABEL: Record<"view" | "comment" | "approve", string> = {
  view: "View only",
  comment: "Can comment",
  approve: "Can approve",
};

/** A native `<select>` dressed like the `Input` primitive. */
const SELECT_CLASS =
  "bg-sunken border-border text-fg-0 hover:border-border-hover h-9 w-full rounded-sm border px-3 text-sm";

function ErrorNotice({ message }: { message: string }): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-12 sm:px-6">
      <PageHeader
        title="This link isn't available"
        description={<span data-testid="share-error">{message}</span>}
      />
      <p className="text-fg-2 text-sm">Ask the person who sent it for a new review link.</p>
    </main>
  );
}

function PasswordGate({ token }: { token: string }): React.JSX.Element {
  const [password, setPassword] = React.useState("");
  const unlock = useUnlockShareLink(token);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12 sm:px-6">
      <PageHeader
        title="Enter the password"
        description="The owner protected this review link. Ask them for the password if you don't have it."
      />
      <form
        className="border-border bg-surface flex flex-col gap-4 rounded-md border p-5"
        onSubmit={(event) => {
          event.preventDefault();
          unlock.mutate(password);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-password" className="text-fg-1 text-sm font-medium">
            Password
          </label>
          <Input
            id="share-password"
            type="password"
            autoFocus
            value={password}
            invalid={unlock.isError}
            {...(unlock.isError ? { "aria-describedby": "share-password-error" } : {})}
            onChange={(event) => setPassword(event.target.value)}
            data-testid="share-password-input"
          />
          {unlock.isError ? (
            <p
              id="share-password-error"
              className="text-rejected text-xs"
              role="alert"
              data-testid="share-password-error"
            >
              {isApiError(unlock.error)
                ? unlock.error.message
                : "That password didn't work. Check it with the person who sent the link."}
            </p>
          ) : null}
        </div>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={unlock.isPending || password === ""}
        >
          {unlock.isPending ? "Checking…" : "Unlock"}
        </Button>
      </form>
    </main>
  );
}

function ReportAbuseForm({ token }: { token: string }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [category, setCategory] = React.useState<ShareReportCategory>("other");
  const [contact, setContact] = React.useState("");
  const report = useReportShareLink(token);

  if (!open) {
    return (
      <button
        type="button"
        className="text-fg-2 hover:text-fg-0 inline-flex min-h-8 items-center self-start rounded-sm text-xs underline underline-offset-4"
        data-testid="report-abuse-open"
        onClick={() => setOpen(true)}
      >
        Report this content
      </button>
    );
  }

  if (report.isSuccess) {
    return (
      <p className="text-fg-1 text-xs" data-testid="report-abuse-ack" role="status">
        Report received. It will be reviewed.
      </p>
    );
  }

  return (
    <form
      className="border-border bg-surface flex max-w-md flex-col gap-4 rounded-md border p-5"
      data-testid="report-abuse-form"
      aria-labelledby="report-abuse-heading"
      onSubmit={(event) => {
        event.preventDefault();
        report.mutate({ category, reporterContact: contact === "" ? undefined : contact });
      }}
    >
      <h2 id="report-abuse-heading" className="text-fg-0 text-sm font-semibold">
        Report this content
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="report-abuse-category" className="text-fg-1 text-sm font-medium">
          Reason
        </label>
        <select
          id="report-abuse-category"
          value={category}
          onChange={(event) => setCategory(event.target.value as ShareReportCategory)}
          className={SELECT_CLASS}
          data-testid="report-abuse-category"
        >
          {REPORT_CATEGORIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <Field
        label="Your email or phone (optional)"
        htmlFor="report-abuse-contact"
        hint="Only used if the reviewer needs to reach you about this report."
      >
        <Input
          id="report-abuse-contact"
          type="text"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          data-testid="report-abuse-contact"
        />
      </Field>
      {report.isError ? (
        <p className="text-rejected text-xs" role="alert">
          {isApiError(report.error)
            ? report.error.message
            : "The report didn't send. Check your connection and try again."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={report.isPending}>
          {report.isPending ? "Sending…" : "Send report"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CommentsPanel({
  token,
  canComment,
  isPrimaryAction,
}: {
  token: string;
  canComment: boolean;
  /** True when posting a comment is the page's main action (no approve bar). */
  isPrimaryAction: boolean;
}): React.JSX.Element {
  const comments = useShareComments(token, true);
  const addComment = useAddShareComment(token);
  const [body, setBody] = React.useState("");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");

  return (
    <section className="flex flex-col gap-3" data-testid="share-comments" aria-label="Comments">
      <h2 className="text-fg-0 text-base font-semibold">
        Comments{comments.data === undefined ? "" : ` (${String(comments.data.length)})`}
      </h2>
      {comments.isPending ? (
        <p className="text-fg-2 text-sm" role="status">
          Loading comments…
        </p>
      ) : comments.isError ? (
        <p className="text-rejected text-sm" role="alert">
          Comments didn&apos;t load. Refresh the page to try again.
        </p>
      ) : (comments.data ?? []).length === 0 ? (
        <p className="text-fg-2 text-sm">
          {canComment ? "No comments yet. Add the first one below." : "No comments yet."}
        </p>
      ) : (
        <ul className="border-border bg-surface divide-border flex flex-col divide-y rounded-md border">
          {(comments.data ?? []).map((comment) => (
            <li
              key={comment.id}
              className="flex flex-col gap-1 px-4 py-3 text-sm"
              data-testid="share-comment-item"
            >
              <div className="text-fg-2 flex items-center gap-2 text-xs">
                <span className="text-fg-1 font-medium">
                  {comment.authorName ?? "Workspace member"}
                </span>
                {comment.atMs === null ? null : (
                  <Badge tone="neutral" className="font-mono">
                    <span className="sr-only">at </span>
                    {formatTimestamp(comment.atMs)}
                  </Badge>
                )}
              </div>
              <p className="text-fg-0 break-words whitespace-pre-line">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {canComment ? (
        <form
          className="border-border bg-surface flex flex-col gap-4 rounded-md border p-5"
          aria-label="Add a comment"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() === "") return;
            addComment.mutate(
              {
                body,
                author: name.trim() === "" ? undefined : { name, email: email || undefined },
              },
              { onSuccess: () => setBody("") },
            );
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Your name"
              htmlFor="comment-author-name"
              hint="Shown next to your comment."
            >
              <Input
                id="comment-author-name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                data-testid="comment-author-name"
              />
            </Field>
            <Field
              label="Email (optional)"
              htmlFor="comment-author-email"
              hint="Only the project owner sees it."
            >
              <Input
                id="comment-author-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-testid="comment-author-email"
              />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="comment-body" className="text-fg-1 text-sm font-medium">
              Comment
            </label>
            <Textarea
              id="comment-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What should change, and where?"
              rows={3}
              data-testid="comment-body"
            />
          </div>
          {addComment.isError ? (
            <p className="text-rejected text-xs" role="alert">
              {isApiError(addComment.error)
                ? addComment.error.message
                : "Your comment didn't post. Check your connection and try again."}
            </p>
          ) : null}
          <Button
            type="submit"
            variant={isPrimaryAction ? "primary" : "secondary"}
            className="self-end"
            disabled={addComment.isPending || body.trim() === "" || name.trim() === ""}
          >
            {addComment.isPending ? "Posting…" : "Post comment"}
          </Button>
        </form>
      ) : (
        <p className="text-fg-2 text-sm">This link is view only, so comments are turned off.</p>
      )}
    </section>
  );
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}`;
}

function DecisionBar({
  token,
  reviewStatus,
}: {
  token: string;
  reviewStatus: string;
}): React.JSX.Element {
  const decide = useDecideShareLink(token);

  if (reviewStatus === "approved" || reviewStatus === "changes_requested") {
    return (
      <div
        className="border-border bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border px-5 py-4"
        data-testid="share-decision-recorded"
      >
        <span className="text-fg-0 flex items-center gap-2 text-sm">
          <Badge tone={reviewStatus === "approved" ? "accepted" : "proposed"}>
            {reviewStatus === "approved" ? "Approved" : "Changes requested"}
          </Badge>
          <span className="text-fg-2">Your decision is recorded.</span>
        </span>
        <Button
          variant="ghost"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate(reviewStatus === "approved" ? "changes_requested" : "approved")
          }
        >
          {reviewStatus === "approved" ? "Request changes instead" : "Approve instead"}
        </Button>
        {decide.isError ? (
          <p className="text-rejected w-full text-xs" role="alert">
            {isApiError(decide.error)
              ? decide.error.message
              : "Your decision didn't save. Try again."}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <section
      className="border-border bg-surface flex flex-col gap-3 rounded-md border px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      aria-label="Your decision"
      data-testid="share-decision-bar"
    >
      <p className="text-fg-1 text-sm">Ready to sign off, or does it need another pass?</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => decide.mutate("approved")}
          disabled={decide.isPending}
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          onClick={() => decide.mutate("changes_requested")}
          disabled={decide.isPending}
        >
          Request changes
        </Button>
      </div>
      {decide.isError ? (
        <p className="text-rejected text-xs sm:w-full" role="alert">
          {isApiError(decide.error)
            ? decide.error.message
            : "Your decision didn't save. Try again."}
        </p>
      ) : null}
    </section>
  );
}

/** Toggles native controls on the `<video>` `CaptionStage` mounts, without editing that file. */
function usePlaybackControls(containerRef: React.RefObject<HTMLDivElement | null>): void {
  React.useEffect(() => {
    const video = containerRef.current?.querySelector("video");
    if (video === null || video === undefined) return;
    video.controls = true;
  });
}

export function ShareViewer({ token }: { token: string }): React.JSX.Element {
  const resolve = useShareResolve(token);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const unlocked = resolve.data?.unlocked === true;
  const preview = useSharePreview(token, unlocked);
  usePlaybackControls(stageRef);
  // Captions keep off faces here exactly as they do in the export.
  const faces = useFaceTrack(
    preview.data?.facesUrl,
    (preview.data?.projection as EdgProjection | null | undefined)?.canvas,
  );

  if (resolve.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <p className="text-fg-2 text-sm" role="status">
          Opening the review link…
        </p>
      </main>
    );
  }

  if (resolve.isError) {
    const message = isApiError(resolve.error)
      ? resolve.error.code === "share/revoked"
        ? "This link has been disabled by its owner."
        : resolve.error.code === "share/expired"
          ? "This link has expired."
          : resolve.error.code === "share/view_limit_reached"
            ? "This link has reached its view limit."
            : "This link does not exist."
      : "This link does not exist.";
    return <ErrorNotice message={message} />;
  }

  const data = resolve.data;
  if (data === undefined) return <ErrorNotice message="This link does not exist." />;

  if (data.requiresPassword && !data.unlocked) {
    return <PasswordGate token={token} />;
  }

  // FIX-05: the frame follows the document, exactly as the editor's does. The
  // literal 9:16 it replaced was the same "chrome ignores correct data" bug
  // mirrored on the share page — a 16:9 project was letterboxed into a portrait
  // box for every viewer. The empty-projection fallback keeps today's portrait
  // default for a project whose EDG document has not initialised yet.
  const projection = (preview.data?.projection ?? emptyProjection()) as EdgProjection;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow="Shared for review"
        title={<span data-testid="share-title">{data.title}</span>}
        actions={<Badge tone="neutral">{SCOPE_LABEL[data.scope]}</Badge>}
      />

      <div
        ref={stageRef}
        className="bg-ink max-h-[70dvh] max-w-full self-center overflow-hidden rounded-lg"
        style={{
          aspectRatio: aspectRatioOf(projection.canvas),
          // A `self-center` box with only `aspect-ratio` has no size basis at
          // all: it measured 0x0 here, and — A/B-checked against main — did so
          // with the old `aspect-[9/16]` too, so the share preview was invisible
          // before this package as well. `containWidth` gives it the one basis
          // it needs, letterboxed inside the same 70dvh cap in either aspect.
          width: containWidth(projection.canvas, "100%", "70dvh"),
        }}
      >
        {preview.isPending ? (
          <div className="bg-ink flex h-full w-full items-center justify-center px-4 text-center">
            <p className="text-fg-2 text-sm" role="status">
              Loading the preview…
            </p>
          </div>
        ) : preview.isError || preview.data === undefined ? (
          <div className="bg-ink flex h-full w-full items-center justify-center px-4 text-center">
            <p className="text-fg-2 text-sm">
              {isApiError(preview.error)
                ? preview.error.message
                : "This project has no preview yet."}
            </p>
          </div>
        ) : (
          <CaptionStage
            src={preview.data.proxyUrl}
            projection={projection}
            {...(faces === undefined ? {} : { faces })}
            catalogue={SYSTEM_STYLE_MAP}
            showSafeZones={false}
          />
        )}
      </div>

      {data.scope === "approve" ? (
        <DecisionBar token={token} reviewStatus={data.reviewStatus} />
      ) : null}

      <CommentsPanel
        token={token}
        canComment={data.scope !== "view"}
        isPrimaryAction={data.scope === "comment"}
      />

      <footer className="border-border text-fg-2 flex flex-col gap-3 border-t pt-5 text-xs">
        <ReportAbuseForm token={token} />
        <p>{ATTRIBUTION_LINE}</p>
        <p>
          Grievance officer:{" "}
          <a
            href={`mailto:${GRIEVANCE_OFFICER.email}`}
            className="text-fg-1 hover:text-fg-0 rounded-sm underline underline-offset-4"
          >
            {GRIEVANCE_OFFICER.email}
          </a>
        </p>
      </footer>
    </main>
  );
}

/** An empty-but-valid projection: a project whose EDG document has not initialised yet. */
function emptyProjection(): EdgProjection {
  return {
    canvas: { width: 1080, height: 1920 },
    styles: { defaultStyleId: "system:default" },
    segments: [],
    words: [],
  };
}
