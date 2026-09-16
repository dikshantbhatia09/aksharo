"use client";

/**
 * `/repurpose` — the pipeline's front page.
 *
 * The premium canvas draws the pipeline as one screen: the pitch, a place to
 * put a link, the stage rail, and the stage you are on. That screen is
 * `/repurpose/[runId]`, because every one of those things is a property of a
 * *run*. This is what the rail's "Clips pipeline" entry opens when there is no
 * run to open: the same pitch and the same link field, plus the runs this
 * workspace already has.
 *
 * With a run in flight it sends you straight into it rather than making you
 * pick it out of a list — the canvas's own behaviour, where the banner's
 * "Open the pipeline" goes to the live run.
 */
import { ArrowRight, Link2, Waypoints } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useFeatureFlag, useRepurposeRuns } from "@montaj/api-client";
import type { RepurposeRunView } from "@montaj/api-client";
import { Button, EmptyState, Skeleton, cn } from "@montaj/ui";


import { REPURPOSE_FLOW_FLAG } from "@/components/home/pipeline-banner";
import { formatRelative } from "@/components/projects/project-table";


function isLive(run: RepurposeRunView): boolean {
  return run.stages.some((stage) => stage.state === "running");
}

export function RepurposeIndexView(): React.JSX.Element {
  const enabled = useFeatureFlag(REPURPOSE_FLOW_FLAG);
  const runs = useRepurposeRuns(enabled);
  const router = useRouter();
  const [url, setUrl] = React.useState("");

  if (!enabled) {
    return (
      <EmptyState
        icon={<Waypoints aria-hidden="true" />}
        title="The clips pipeline is not on for this workspace yet"
        description="It turns one long video into short, captioned clips you review before anything is posted. We will let you know when it reaches your workspace."
      />
    );
  }

  const items = runs.data?.items ?? [];
  const live = items.find(isLive);

  const start = (): void => {
    const trimmed = url.trim();
    router.push(
      trimmed === "" ? "/repurpose/new" : `/repurpose/new?url=${encodeURIComponent(trimmed)}`,
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="repurpose-index">
      <header className="max-w-[60ch]">
        <h1 className="font-display m-0 mb-[5px] text-[23px] tracking-[-0.02em]">
          One long video, nine posts
        </h1>
        <p className="text-neutral-400 m-0 text-[13px]">
          Paste a link and the pipeline runs end to end: read the transcript, find the moments
          worth cutting, reframe, caption, build a version per platform, then post on a schedule
          you set. Every stage is resumable and nothing publishes until you say so.
        </p>
      </header>

      <form
        className="bg-surface flex flex-wrap items-center gap-2 rounded-md px-3 py-[11px]"
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <span className="relative flex min-w-[240px] flex-1 items-center">
          <Link2
            className="text-neutral-500 pointer-events-none absolute left-2.5 size-[13px]"
            aria-hidden="true"
          />
          <input
            className="border-border bg-bg-0 text-fg-0 placeholder:text-neutral-500 hover:border-neutral-500 focus-visible:border-accent h-9 w-full rounded-sm border pr-2.5 pl-[30px] text-sm"
            placeholder="Paste a YouTube link"
            aria-label="YouTube link to repurpose"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            data-testid="index-url"
          />
        </span>
        <Button type="submit" variant="primary" className="h-9">
          Read the video
        </Button>
        <Button variant="secondary" className="h-9" asChild>
          <NextLink href="/repurpose/new">Upload a file</NextLink>
        </Button>
      </form>

      {live === undefined ? null : (
        <NextLink
          href={`/repurpose/${live.id}`}
          className="border-accent bg-accent/9 flex flex-wrap items-center gap-3 rounded-md border px-3.5 py-3"
          data-testid="repurpose-live-run"
        >
          <span className="bg-accent size-[5px] rounded-full" aria-hidden="true" />
          <span className="text-neutral-300 text-[12.5px]">
            {live.sourceDisplay ?? "A video"} — {live.message}
          </span>
          <span className="text-accent ml-auto flex items-center gap-1.5 text-xs">
            Open the pipeline <ArrowRight className="size-3" aria-hidden="true" />
          </span>
        </NextLink>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display m-0 text-[17px] tracking-[-0.01em]">Your runs</h2>
        {runs.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Waypoints aria-hidden="true" />}
            title="No runs yet"
            description="Paste a link above, or upload a long video, and the first stage starts."
          />
        ) : (
          <ul className="bg-surface flex flex-col rounded-md px-3.5 py-1">
            {items.map((run) => (
              <li key={run.id}>
                <NextLink
                  href={`/repurpose/${run.id}`}
                  className="rule-fade-b flex flex-wrap items-center gap-3 py-2.5 no-underline"
                  data-testid={`repurpose-run-${run.id}`}
                >
                  <span
                    className={cn(
                      "size-[5px] shrink-0 rounded-full",
                      isLive(run) ? "bg-accent" : "bg-neutral-600",
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate text-[12.5px]">
                    {run.sourceDisplay ?? "Your upload"}
                  </span>
                  <span className="text-neutral-500 text-[11.5px]">{run.message}</span>
                  <span className="text-neutral-500 ml-auto font-mono text-[11px]">
                    {formatRelative(run.updatedAt)}
                  </span>
                </NextLink>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
