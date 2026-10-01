"use client";

/**
 * A clip, opened (2026-10-01, from OpusClip's clip view): everything about one
 * clip in one place, and the next one a key away.
 *
 *   * Its rank and title, the title editable in place (editors and up).
 *   * Why it scored as it did: the overall score, then Hook / Flow / Value /
 *     Trend each graded with its reason (`clip-analysis.ts`), and the people it
 *     names.
 *   * One-click tools: open it in the editor, or straight on its B-roll or its
 *     audio clean-up (`/p/{id}?panel=broll|audio`).
 *   * "For your editing app" (2026-10-01): its version without captions, its
 *     captions and timelines for Premiere Pro, Final Cut Pro and DaVinci
 *     Resolve, as one ZIP (`download/ClipEditingDownload.tsx`).
 *   * Its words, timed on the original video's clock ("[01:34 - 02:04]").
 *   * The clip itself, with every action it already had on the run page - its
 *     videos and downloads, every size, its dubs, its words to post, its
 *     review, posting - by rendering the run page's own card for it.
 *
 * ← and → step through the clips in the order the page shows them; Esc closes.
 */
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Images,
  Pencil,
  Sparkles,
  Users,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  clipCopyOf,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
} from "@montaj/api-client";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Kbd,
  cn,
} from "@montaj/ui";

import { analysisOf, type AnalysisPart } from "./clip-analysis";
import { useClipTranscript, useRetitleClip } from "./use-results";

import { ClipEditingDownload } from "@/components/repurpose/download/ClipEditingDownload";
import { formatClock } from "@/components/repurpose/moment-time";

export interface ClipEntry {
  readonly candidate: RepurposeCandidateItem;
  readonly clip: RepurposeClipItem | undefined;
  /** Its place by score, 1 for the best. */
  readonly rank: number;
}

export interface ClipDetailDialogProps {
  readonly runId: string;
  /** The clips in the order the page shows them. */
  readonly entries: readonly ClipEntry[];
  /** The open clip's place in `entries`, or null when none is open. */
  readonly index: number | null;
  readonly onIndexChange: (index: number | null) => void;
  /** Editors and up may rename a clip. */
  readonly canEdit: boolean;
  /** The run page's own card for a clip: its videos and every action it has. */
  readonly renderCard: (entry: ClipEntry) => React.ReactNode;
}

const SOURCE_WORDS: Readonly<Record<NonNullable<AnalysisPart["source"]>, string>> = {
  ai: "AI editor",
  measured: "Measured",
};

function gradeTone(score: number | null): string {
  if (score === null) return "text-fg-2";
  if (score >= 80) return "text-accepted";
  if (score >= 60) return "text-warning";
  return "text-rejected";
}

export function ClipDetailDialog({
  runId,
  entries,
  index,
  onIndexChange,
  canEdit,
  renderCard,
}: ClipDetailDialogProps): React.JSX.Element {
  const entry = index === null ? undefined : entries.at(index);
  const open = entry !== undefined;
  const total = entries.length;
  const step = React.useCallback(
    (delta: number) => {
      if (index === null || total === 0) return;
      onIndexChange((index + delta + total) % total);
    },
    [index, total, onIndexChange],
  );

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "VIDEO"].includes(target.tagName));
      if (typing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, step]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onIndexChange(null);
      }}
    >
      <DialogContent
        className="max-h-[94vh] w-[96vw] max-w-6xl overflow-y-auto p-0"
        data-testid="clip-detail"
      >
        {entry === undefined ? null : (
          <DetailBody
            key={entry.candidate.id}
            runId={runId}
            entry={entry}
            position={(index ?? 0) + 1}
            total={total}
            canEdit={canEdit}
            onStep={step}
            card={renderCard(entry)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailBody({
  runId,
  entry,
  position,
  total,
  canEdit,
  onStep,
  card,
}: {
  readonly runId: string;
  readonly entry: ClipEntry;
  readonly position: number;
  readonly total: number;
  readonly canEdit: boolean;
  readonly onStep: (delta: number) => void;
  readonly card: React.ReactNode;
}): React.JSX.Element {
  const { candidate, clip, rank } = entry;
  const copy = clipCopyOf(clip?.copy) ?? clipCopyOf(candidate.copy);
  const title = copy?.title ?? candidate.title ?? candidate.headline ?? "Suggested moment";
  const analysis = analysisOf(candidate);
  const projectId = (
    clip?.variants?.find((variant) => variant.aspect === "r9x16") ?? clip?.variants?.[0]
  )?.projectId;
  const ready = clip !== undefined && clip.state === "ready";

  return (
    <div className="flex flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-surface px-5 py-3">
        <span className="font-mono text-sm text-fg-2">#{String(rank)}</span>
        <TitleEditor runId={runId} candidateId={candidate.id} title={title} canEdit={canEdit} />
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-2 text-xs text-fg-2" data-testid="clip-detail-position">
            {String(position)} of {String(total)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous clip"
            title="Previous clip (←)"
            disabled={total < 2}
            onClick={() => {
              onStep(-1);
            }}
            data-testid="clip-detail-previous"
          >
            <ChevronLeft strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next clip"
            title="Next clip (→)"
            disabled={total < 2}
            onClick={() => {
              onStep(1);
            }}
            data-testid="clip-detail-next"
          >
            <ChevronRight strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
        <DialogDescription className="sr-only">
          Why this clip scored as it did, its words, and everything you can do with it. Use the left
          and right arrow keys for the previous and next clip, and Escape to close.
        </DialogDescription>
      </header>

      <div className="grid gap-5 p-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-5" aria-label="Clip analysis">
          <section className="flex flex-col gap-3" data-testid="clip-analysis">
            <div className="flex items-baseline gap-2">
              {analysis.overall === null ? (
                <span className="text-sm text-fg-2">Not scored</span>
              ) : (
                <>
                  <span
                    className={cn(
                      "font-display text-4xl leading-none",
                      gradeTone(analysis.overall),
                    )}
                    data-testid="clip-analysis-overall"
                  >
                    {String(analysis.overall)}
                  </span>
                  <span className="text-sm text-fg-2">/100</span>
                </>
              )}
            </div>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {analysis.parts.map((part) => (
                <li key={part.key} data-testid={`clip-analysis-${part.key}`}>
                  <details
                    className="group rounded-sm border border-border bg-bg-0"
                    open={part.note !== null && part.key === "hook"}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-fg-0">{part.label}</span>
                        <span className="block text-2xs text-fg-2">{part.question}</span>
                      </span>
                      <span
                        className={cn("font-display text-xl leading-none", gradeTone(part.score))}
                        data-testid={`clip-analysis-${part.key}-grade`}
                      >
                        {part.grade ?? "–"}
                      </span>
                    </summary>
                    <div className="border-t border-border px-3 py-2 text-xs text-fg-1">
                      {part.note ?? "No reason was written for this part."}
                      {part.source === null ? null : (
                        <span className="mt-1 block text-2xs text-fg-2">
                          {SOURCE_WORDS[part.source]}
                          {part.score === null ? "" : ` · ${String(part.score)}/100`}
                        </span>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
            {analysis.people.length === 0 ? null : (
              <div className="flex flex-col gap-1.5" data-testid="clip-analysis-people">
                <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
                  <Users className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Relevant people
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {analysis.people.map((name) => (
                    <Badge key={name} tone="neutral">
                      {name}
                    </Badge>
                  ))}
                </span>
              </div>
            )}
          </section>

          {projectId === undefined || !ready ? null : (
            <section className="flex flex-col gap-1.5" aria-label="Edit this clip">
              <span className="text-xs text-fg-2">Edit this clip</span>
              <QuickAction
                href={`/p/${projectId}`}
                icon={Clapperboard}
                label="Open in the editor"
                testId="clip-detail-edit"
              />
              <QuickAction
                href={`/p/${projectId}?panel=broll`}
                icon={Images}
                label="Add B-roll"
                testId="clip-detail-broll"
              />
              <QuickAction
                href={`/p/${projectId}?panel=audio`}
                icon={AudioLines}
                label="Enhance speech"
                testId="clip-detail-audio"
              />
              <QuickAction
                href={`/p/${projectId}?panel=style`}
                icon={Sparkles}
                label="Change the caption style"
                testId="clip-detail-style"
              />
            </section>
          )}

          <ClipEditingDownload runId={runId} clip={clip} />

          <ClipTranscript runId={runId} candidateId={candidate.id} />

          <p className="m-0 hidden items-center gap-1.5 text-2xs text-fg-2 lg:flex">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd> previous and next clip · <Kbd>Esc</Kbd> close
          </p>
        </aside>

        <div className="min-w-0">
          <ul className="m-0 list-none p-0">{card}</ul>
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
  testId,
}: {
  readonly href: string;
  readonly icon: typeof Clapperboard;
  readonly label: string;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <Button variant="secondary" size="sm" className="justify-start" asChild>
      <Link href={href} className="no-underline" data-testid={testId}>
        <Icon strokeWidth={1.75} aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}

function TitleEditor({
  runId,
  candidateId,
  title,
  canEdit,
}: {
  readonly runId: string;
  readonly candidateId: string;
  readonly title: string;
  readonly canEdit: boolean;
}): React.JSX.Element {
  const retitle = useRetitleClip();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(title);
  const shown = retitle.isSuccess ? retitle.data.title : title;

  if (!editing) {
    return (
      <div className="flex min-w-0 flex-[1_1_320px] items-center gap-2">
        <DialogTitle
          className="m-0 truncate text-base font-semibold text-fg-0"
          data-testid="clip-detail-title"
        >
          {shown}
        </DialogTitle>
        {canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Rename this clip"
            title="Rename this clip"
            onClick={() => {
              setDraft(shown);
              setEditing(true);
            }}
            data-testid="clip-detail-rename"
          >
            <Pencil strokeWidth={1.75} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="flex min-w-0 flex-[1_1_320px] items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (next === "" || next === shown) {
          setEditing(false);
          return;
        }
        retitle.mutate(
          { runId, candidateId, title: next },
          {
            onSuccess: () => {
              setEditing(false);
            },
          },
        );
      }}
    >
      <DialogTitle className="sr-only">{shown}</DialogTitle>
      <Input
        autoFocus
        value={draft}
        maxLength={160}
        aria-label="Clip title"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setEditing(false);
          }
        }}
        data-testid="clip-detail-title-input"
      />
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={retitle.isPending}
        data-testid="clip-detail-title-save"
      >
        {retitle.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setEditing(false);
        }}
      >
        Cancel
      </Button>
      {retitle.isError ? (
        <span role="alert" className="text-xs text-rejected">
          The title was not saved. Try again.
        </span>
      ) : null}
    </form>
  );
}

function ClipTranscript({
  runId,
  candidateId,
}: {
  readonly runId: string;
  readonly candidateId: string;
}): React.JSX.Element | null {
  const transcript = useClipTranscript(runId, candidateId, true);
  const lines = transcript.data?.lines ?? [];
  if (transcript.isPending) {
    return <p className="m-0 text-xs text-fg-2">Loading its words…</p>;
  }
  if (lines.length === 0) return null;
  const first = lines.at(0);
  const last = lines.at(-1);
  return (
    <section
      className="flex flex-col gap-1.5"
      aria-label="What is said"
      data-testid="clip-transcript"
    >
      <span className="text-xs text-fg-2">
        What is said
        {first === undefined || last === undefined
          ? ""
          : ` · [${formatClock(first.startMs)} - ${formatClock(last.endMs)}] in the original video`}
      </span>
      <ol className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto rounded-sm border border-border bg-sunken p-2">
        {lines.map((line) => (
          <li
            key={`${String(line.startMs)}-${line.text.slice(0, 12)}`}
            className="flex gap-2 text-xs"
          >
            <span className="shrink-0 font-mono text-2xs text-fg-2">
              {formatClock(line.startMs)}
            </span>
            <span className="text-fg-1">{line.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
