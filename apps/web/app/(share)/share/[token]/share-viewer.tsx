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
import { Badge, Button, Textarea } from "@montaj/ui";

import type { ShareReportCategory } from "@/lib/share/types";

import { CaptionStage } from "@/components/editor/canvas/CaptionStage";
import { SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";
import { ATTRIBUTION_LINE, GRIEVANCE_OFFICER } from "@/content/site/legal";
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

function ErrorNotice({ message }: { message: string }): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-fg-0 text-xl font-semibold">This link isn&apos;t available</h1>
      <p className="text-fg-2 text-sm" data-testid="share-error">
        {message}
      </p>
    </main>
  );
}

function PasswordGate({ token }: { token: string }): React.JSX.Element {
  const [password, setPassword] = React.useState("");
  const unlock = useUnlockShareLink(token);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-fg-0 text-xl font-semibold">Password required</h1>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          unlock.mutate(password);
        }}
      >
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          className="border-border bg-bg-1 text-fg-0 rounded-md border px-3 py-2 text-sm"
          data-testid="share-password-input"
        />
        <Button type="submit" disabled={unlock.isPending || password === ""}>
          {unlock.isPending ? "Checking…" : "Unlock"}
        </Button>
        {unlock.isError ? (
          <p className="text-sm text-red-400" data-testid="share-password-error">
            {isApiError(unlock.error) ? unlock.error.message : "Incorrect password."}
          </p>
        ) : null}
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
        className="text-fg-2 hover:text-fg-0 text-xs underline"
        data-testid="report-abuse-open"
        onClick={() => setOpen(true)}
      >
        Report this content
      </button>
    );
  }

  if (report.isSuccess) {
    return (
      <p className="text-fg-2 text-xs" data-testid="report-abuse-ack">
        Thank you — your report was received and will be reviewed.
      </p>
    );
  }

  return (
    <form
      className="border-border bg-bg-1 flex flex-col gap-2 rounded-md border p-3 text-xs"
      data-testid="report-abuse-form"
      onSubmit={(event) => {
        event.preventDefault();
        report.mutate({ category, reporterContact: contact === "" ? undefined : contact });
      }}
    >
      <label className="flex flex-col gap-1">
        Reason
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as ShareReportCategory)}
          className="border-border bg-bg-0 rounded-md border px-2 py-1"
          data-testid="report-abuse-category"
        >
          {REPORT_CATEGORIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Your contact (optional)
        <input
          type="text"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          className="border-border bg-bg-0 rounded-md border px-2 py-1"
          data-testid="report-abuse-contact"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={report.isPending}>
          {report.isPending ? "Sending…" : "Send report"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CommentsPanel({
  token,
  canComment,
}: {
  token: string;
  canComment: boolean;
}): React.JSX.Element {
  const comments = useShareComments(token, true);
  const addComment = useAddShareComment(token);
  const [body, setBody] = React.useState("");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");

  return (
    <section className="flex flex-col gap-3" data-testid="share-comments" aria-label="Comments">
      <h2 className="text-fg-0 text-sm font-semibold">
        Comments{comments.data === undefined ? "" : ` (${String(comments.data.length)})`}
      </h2>
      <ul className="flex flex-col gap-2">
        {(comments.data ?? []).map((comment) => (
          <li
            key={comment.id}
            className="border-border bg-bg-1 rounded-md border p-2 text-sm"
            data-testid="share-comment-item"
          >
            <div className="text-fg-2 flex items-center gap-2 text-xs">
              <span>{comment.authorName ?? "Workspace member"}</span>
              {comment.atMs === null ? null : (
                <Badge tone="neutral">{formatTimestamp(comment.atMs)}</Badge>
              )}
            </div>
            <p className="text-fg-0">{comment.body}</p>
          </li>
        ))}
      </ul>
      {canComment ? (
        <form
          className="flex flex-col gap-2"
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
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="border-border bg-bg-1 text-fg-0 flex-1 rounded-md border px-2 py-1 text-sm"
              data-testid="comment-author-name"
            />
            <input
              type="email"
              placeholder="Email (optional)"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="border-border bg-bg-1 text-fg-0 flex-1 rounded-md border px-2 py-1 text-sm"
              data-testid="comment-author-email"
            />
          </div>
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Leave a comment…"
            rows={2}
            data-testid="comment-body"
          />
          <Button
            type="submit"
            size="sm"
            className="self-end"
            disabled={addComment.isPending || body.trim() === "" || name.trim() === ""}
          >
            {addComment.isPending ? "Posting…" : "Post comment"}
          </Button>
        </form>
      ) : (
        <p className="text-fg-2 text-xs">This link does not allow comments.</p>
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

function DecisionBar({ token, reviewStatus }: { token: string; reviewStatus: string }): React.JSX.Element {
  const decide = useDecideShareLink(token);

  if (reviewStatus === "approved" || reviewStatus === "changes_requested") {
    return (
      <div
        className="border-border bg-bg-1 flex items-center justify-between rounded-md border p-3"
        data-testid="share-decision-recorded"
      >
        <span className="text-fg-0 text-sm">
          {reviewStatus === "approved" ? "Approved" : "Changes requested"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            decide.mutate(reviewStatus === "approved" ? "changes_requested" : "approved")
          }
        >
          Change decision
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-2" data-testid="share-decision-bar">
      <Button onClick={() => decide.mutate("approved")} disabled={decide.isPending}>
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

  if (resolve.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <p className="text-fg-2 text-sm">Loading…</p>
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-fg-0 text-xl font-semibold" data-testid="share-title">
          {data.title}
        </h1>
        <Badge tone="accent">{data.scope}</Badge>
      </header>

      <div ref={stageRef} className="aspect-[9/16] max-h-[70dvh] self-center overflow-hidden rounded-lg">
        {preview.isPending ? (
          <div className="bg-bg-1 flex h-full w-full items-center justify-center">
            <p className="text-fg-2 text-sm">Loading preview…</p>
          </div>
        ) : preview.isError || preview.data === undefined ? (
          <div className="bg-bg-1 flex h-full w-full items-center justify-center">
            <p className="text-fg-2 text-sm">
              {isApiError(preview.error) ? preview.error.message : "This project has no preview yet."}
            </p>
          </div>
        ) : (
          <CaptionStage
            src={preview.data.proxyUrl}
            projection={(preview.data.projection ?? emptyProjection()) as EdgProjection}
            catalogue={SYSTEM_STYLE_MAP}
            showSafeZones={false}
          />
        )}
      </div>

      {data.scope === "approve" ? (
        <DecisionBar token={token} reviewStatus={data.reviewStatus} />
      ) : null}

      <CommentsPanel token={token} canComment={data.scope !== "view"} />

      <footer className="border-border text-fg-2 flex flex-col gap-2 border-t pt-4 text-xs">
        <ReportAbuseForm token={token} />
        <p>{ATTRIBUTION_LINE}</p>
        <p>
          Grievance officer:{" "}
          <a href={`mailto:${GRIEVANCE_OFFICER.email}`} className="underline">
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
