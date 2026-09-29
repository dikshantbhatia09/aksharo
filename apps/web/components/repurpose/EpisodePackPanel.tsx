"use client";

/**
 * The episode text (2026-09-29): what the creator posts with the WHOLE video,
 * beside its clips. Chapters, a YouTube description, show notes, a LinkedIn
 * post, an X thread and a newsletter draft, each with a Copy button.
 *
 * Written from the run's source video by the language model, in the run's
 * language and script, at no cost to the person (`/repurpose/runs/{id}/episode-pack`).
 * An Autopilot run asks for it once its moments are found; any other run can
 * ask with "Write the episode text", and ask again if it failed.
 *
 * The chapters come as data and are put on the VIDEO's clock here: a run over
 * part of a long video processed a file that starts where its part starts,
 * and YouTube wants the times of the video it is posted on. Only a run over
 * the whole video gets the "0:00" first line YouTube needs to show chapters.
 */
import { AlertTriangle, Loader2 } from "lucide-react";
import * as React from "react";

import {
  isApiError,
  useRepurposeEpisodePack,
  useWriteEpisodePack,
  type RepurposeEpisodePack,
  type RepurposeRunView,
} from "@montaj/api-client";
import { Button, Skeleton } from "@montaj/ui";

import { formatChapterTimestamp } from "@/components/editor/insights/formatChapters";
import { CopyTextButton } from "@/components/repurpose/copy-text";

export const EPISODE_PACK_COPY = Object.freeze({
  heading: "Episode text",
  intro: "Chapters, descriptions and posts for the whole video.",
  write: "Write the episode text",
  writing: "Writing the episode text…",
  expected: "Written once your moments are found.",
  failed: "The episode text could not be written.",
  writeFailed: "That did not work. Try again in a moment.",
  tryAgain: "Try again",
  loadFailed: "The episode text could not be loaded. Refresh the page to try again.",
  chapters: "Chapters",
  youtube: "YouTube description",
  showNotes: "Show notes",
  linkedin: "LinkedIn post",
  xThread: "X thread",
  newsletter: "Newsletter",
  chaptersHeading: "Chapters",
  partNote: "Times are on the full video's clock.",
  byRule: "Taken from what was said: the AI could not write it this time.",
});

/** Before these, there is no transcript to write from. */
const EARLY: ReadonlySet<string> = new Set([
  "draft",
  "acquiring",
  "preparing_media",
  "transcribing",
]);
/** An Autopilot run in these asks for it by itself shortly. */
const FINDING: ReadonlySet<string> = new Set(["transcribing", "analyzing"]);

/** The chapter lines, on the video's clock (`offsetMs` is where the run's part starts). */
export function chapterLines(
  chapters: RepurposeEpisodePack["chapters"],
  offsetMs: number,
): string[] {
  return chapters.map((chapter, index) => {
    const at = chapter.startMs + offsetMs;
    // YouTube shows chapters only when the list starts at 0:00.
    const stamp = index === 0 && offsetMs === 0 ? "0:00" : formatChapterTimestamp(at);
    return `${stamp} ${chapter.title}`;
  });
}

/** The YouTube description as it is pasted: the text, then its chapters. */
export function youtubeDescriptionOf(pack: RepurposeEpisodePack, offsetMs: number): string {
  const lines = chapterLines(pack.chapters, offsetMs);
  return lines.length === 0
    ? pack.youtubeDescription
    : `${pack.youtubeDescription}\n\n${EPISODE_PACK_COPY.chaptersHeading}\n${lines.join("\n")}`;
}

function Block({
  id,
  label,
  text,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1" data-testid={`episode-pack-${id}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-2">{label}</h4>
        <CopyTextButton text={text} label={label.toLowerCase()} testId={`copy-episode-${id}`} />
      </div>
      {children ?? <p className="m-0 whitespace-pre-line break-words text-sm text-fg-1">{text}</p>}
    </section>
  );
}

function PackBody({
  pack,
  offsetMs,
}: {
  readonly pack: RepurposeEpisodePack;
  readonly offsetMs: number;
}): React.JSX.Element {
  const lines = chapterLines(pack.chapters, offsetMs);
  const thread = pack.xThread.map((post, index) =>
    pack.xThread.length > 1 ? `${String(index + 1)}/${String(pack.xThread.length)} ${post}` : post,
  );
  return (
    <div className="flex flex-col gap-4">
      {pack.source === "heuristic" ? (
        <p className="m-0 text-xs text-fg-2">{EPISODE_PACK_COPY.byRule}</p>
      ) : null}
      {lines.length === 0 ? null : (
        <Block id="chapters" label={EPISODE_PACK_COPY.chapters} text={lines.join("\n")}>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {lines.map((line) => {
              const [stamp, ...title] = line.split(" ");
              return (
                <li key={line} className="flex gap-2 text-sm text-fg-1">
                  <span className="shrink-0 font-mono text-xs text-fg-2">{stamp}</span>
                  <span className="min-w-0 break-words">{title.join(" ")}</span>
                </li>
              );
            })}
          </ol>
          {offsetMs > 0 ? (
            <p className="m-0 text-2xs text-fg-2">{EPISODE_PACK_COPY.partNote}</p>
          ) : null}
        </Block>
      )}
      <Block
        id="youtube"
        label={EPISODE_PACK_COPY.youtube}
        text={youtubeDescriptionOf(pack, offsetMs)}
      />
      <Block id="show-notes" label={EPISODE_PACK_COPY.showNotes} text={pack.showNotes} />
      <Block id="linkedin" label={EPISODE_PACK_COPY.linkedin} text={pack.linkedinPost} />
      <Block id="x-thread" label={EPISODE_PACK_COPY.xThread} text={thread.join("\n\n")}>
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {thread.map((post) => (
            <li key={post} className="flex items-start justify-between gap-2">
              <p className="m-0 min-w-0 whitespace-pre-line break-words text-sm text-fg-1">
                {post}
              </p>
              <CopyTextButton
                text={post}
                label={`${EPISODE_PACK_COPY.xThread.toLowerCase()} post`}
              />
            </li>
          ))}
        </ol>
      </Block>
      <Block id="newsletter" label={EPISODE_PACK_COPY.newsletter} text={pack.newsletter} />
    </div>
  );
}

export function EpisodePackPanel({
  run,
}: {
  readonly run: RepurposeRunView;
}): React.JSX.Element | null {
  const autopilot = run.automation === "auto";
  const query = useRepurposeEpisodePack(run.id, {
    expectSoon: autopilot && FINDING.has(run.status),
  });
  const write = useWriteEpisodePack();
  const view = query.data;
  const status = view?.status ?? "none";
  const early = EARLY.has(run.status);

  // Nothing to say before there is a transcript, unless it already exists; and
  // nothing at all from an API without the route (a 404 is "not here").
  if (early && status === "none" && !autopilot) return null;
  if (query.isError && isApiError(query.error) && query.error.status === 404) return null;

  const offsetMs = run.window?.startMs ?? 0;
  const writeError = write.isError ? EPISODE_PACK_COPY.writeFailed : null;
  const askButton = (label: string): React.JSX.Element => (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={write.isPending}
      onClick={() => {
        write.mutate(run.id);
      }}
      data-testid="episode-pack-write"
    >
      {write.isPending ? EPISODE_PACK_COPY.writing : label}
    </Button>
  );

  let body: React.ReactNode;
  if (query.isPending) {
    body = <Skeleton className="h-16 w-full" />;
  } else if (query.isError) {
    body = (
      <p className="m-0 text-sm text-fg-1" role="alert" data-testid="episode-pack-error">
        {EPISODE_PACK_COPY.loadFailed}
      </p>
    );
  } else if (status === "ready" && view?.pack) {
    body = (
      <>
        <PackBody pack={view.pack} offsetMs={offsetMs} />
        <p className="m-0 text-xs italic text-fg-2" data-testid="episode-pack-disclosure">
          {view.disclosure}
        </p>
      </>
    );
  } else if (status === "writing") {
    body = (
      <p
        className="m-0 inline-flex items-center gap-1.5 text-sm text-fg-1"
        role="status"
        data-testid="episode-pack-writing"
      >
        <Loader2 className="size-4 animate-spin text-fg-2" strokeWidth={1.75} aria-hidden="true" />
        {EPISODE_PACK_COPY.writing}
      </p>
    );
  } else if (status === "failed") {
    body = (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="episode-pack-failed"
      >
        <p className="m-0 inline-flex items-center gap-1.5 text-sm text-fg-1">
          <AlertTriangle
            className="size-4 shrink-0 text-rejected"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          {EPISODE_PACK_COPY.failed}
        </p>
        {askButton(EPISODE_PACK_COPY.tryAgain)}
      </div>
    );
  } else if (autopilot && (early || FINDING.has(run.status))) {
    body = (
      <p className="m-0 text-sm text-fg-2" data-testid="episode-pack-expected">
        {EPISODE_PACK_COPY.expected}
      </p>
    );
  } else {
    body = askButton(EPISODE_PACK_COPY.write);
  }

  return (
    <details
      className="rounded-md border border-border bg-bg-0"
      data-testid="episode-pack"
      data-state={status}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fg-0">
        {EPISODE_PACK_COPY.heading}{" "}
        <span className="text-xs font-normal text-fg-2">{EPISODE_PACK_COPY.intro}</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-4">
        {body}
        {writeError === null ? null : (
          <p
            className="m-0 text-sm text-rejected"
            role="alert"
            data-testid="episode-pack-write-error"
          >
            {writeError}
          </p>
        )}
      </div>
    </details>
  );
}
