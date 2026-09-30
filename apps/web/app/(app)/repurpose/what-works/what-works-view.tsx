"use client";

/**
 * `/repurpose/what-works` (2026-10-05): which posted clips did best, and what
 * they share.
 *
 * Everything is the server's to say (`GET /repurpose/performance/what-works`):
 * the best clips by views and by engagement, each kind of clip against the
 * rest - length, opening, topic words, layout, language, when it went out -
 * compared platform by platform, every group with its number of posts, and
 * nothing called a difference from fewer than a handful. The page adds only
 * the words. And it says what the next runs' picks lean toward, and that the
 * person's own choices come first.
 *
 * Two flags gate it, as they gate the API: the clips pipeline and this. Off,
 * the page says so; a 404 reads the same way.
 */
import { BarChart3, TrendingUp } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { isApiError, useFeatureFlag } from "@montaj/api-client";
import { Button, EmptyState, PageHeader, Skeleton } from "@montaj/ui";

import { REPURPOSE_FLOW_FLAG } from "@/components/home/pipeline-banner";
import {
  WHAT_WORKS_COPY,
  compactCount,
  percent,
  platformName,
} from "@/components/repurpose/performance/copy";
import {
  PERFORMANCE_FLAG,
  useWhatWorks,
  type DimensionView,
  type TopClipView,
  type WhatWorks,
} from "@/components/repurpose/performance/use-performance";

function times(value: number | null): string {
  return value === null ? "–" : `${value.toFixed(1)}×`;
}

function TopClips({
  heading,
  clips,
  empty,
  testId,
  metric,
}: {
  readonly heading: string;
  readonly clips: readonly TopClipView[];
  readonly empty: string;
  readonly testId: string;
  readonly metric: "views" | "engagement";
}): React.JSX.Element {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-[1_1_280px] flex-col gap-3 rounded-md border border-border bg-surface p-4"
      data-testid={testId}
    >
      <h2 id={id} className="m-0 text-base text-fg-0">
        {heading}
      </h2>
      {clips.length === 0 ? (
        <p className="m-0 text-sm text-fg-2">{empty}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {clips.map((clip) => (
            <li
              key={clip.clipId}
              className="flex flex-col gap-1"
              data-testid={`top-clip-${clip.clipId}`}
            >
              <NextLink
                href={`/repurpose/${clip.runId}#clip-${clip.clipId}`}
                className="text-sm text-fg-0 no-underline hover:underline"
              >
                {clip.title}
              </NextLink>
              <span className="text-xs text-fg-1">
                {metric === "views"
                  ? WHAT_WORKS_COPY.views(compactCount(clip.views))
                  : `${percent(clip.engagementRate ?? 0)} · ${WHAT_WORKS_COPY.views(compactCount(clip.views))}`}
              </span>
              <span className="text-xs text-fg-2">
                {clip.posts
                  .map((post) =>
                    post.views === null
                      ? platformName(post.platform)
                      : `${platformName(post.platform)} ${compactCount(post.views)}`,
                  )
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Dimension({ dimension }: { readonly dimension: DimensionView }): React.JSX.Element {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4"
      data-testid={`dimension-${dimension.key}`}
    >
      <h3 id={id} className="m-0 text-sm font-medium text-fg-0">
        {dimension.label}
      </h3>
      {dimension.finding === null ? (
        <p className="m-0 text-sm text-fg-2" data-testid={`dimension-note-${dimension.key}`}>
          {dimension.note}
        </p>
      ) : (
        <p
          className="m-0 flex items-start gap-1.5 text-sm text-fg-0"
          data-testid={`dimension-finding-${dimension.key}`}
        >
          <TrendingUp
            className="mt-0.5 size-4 shrink-0 text-accepted"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span>{dimension.finding.sentence}</span>
        </p>
      )}
      {dimension.groups.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] border-collapse text-left text-xs">
            <thead>
              <tr className="text-fg-2">
                <th scope="col" className="py-1 pr-3 font-normal">
                  {WHAT_WORKS_COPY.groupColumns.group}
                </th>
                <th scope="col" className="py-1 pr-3 font-normal">
                  {WHAT_WORKS_COPY.groupColumns.posts}
                </th>
                <th scope="col" className="py-1 pr-3 font-normal">
                  {WHAT_WORKS_COPY.groupColumns.relative}
                </th>
                <th scope="col" className="py-1 font-normal">
                  {WHAT_WORKS_COPY.groupColumns.engagement}
                </th>
              </tr>
            </thead>
            <tbody>
              {dimension.groups.map((group) => (
                <tr key={group.key} className="border-t border-border text-fg-1">
                  <td className="py-1 pr-3">{group.label}</td>
                  <td className="py-1 pr-3 font-mono">{String(group.posts)}</td>
                  <td className="py-1 pr-3 font-mono">{times(group.medianRelative)}</td>
                  <td className="py-1 font-mono">
                    {group.medianEngagement === null ? "–" : percent(group.medianEngagement)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Report({ data }: { readonly data: WhatWorks }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 text-sm text-fg-1" data-testid="what-works-totals">
        {WHAT_WORKS_COPY.totals(
          data.totals.posts,
          data.totals.clips,
          data.totals.withViews,
          data.totals.measured,
          data.totals.entered,
        )}
      </p>

      <section
        aria-labelledby="what-works-steering"
        className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4"
        data-testid="what-works-steering"
      >
        <h2 id="what-works-steering" className="m-0 text-base text-fg-0">
          {WHAT_WORKS_COPY.steeringHeading}
        </h2>
        {data.steering === null ? (
          <p className="m-0 text-sm text-fg-2">
            {WHAT_WORKS_COPY.steeringOff(data.thresholds.steeringMinPosts)}
          </p>
        ) : (
          <>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-fg-1">
              {data.steering.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="m-0 text-xs text-fg-2">
              {WHAT_WORKS_COPY.steeringFootnote(data.steering.basis)}
            </p>
          </>
        )}
      </section>

      {!data.enough ? (
        <EmptyState
          icon={<BarChart3 aria-hidden="true" />}
          title={WHAT_WORKS_COPY.notEnough.title}
          description={WHAT_WORKS_COPY.notEnough.description(data.thresholds.minPosts)}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <TopClips
              heading={WHAT_WORKS_COPY.mostViewed}
              clips={data.topByViews}
              empty={WHAT_WORKS_COPY.noEngagement}
              testId="top-by-views"
              metric="views"
            />
            <TopClips
              heading={WHAT_WORKS_COPY.mostEngaging}
              clips={data.topByEngagement}
              empty={WHAT_WORKS_COPY.noEngagement}
              testId="top-by-engagement"
              metric="engagement"
            />
          </div>

          <section aria-labelledby="what-works-shared" className="flex flex-col gap-3">
            <h2 id="what-works-shared" className="m-0 text-base text-fg-0">
              {WHAT_WORKS_COPY.sharedHeading}
            </h2>
            <p className="m-0 text-xs text-fg-2">
              {WHAT_WORKS_COPY.sharedIntro(data.thresholds.minGroup, data.thresholds.clearLift)}{" "}
              {WHAT_WORKS_COPY.timesIn(data.timeZone)}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {data.dimensions.map((dimension) => (
                <Dimension key={dimension.key} dimension={dimension} />
              ))}
            </div>
          </section>

          <section aria-labelledby="what-works-usual" className="flex flex-col gap-2">
            <h2 id="what-works-usual" className="m-0 text-base text-fg-0">
              {WHAT_WORKS_COPY.usualHeading}
            </h2>
            <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-sm text-fg-1">
              {data.platforms.map((entry) => (
                <li key={entry.platform} data-testid={`usual-${entry.platform}`}>
                  <span className="text-fg-0">{platformName(entry.platform)}</span>{" "}
                  {WHAT_WORKS_COPY.usual(compactCount(Math.round(entry.medianViews)), entry.posts)}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

export function WhatWorksView(): React.JSX.Element {
  const flow = useFeatureFlag(REPURPOSE_FLOW_FLAG);
  const on = useFeatureFlag(PERFORMANCE_FLAG);
  const enabled = flow && on;
  const [days, setDays] = React.useState(90);
  const report = useWhatWorks(days, enabled);

  const header = (
    <PageHeader
      eyebrow={WHAT_WORKS_COPY.eyebrow}
      title={WHAT_WORKS_COPY.title}
      description={WHAT_WORKS_COPY.description}
      actions={
        <Button variant="ghost" size="sm" asChild>
          <NextLink href="/repurpose" className="no-underline">
            {WHAT_WORKS_COPY.runsLink}
          </NextLink>
        </Button>
      }
    />
  );

  const refusedAsOff = isApiError(report.error) && report.error.status === 404;
  if (!enabled || refusedAsOff) {
    return (
      <div className="flex flex-col gap-8" data-testid="what-works-off">
        {header}
        <EmptyState
          icon={<BarChart3 aria-hidden="true" />}
          title={WHAT_WORKS_COPY.off.title}
          description={WHAT_WORKS_COPY.off.description}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8" data-testid="what-works">
      {header}
      <div
        role="group"
        aria-label={WHAT_WORKS_COPY.windowLabel}
        className="flex flex-wrap items-center gap-2"
      >
        {WHAT_WORKS_COPY.windows.map((entry) => (
          <Button
            key={entry.days}
            variant={entry.days === days ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={entry.days === days}
            onClick={() => {
              setDays(entry.days);
            }}
            data-testid={`what-works-window-${String(entry.days)}`}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {report.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : report.isError ? (
        <p role="alert" className="m-0 text-sm text-fg-1">
          {WHAT_WORKS_COPY.loadError}
        </p>
      ) : (
        <Report data={report.data} />
      )}
    </div>
  );
}
