"use client";

/**
 * A client's review page (2026-10-03): a run's finished clips, one after the
 * other, for someone with a review link and no account - usually on a phone.
 *
 *   * **Built for a thumb.** One column at most 28rem wide, each clip's 9:16
 *     video full width, and a bar fixed to the bottom of the screen with the
 *     two decisions as 48 px buttons, for the clip in view. "Approve" is the
 *     page's one primary.
 *   * **Say what to change, where.** "Request changes" asks what; a comment
 *     can be pinned to the moment the video was at.
 *   * **Who is speaking.** A name is asked for once (required when the link
 *     says so) and remembered in this browser; everything said here reaches
 *     the team as "Client: <name>".
 *   * **Only this link's words.** The page shows what was said through this
 *     link, and whether a clip changed after it was decided on - nothing of the
 *     team or its workspace.
 */
import { CheckCircle2, PenLine, RefreshCw } from "lucide-react";
import * as React from "react";

import { isApiError } from "@montaj/api-client";
import { Badge, Button, Checkbox, Input, PageHeader, Textarea } from "@montaj/ui";

import { clipClock } from "@/components/repurpose/review/review-copy";
import { useStableUrl } from "@/components/repurpose/use-stable-url";
import { ATTRIBUTION_LINE, GRIEVANCE_OFFICER } from "@/content/site/legal";
import {
  useClientComment,
  useClientDecision,
  useClientReview,
  useReviewerName,
  type ClientClip,
} from "@/lib/review/client-review";

export const CLIENT_COPY = Object.freeze({
  loading: "Opening your clips…",
  eyebrow: "Clips for review",
  description:
    "Watch each clip, then approve it or ask for changes. Only the team that sent this link sees what you say here.",
  until: (date: string): string => `This link works until ${date}.`,
  nameLabel: (required: boolean): string => (required ? "Your name" : "Your name (optional)"),
  nameHint: "Shown to the team next to what you say.",
  nameFirst: "Add your name first, so the team knows who this is from.",
  none: "No clips are ready to review yet. Check back soon.",
  position: (index: number, total: number): string => `Clip ${String(index)} of ${String(total)}`,
  approve: "Approve",
  approving: "Approving…",
  requestChanges: "Request changes",
  changesLabel: "What should change?",
  changesPlaceholder: "The first two seconds feel slow…",
  send: "Send",
  sending: "Sending…",
  cancel: "Cancel",
  youApproved: "You approved this",
  youAsked: "You asked for changes",
  changedSince: "A new version was made after you decided. Watch it again.",
  caption: "The words it is posted with",
  comments: "Your comments",
  commentLabel: "Comment on this clip",
  commentPlaceholder: "Anything the team should know",
  atTime: (time: string): string => `At ${time} in the clip`,
  postComment: "Post comment",
  posting: "Posting…",
  seek: (time: string): string => `Play from ${time}`,
  videoLabel: (title: string): string => `${title}, vertical video with captions`,
  decisionRegion: "Your decision",
  gone: {
    revoked: "This review link was turned off by the people who sent it.",
    expired: "This review link has expired.",
    missing: "This review link does not exist.",
    unreachable: "We could not reach the review. Check your connection and try again.",
  },
  askForNew: "Ask the person who sent it for a new link.",
  tryAgain: "Try again",
  grievance: "Grievance officer:",
});

function dateWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long" }).format(date);
}

function errorText(error: unknown): string {
  if (!isApiError(error) || error.code.startsWith("network/")) {
    return CLIENT_COPY.gone.unreachable;
  }
  return error.message.trim() === "" ? CLIENT_COPY.gone.unreachable : error.message;
}

function Gone({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const code = isApiError(error) ? error.code : "";
  const message =
    code === "review/link_revoked"
      ? CLIENT_COPY.gone.revoked
      : code === "review/link_expired"
        ? CLIENT_COPY.gone.expired
        : isApiError(error) && error.status === 404
          ? CLIENT_COPY.gone.missing
          : CLIENT_COPY.gone.unreachable;
  const final = isApiError(error) && error.status >= 400 && error.status < 500;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-12">
      <PageHeader
        title="This review is not available"
        description={<span data-testid="client-review-gone">{message}</span>}
      />
      {final ? (
        <p className="m-0 text-sm text-fg-2">{CLIENT_COPY.askForNew}</p>
      ) : (
        <div>
          <Button variant="secondary" size="lg" onClick={onRetry}>
            <RefreshCw strokeWidth={1.75} aria-hidden="true" />
            {CLIENT_COPY.tryAgain}
          </Button>
        </div>
      )}
    </main>
  );
}

export function ClientReview({ token }: { readonly token: string }): React.JSX.Element {
  const page = useClientReview(token);
  const [name, setName] = useReviewerName();
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const cards = React.useRef(new Map<string, HTMLLIElement>());
  const clips = React.useMemo(() => page.data?.clips ?? [], [page.data]);

  // The clip in view is the one the bar decides on.
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || clips.length === 0) return;
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset["clipId"];
          if (id !== undefined) ratios.set(id, entry.intersectionRatio);
        }
        let best: string | null = null;
        let bestRatio = 0;
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        if (best !== null) setActiveId(best);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const element of cards.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [clips]);

  if (page.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <p className="text-sm text-fg-2" role="status">
          {CLIENT_COPY.loading}
        </p>
      </main>
    );
  }
  if (page.isError) {
    return (
      <Gone
        error={page.error}
        onRetry={() => {
          void page.refetch();
        }}
      />
    );
  }

  const data = page.data;
  // Before anything has scrolled: the first clip not yet decided, else the first.
  const active =
    clips.find((clip) => clip.id === activeId) ??
    clips.find((clip) => clip.yourDecision === null || clip.yourDecision.changedSince) ??
    clips[0];
  const activeIndex = active === undefined ? -1 : clips.indexOf(active);
  const advance = (fromId: string): void => {
    const from = clips.findIndex((clip) => clip.id === fromId);
    const next = clips.slice(from + 1).find((clip) => clip.yourDecision === null);
    if (next === undefined) return;
    setActiveId(next.id);
    cards.current.get(next.id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 pt-8 pb-56"
      data-testid="client-review"
    >
      <PageHeader
        eyebrow={CLIENT_COPY.eyebrow}
        title={<span data-testid="client-review-title">{data.title}</span>}
        description={CLIENT_COPY.description}
      />
      <p className="m-0 -mt-3 text-xs text-fg-2">{CLIENT_COPY.until(dateWords(data.expiresAt))}</p>

      <NameField name={name} required={data.requireName} onChange={setName} id="reviewer-name" />

      {clips.length === 0 ? (
        <p className="m-0 text-sm text-fg-1" data-testid="client-review-empty">
          {CLIENT_COPY.none}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-8 p-0">
          {clips.map((clip, index) => (
            <ClipCard
              key={clip.id}
              token={token}
              clip={clip}
              index={index + 1}
              total={clips.length}
              name={name}
              requireName={data.requireName}
              active={active?.id === clip.id}
              onActive={() => {
                setActiveId(clip.id);
              }}
              register={(element) => {
                if (element === null) cards.current.delete(clip.id);
                else cards.current.set(clip.id, element);
              }}
            />
          ))}
        </ol>
      )}

      <footer className="flex flex-col gap-2 border-t border-border pt-5 text-xs text-fg-2">
        <p className="m-0">{ATTRIBUTION_LINE}</p>
        <p className="m-0">
          {CLIENT_COPY.grievance}{" "}
          <a
            href={`mailto:${GRIEVANCE_OFFICER.email}`}
            className="rounded-sm text-fg-1 underline underline-offset-4 hover:text-fg-0"
          >
            {GRIEVANCE_OFFICER.email}
          </a>
        </p>
      </footer>

      {active === undefined ? null : (
        <DecisionBar
          key={active.id}
          token={token}
          clip={active}
          position={CLIENT_COPY.position(activeIndex + 1, clips.length)}
          name={name}
          requireName={data.requireName}
          onName={setName}
          onDecided={() => {
            advance(active.id);
          }}
        />
      )}
    </main>
  );
}

function NameField({
  name,
  required,
  onChange,
  id,
}: {
  readonly name: string;
  readonly required: boolean;
  readonly onChange: (name: string) => void;
  readonly id: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg-1">
        {CLIENT_COPY.nameLabel(required)}
      </label>
      <Input
        id={id}
        autoComplete="name"
        maxLength={60}
        className="h-11"
        value={name}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        data-testid={id}
      />
      <p className="m-0 text-xs text-fg-2">{CLIENT_COPY.nameHint}</p>
    </div>
  );
}

function ClipCard({
  token,
  clip,
  index,
  total,
  name,
  requireName,
  active,
  onActive,
  register,
}: {
  readonly token: string;
  readonly clip: ClientClip;
  readonly index: number;
  readonly total: number;
  readonly name: string;
  readonly requireName: boolean;
  readonly active: boolean;
  readonly onActive: () => void;
  readonly register: (element: HTMLLIElement | null) => void;
}): React.JSX.Element {
  const player = React.useRef<HTMLVideoElement>(null);
  const [playhead, setPlayhead] = React.useState<number | null>(null);
  // The page is asked again every few minutes and signs the video afresh; a
  // playing video must not restart because of it.
  const src = useStableUrl(clip.video?.url, clip.video?.exportId);
  const decision = clip.yourDecision;

  return (
    <li
      ref={register}
      data-clip-id={clip.id}
      className={`flex scroll-mt-4 flex-col gap-3 rounded-md border bg-surface p-3 ${active ? "border-border-hover" : "border-border"}`}
      data-testid={`client-clip-${clip.id}`}
      data-active={active}
      onPointerDown={onActive}
      onFocus={onActive}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-2xs text-fg-2">{CLIENT_COPY.position(index, total)}</span>
        <h2 className="m-0 text-base font-semibold text-fg-0">{clip.title}</h2>
        {decision === null ? null : (
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              tone={decision.state === "approved" ? "accepted" : "proposed"}
              data-testid={`client-decision-${clip.id}`}
            >
              {decision.state === "approved" ? (
                <CheckCircle2 className="size-3" strokeWidth={2} aria-hidden="true" />
              ) : (
                <PenLine className="size-3" strokeWidth={2} aria-hidden="true" />
              )}
              {decision.state === "approved" ? CLIENT_COPY.youApproved : CLIENT_COPY.youAsked}
            </Badge>
            {decision.changedSince ? (
              <span className="text-xs text-fg-1" data-testid={`client-changed-${clip.id}`}>
                {CLIENT_COPY.changedSince}
              </span>
            ) : null}
          </span>
        )}
      </div>

      {src === undefined ? null : (
        <div className="overflow-hidden rounded-sm bg-ink">
          <video
            ref={player}
            src={src}
            controls
            playsInline
            preload="metadata"
            aria-label={CLIENT_COPY.videoLabel(clip.title)}
            className="aspect-[9/16] max-h-[75dvh] w-full object-contain"
            data-testid={`client-video-${clip.id}`}
            onTimeUpdate={(event) => {
              setPlayhead(Math.round(event.currentTarget.currentTime * 1000));
            }}
          />
        </div>
      )}

      {clip.hook === null && clip.description === null && clip.hashtags.length === 0 ? null : (
        <details className="rounded-sm border border-border bg-bg-0 p-3 text-sm">
          <summary className="min-h-8 cursor-pointer text-fg-1 select-none">
            {CLIENT_COPY.caption}
          </summary>
          <div className="mt-2 flex flex-col gap-2 text-fg-0">
            {clip.hook === null ? null : <p className="m-0 font-medium">{clip.hook}</p>}
            {clip.description === null ? null : (
              <p className="m-0 whitespace-pre-line">{clip.description}</p>
            )}
            {clip.hashtags.length === 0 ? null : (
              <p className="m-0 text-fg-2">{clip.hashtags.join(" ")}</p>
            )}
          </div>
        </details>
      )}

      <ClientComments
        token={token}
        clip={clip}
        name={name}
        requireName={requireName}
        playhead={playhead}
        onSeek={(ms) => {
          const video = player.current;
          if (video === null) return;
          video.currentTime = ms / 1000;
          void video.play().catch(() => undefined);
        }}
      />
    </li>
  );
}

function ClientComments({
  token,
  clip,
  name,
  requireName,
  playhead,
  onSeek,
}: {
  readonly token: string;
  readonly clip: ClientClip;
  readonly name: string;
  readonly requireName: boolean;
  readonly playhead: number | null;
  readonly onSeek: (ms: number) => void;
}): React.JSX.Element {
  const comment = useClientComment(token);
  const [body, setBody] = React.useState("");
  const [atTime, setAtTime] = React.useState(true);
  const [needName, setNeedName] = React.useState(false);
  const id = `client-comment-${clip.id}`;

  return (
    <section className="flex flex-col gap-2" aria-label={`${CLIENT_COPY.comments}: ${clip.title}`}>
      {clip.comments.length === 0 ? null : (
        <>
          <h3 className="m-0 text-xs font-semibold tracking-wide text-fg-2 uppercase">
            {CLIENT_COPY.comments}
          </h3>
          <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
            {clip.comments.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-1 py-2"
                data-testid={`client-comment-${entry.id}`}
              >
                {entry.atMs === null ? null : (
                  <button
                    type="button"
                    className="min-h-11 self-start rounded-sm font-mono text-xs text-fg-1 underline underline-offset-4"
                    aria-label={CLIENT_COPY.seek(clipClock(entry.atMs))}
                    onClick={() => {
                      if (entry.atMs !== null) onSeek(entry.atMs);
                    }}
                  >
                    {clipClock(entry.atMs)}
                  </button>
                )}
                <p className="m-0 text-sm break-words whitespace-pre-line text-fg-0">
                  {entry.body}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim() === "") return;
          if (requireName && name.trim() === "") {
            setNeedName(true);
            return;
          }
          setNeedName(false);
          comment.mutate(
            {
              clipId: clip.id,
              body,
              name,
              ...(atTime && playhead !== null ? { atMs: playhead } : {}),
            },
            {
              onSuccess: () => {
                setBody("");
              },
            },
          );
        }}
      >
        <label htmlFor={id} className="text-sm font-medium text-fg-1">
          {CLIENT_COPY.commentLabel}
        </label>
        <Textarea
          id={id}
          rows={2}
          maxLength={2_000}
          placeholder={CLIENT_COPY.commentPlaceholder}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          data-testid={`${id}-body`}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {playhead === null ? (
            <span />
          ) : (
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-fg-1">
              <Checkbox
                checked={atTime}
                onCheckedChange={(value) => {
                  setAtTime(value === true);
                }}
              />
              {CLIENT_COPY.atTime(clipClock(playhead))}
            </label>
          )}
          <Button
            type="submit"
            variant="secondary"
            className="h-11"
            disabled={comment.isPending || body.trim() === ""}
            data-testid={`${id}-post`}
          >
            {comment.isPending ? CLIENT_COPY.posting : CLIENT_COPY.postComment}
          </Button>
        </div>
        {needName ? (
          <p role="alert" className="m-0 text-sm text-rejected">
            {CLIENT_COPY.nameFirst}
          </p>
        ) : null}
        {comment.isError ? (
          <p role="alert" className="m-0 text-sm text-rejected">
            {errorText(comment.error)}
          </p>
        ) : null}
      </form>
    </section>
  );
}

/**
 * The bar fixed to the bottom of the screen: the decision on the clip in view,
 * as two thumb-sized buttons, and what should change when that is the answer.
 */
function DecisionBar({
  token,
  clip,
  position,
  name,
  requireName,
  onName,
  onDecided,
}: {
  readonly token: string;
  readonly clip: ClientClip;
  readonly position: string;
  readonly name: string;
  readonly requireName: boolean;
  readonly onName: (name: string) => void;
  readonly onDecided: () => void;
}): React.JSX.Element {
  const decide = useClientDecision(token);
  const [asking, setAsking] = React.useState(false);
  const [note, setNote] = React.useState("");
  const missingName = requireName && name.trim() === "";
  const canDecide = clip.video !== null && !missingName && !decide.isPending;

  const send = (decision: "approved" | "changes_requested"): void => {
    if (clip.video === null) return;
    decide.mutate(
      {
        clipId: clip.id,
        decision,
        name,
        expect: clip.video.exportId,
        ...(decision === "changes_requested" ? { note } : {}),
      },
      {
        onSuccess: () => {
          setAsking(false);
          setNote("");
          onDecided();
        },
      },
    );
  };

  return (
    <div
      role="region"
      aria-label={CLIENT_COPY.decisionRegion}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]"
      data-testid="client-decision-bar"
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-2">
        <p className="m-0 truncate text-xs text-fg-2" data-testid="client-decision-target">
          {position} · <span className="text-fg-1">{clip.title}</span>
        </p>
        {missingName ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="reviewer-name-bar" className="text-xs text-fg-1">
              {CLIENT_COPY.nameFirst}
            </label>
            <Input
              id="reviewer-name-bar"
              autoComplete="name"
              maxLength={60}
              className="h-11"
              value={name}
              onChange={(event) => {
                onName(event.target.value);
              }}
              data-testid="reviewer-name-bar"
            />
          </div>
        ) : null}
        {asking ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (note.trim() !== "") send("changes_requested");
            }}
          >
            <label htmlFor="client-changes-note" className="text-sm font-medium text-fg-1">
              {CLIENT_COPY.changesLabel}
            </label>
            <Textarea
              id="client-changes-note"
              rows={3}
              maxLength={2_000}
              placeholder={CLIENT_COPY.changesPlaceholder}
              value={note}
              autoFocus
              onChange={(event) => {
                setNote(event.target.value);
              }}
              data-testid="client-changes-note"
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-12"
                onClick={() => {
                  setAsking(false);
                }}
              >
                {CLIENT_COPY.cancel}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="h-12"
                disabled={!canDecide || note.trim() === ""}
                data-testid="client-changes-send"
              >
                {decide.isPending ? CLIENT_COPY.sending : CLIENT_COPY.send}
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="h-12"
              disabled={!canDecide}
              onClick={() => {
                decide.reset();
                setAsking(true);
              }}
              data-testid="client-request-changes"
            >
              <PenLine strokeWidth={1.75} aria-hidden="true" />
              {CLIENT_COPY.requestChanges}
            </Button>
            <Button
              variant="primary"
              size="lg"
              className="h-12"
              disabled={!canDecide}
              onClick={() => {
                send("approved");
              }}
              data-testid="client-approve"
            >
              <CheckCircle2 strokeWidth={1.75} aria-hidden="true" />
              {decide.isPending && decide.variables?.decision === "approved"
                ? CLIENT_COPY.approving
                : CLIENT_COPY.approve}
            </Button>
          </div>
        )}
        {decide.isError ? (
          <p role="alert" className="m-0 text-sm text-rejected" data-testid="client-decision-error">
            {errorText(decide.error)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
