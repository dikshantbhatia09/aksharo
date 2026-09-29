"use client";

/**
 * `/repurpose/automations` - set-and-forget clips (2026-10-02).
 *
 * Connect a YouTube channel once, choose the settings its videos run with, and
 * every new video it publishes becomes clips on Autopilot. The page lists each
 * automation with what it has done, and lets an editor pause, resume, change or
 * remove it. Everything here is the server's to say: the list is re-read after
 * every change and every minute while the page is open.
 *
 * Three flags gate it, as they gate the API: the clips pipeline itself, YouTube
 * links, and automations. Off, the page says so rather than offering a form the
 * server would refuse; a 404 from the list reads the same way (the deployment's
 * kill switch can turn it off without the snapshot here knowing).
 */
import { Radar } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { isApiError, useFeatureFlag } from "@montaj/api-client";
import { Button, EmptyState, PageHeader, Skeleton } from "@montaj/ui";

import { REPURPOSE_FLOW_FLAG } from "@/components/home/pipeline-banner";
import { AddChannelForm } from "@/components/repurpose/automations/AddChannelForm";
import { AUTOMATIONS_COPY } from "@/components/repurpose/automations/automations-copy";
import { AUTOMATIONS_FLAG, useWatches } from "@/components/repurpose/automations/use-automations";
import { WatchCard } from "@/components/repurpose/automations/WatchCard";

/** YouTube links: a channel's videos are links, so they are off without it. */
const YOUTUBE_FLAG = "source_youtube_acquire";

export function AutomationsView(): React.JSX.Element {
  const flow = useFeatureFlag(REPURPOSE_FLOW_FLAG);
  const youtube = useFeatureFlag(YOUTUBE_FLAG);
  const automations = useFeatureFlag(AUTOMATIONS_FLAG);
  const enabled = flow && youtube && automations;
  const watches = useWatches(enabled);
  const [editing, setEditing] = React.useState<string | null>(null);

  const header = (
    <PageHeader
      eyebrow={AUTOMATIONS_COPY.eyebrow}
      title={AUTOMATIONS_COPY.title}
      description={AUTOMATIONS_COPY.description}
      actions={
        <Button variant="ghost" size="sm" asChild>
          <NextLink href="/repurpose" className="no-underline">
            {AUTOMATIONS_COPY.runsLink}
          </NextLink>
        </Button>
      }
    />
  );

  const refusedAsOff = isApiError(watches.error) && watches.error.status === 404;
  if (!enabled || refusedAsOff) {
    return (
      <div className="flex flex-col gap-8" data-testid="automations-off">
        {header}
        <EmptyState
          icon={<Radar aria-hidden="true" />}
          title={AUTOMATIONS_COPY.off.title}
          description={AUTOMATIONS_COPY.off.description}
        />
      </div>
    );
  }

  const list = watches.data;
  const items = list?.items ?? [];
  const atLimit = list !== undefined && items.length >= list.maxWatches;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8" data-testid="automations">
      {header}

      {list !== undefined && !list.checksEnabled ? (
        <p
          role="status"
          className="m-0 rounded-md border border-border bg-bg-2 px-4 py-3 text-sm text-fg-1"
          data-testid="automations-checks-off"
        >
          {AUTOMATIONS_COPY.checksOff}
        </p>
      ) : null}

      <AddChannelForm atLimit={atLimit} maxWatches={list?.maxWatches ?? 20} />

      <section aria-labelledby="watch-list-heading" className="flex flex-col gap-3">
        <h2 id="watch-list-heading" className="text-base text-fg-0">
          {AUTOMATIONS_COPY.list.heading}
        </h2>
        {watches.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : watches.isError ? (
          <p role="alert" className="text-sm text-fg-1">
            {AUTOMATIONS_COPY.loadError}
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Radar aria-hidden="true" />}
            title={AUTOMATIONS_COPY.list.emptyTitle}
            description={AUTOMATIONS_COPY.list.emptyDescription}
          />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="watch-list">
            {items.map((watch) => (
              <WatchCard
                key={watch.id}
                watch={watch}
                editing={editing === watch.id}
                onEdit={() => {
                  setEditing(watch.id);
                }}
                onDoneEditing={() => {
                  setEditing(null);
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
