"use client";

/**
 * The example run, read only (2026-10-01, OpusClip's "try a sample project"):
 * one finished run the owner chose (`DEMO_RUN_ID` on the API), so a person
 * who has not started anything yet sees what one video gives them - scored
 * clips, why each scored (the clip view's analysis and words), every size and
 * the images - before spending a credit.
 *
 * It is the run page's own results library (`RunClipResults`) in its
 * read-only mode, with a card of its own (`ExampleClipCard`): the clips play
 * and download one at a time; nothing renames, picks, edits, dubs, reviews or
 * posts. The one primary on the page is the banner's "Start your own".
 *
 * Shown to everyone the same way, so nothing on it names the workspace or the
 * people the run came from (the API sends none of that).
 */
import { Sparkles } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { Button, EmptyState, PageHeader, Skeleton } from "@montaj/ui";

import { ExampleClipCard } from "@/components/repurpose/example/ExampleClipCard";
import { useExampleRun, type ExampleRunView } from "@/components/repurpose/example/use-example-run";
import { formatClock } from "@/components/repurpose/moment-time";
import { RunClipResults } from "@/components/repurpose/results/RunClipResults";

export const EXAMPLE_COPY = Object.freeze({
  eyebrow: "Example",
  banner: "This is an example. Start your own from a link or a file.",
  start: "Start your own",
  noneTitle: "There is no example to show right now",
  noneText: "Start your own from a link or a file, and your clips appear here as they are made.",
});

/** A stable id for the results' own state; the example has no run of the reader's. */
const EXAMPLE_RUN_KEY = "example";

export function ExampleRunViewPage(): React.JSX.Element {
  const example = useExampleRun();

  if (example.isPending) {
    return (
      <div className="flex w-full flex-col gap-6" aria-busy="true">
        <PageHeader eyebrow={EXAMPLE_COPY.eyebrow} title="A finished example" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const data = example.data;
  if (data === undefined || !data.available) {
    return (
      <div className="flex w-full flex-col gap-6" data-testid="example-run-none">
        <PageHeader eyebrow={EXAMPLE_COPY.eyebrow} title="A finished example" />
        <EmptyState
          icon={<Sparkles aria-hidden="true" />}
          title={EXAMPLE_COPY.noneTitle}
          description={EXAMPLE_COPY.noneText}
          action={
            <Button variant="primary" asChild>
              <NextLink href="/repurpose/new" className="no-underline">
                {EXAMPLE_COPY.start}
              </NextLink>
            </Button>
          }
        />
      </div>
    );
  }

  return <ExampleRun view={data} />;
}

function describe(view: ExampleRunView): string {
  const clips = `${String(view.run.clipCount)} ${view.run.clipCount === 1 ? "clip" : "clips"}`;
  const from = view.run.source === "file" ? "an uploaded video" : "a video link";
  const length =
    view.run.processedMs === null || view.run.processedMs <= 0
      ? ""
      : ` (${formatClock(view.run.processedMs)} of it)`;
  return `${clips} made from ${from}${length}, each scored, captioned and made in every size.`;
}

function ExampleRun({ view }: { readonly view: ExampleRunView }): React.JSX.Element {
  const readOnly = React.useMemo(
    () => ({
      transcriptOf: (candidateId: string) =>
        Object.prototype.hasOwnProperty.call(view.transcripts, candidateId)
          ? // eslint-disable-next-line security/detect-object-injection -- an own key, checked above
            view.transcripts[candidateId]
          : undefined,
    }),
    [view.transcripts],
  );

  return (
    <div className="flex w-full flex-col gap-6" data-testid="example-run">
      <PageHeader
        eyebrow={EXAMPLE_COPY.eyebrow}
        title={view.run.title}
        description={describe(view)}
      />

      <div
        role="note"
        className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3"
        data-testid="example-run-banner"
      >
        <p className="m-0 min-w-0 flex-[1_1_240px] text-sm text-fg-1">{EXAMPLE_COPY.banner}</p>
        <Button variant="primary" size="sm" asChild>
          <NextLink href="/repurpose/new" className="no-underline" data-testid="example-run-start">
            {EXAMPLE_COPY.start}
          </NextLink>
        </Button>
      </div>

      <RunClipResults
        runId={EXAMPLE_RUN_KEY}
        candidates={view.candidates}
        clips={view.clips}
        picking={false}
        canEdit={false}
        readOnly={readOnly}
        renderCard={(candidate, options) => (
          <ExampleClipCard
            candidate={candidate}
            clip={view.clips.find((clip) => clip.candidateId === candidate.id)}
            {...(options.onOpenDetails === undefined
              ? {}
              : { onOpenDetails: options.onOpenDetails })}
          />
        )}
      />
    </div>
  );
}
