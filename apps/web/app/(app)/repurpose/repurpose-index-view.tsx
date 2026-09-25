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
 * A run in flight is surfaced at the top as a plain card with one link into
 * it, rather than as an accent-tinted banner: Shirorekha spends the accent on
 * the page's one primary action ("Read the video"), and a second rani block
 * above the list would compete with it.
 */
import { ArrowRight, Link2, Waypoints } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useFeatureFlag, useRepurposeRuns } from "@montaj/api-client";
import type { RepurposeRunView } from "@montaj/api-client";
import { Button, EmptyState, PageHeader, Skeleton, cn } from "@montaj/ui";

import { REPURPOSE_FLOW_FLAG } from "@/components/home/pipeline-banner";
import { formatRelative } from "@/components/projects/project-table";

function isLive(run: RepurposeRunView): boolean {
  return run.stages.some((stage) => stage.state === "running");
}

const PAGE_TITLE = "One long video, nine posts";

export function RepurposeIndexView(): React.JSX.Element {
  const enabled = useFeatureFlag(REPURPOSE_FLOW_FLAG);
  const runs = useRepurposeRuns(enabled);
  const router = useRouter();
  const [url, setUrl] = React.useState("");

  if (!enabled) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader eyebrow="Clips pipeline" title={PAGE_TITLE} />
        <EmptyState
          icon={<Waypoints aria-hidden="true" />}
          title="The clips pipeline is not on for this workspace yet"
          description="It turns one long video into short, captioned clips you review before anything is posted. You will be told here when it reaches your workspace."
        />
      </div>
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
    <div className="flex flex-col gap-8" data-testid="repurpose-index">
      <PageHeader
        eyebrow="Clips pipeline"
        title={PAGE_TITLE}
        description="Paste a link and the pipeline runs end to end: it reads the transcript, finds the moments worth cutting, reframes and captions them, and builds a version per platform. Every stage can be resumed, and nothing is posted until you say so."
      />

      <section aria-labelledby="repurpose-start-heading" className="flex flex-col gap-3">
        <h2 id="repurpose-start-heading" className="text-base text-fg-0">
          Start a new run
        </h2>
        <form
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-5"
          onSubmit={(event) => {
            event.preventDefault();
            start();
          }}
        >
          <span className="relative flex min-w-0 flex-[1_1_240px] items-center">
            <Link2
              className="pointer-events-none absolute left-3 size-4 text-fg-2"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              className="h-9 w-full rounded-sm border border-border bg-sunken pr-3 pl-9 text-sm text-fg-0 placeholder:text-fg-2 hover:border-neutral-600"
              // No `type="url"`: native validation would block a scheme-less
              // link before `start()` hands it to /repurpose/new, which owns
              // the real check.
              inputMode="url"
              placeholder="Paste a YouTube link"
              aria-label="YouTube link to repurpose"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
              data-testid="index-url"
            />
          </span>
          <Button type="submit" variant="primary">
            Read the video
          </Button>
          <Button variant="secondary" asChild>
            <NextLink href="/repurpose/new" className="no-underline">
              Upload a file instead
            </NextLink>
          </Button>
        </form>
      </section>

      {live === undefined ? null : (
        <NextLink
          href={`/repurpose/${live.id}`}
          className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-5 py-4 no-underline hover:bg-neutral-100/5"
          data-testid="repurpose-live-run"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium text-fg-2">In progress</span>
            <span className="truncate text-sm text-fg-0">
              {live.sourceDisplay ?? "A video"} — {live.message}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-sm text-fg-1">
            Open this run <ArrowRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
        </NextLink>
      )}

      <section aria-labelledby="repurpose-runs-heading" className="flex flex-col gap-3">
        <h2 id="repurpose-runs-heading" className="text-base text-fg-0">
          Your runs
        </h2>
        {runs.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : runs.isError ? (
          <p role="alert" className="text-sm text-fg-1">
            Your runs could not be loaded. Refresh the page to try again.
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Waypoints aria-hidden="true" />}
            title="No runs yet"
            description="Paste a link above, or upload a long video, and the first stage starts."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
            {items.map((run) => {
              const running = isLive(run);
              return (
                <li key={run.id}>
                  <NextLink
                    href={`/repurpose/${run.id}`}
                    className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 no-underline hover:bg-neutral-100/5"
                    data-testid={`repurpose-run-${run.id}`}
                  >
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        running ? "bg-accepted" : "bg-neutral-600",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate text-sm text-fg-0">
                      {run.sourceDisplay ?? "Your upload"}
                    </span>
                    <span className="text-xs text-fg-2">
                      {/* The dot is decoration; the state is said in words. */}
                      {running ? "In progress · " : ""}
                      {run.message}
                    </span>
                    <span className="ml-auto font-mono text-2xs text-fg-2">
                      {formatRelative(run.updatedAt)}
                    </span>
                  </NextLink>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
