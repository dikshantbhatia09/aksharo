"use client";

/**
 * A run's compilations and series (2026-10-03), under its clips.
 *
 * Each compilation shows where it stands - waiting for a slot, being made (with
 * its percent), made, expired (renders are kept seven days), or failed with
 * the reason - and once made, a player, "Download" and "Delete". One whose
 * clips changed since says so and offers "Make again with the latest clips".
 * Each series lists its parts and offers "Remove series labels".
 *
 * "Make a compilation" opens the builder above the clip list (`building`),
 * where the clips are ticked.
 */
import { AlertTriangle, Clock, Download, Loader2 } from "lucide-react";
import * as React from "react";

import {
  useDeleteCompilation,
  useRemoveSeries,
  useRepurposeCompilations,
  useRepurposeSeries,
  useRetryCompilation,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  type RepurposeCompilation,
  type RepurposeCompilationShape,
  type RepurposeSeries,
} from "@montaj/api-client";
import { Button, ConfirmAction } from "@montaj/ui";

import {
  COMPILATION_COPY,
  compilationFailureCopy,
  compilationSummary,
} from "@/components/repurpose/compilations";
import { describeRefusal } from "@/components/repurpose/refusal";
import { useStableUrl } from "@/components/repurpose/use-stable-url";

/** How each shape's player sits on the page: never wider than the column. */
const PLAYER_CLASS: Readonly<Record<RepurposeCompilationShape, string>> = Object.freeze({
  "9:16": "aspect-[9/16] w-full max-w-[220px]",
  "4:5": "aspect-[4/5] w-full max-w-[260px]",
  "1:1": "aspect-square w-full max-w-[280px]",
  "16:9": "aspect-video w-full max-w-[420px]",
});

export interface CompilationsPanelProps {
  readonly runId: string;
  readonly clips: readonly RepurposeClipItem[];
  readonly candidates: readonly RepurposeCandidateItem[];
  /** The builder is open: the entry button steps aside. */
  readonly building: boolean;
  readonly onBuild: () => void;
}

export function CompilationsPanel({
  runId,
  clips,
  candidates,
  building,
  onBuild,
}: CompilationsPanelProps): React.JSX.Element | null {
  const compilationsQuery = useRepurposeCompilations(runId);
  const seriesQuery = useRepurposeSeries(runId);
  const compilations = compilationsQuery.data?.compilations ?? [];
  const series = seriesQuery.data?.series ?? [];
  const madeClips = clips.filter((clip) => clip.state === "ready").length;
  // Nothing to join yet and nothing joined: the section waits for the clips.
  if (madeClips < 2 && compilations.length === 0 && series.length === 0) return null;

  const titleOf = (clipId: string): string => {
    const clip = clips.find((entry) => entry.id === clipId);
    const candidate = candidates.find((entry) => entry.id === clip?.candidateId);
    return candidate?.title ?? clip?.title ?? "Clip";
  };

  return (
    <section
      aria-labelledby="compilations-heading"
      className="flex flex-col gap-4 rounded-md border border-border bg-bg-0 p-4"
      data-testid="compilations-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_240px]">
          <h2 id="compilations-heading" className="m-0 text-base font-semibold text-fg-0">
            {COMPILATION_COPY.heading}
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-2">{COMPILATION_COPY.intro}</p>
        </div>
        {building ? null : (
          <Button
            variant="secondary"
            size="sm"
            disabled={madeClips < 2}
            onClick={onBuild}
            data-testid="compilation-start"
          >
            {COMPILATION_COPY.make}
          </Button>
        )}
      </div>

      {compilations.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="compilations-list">
          {compilations.map((compilation) => (
            <CompilationRow key={compilation.id} runId={runId} compilation={compilation} />
          ))}
        </ul>
      )}

      {series.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold text-fg-0">{COMPILATION_COPY.seriesHeading}</h3>
          <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="series-list">
            {series.map((entry) => (
              <SeriesRow key={entry.id} runId={runId} series={entry} titleOf={titleOf} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CompilationRow({
  runId,
  compilation,
}: {
  readonly runId: string;
  readonly compilation: RepurposeCompilation;
}): React.JSX.Element {
  const retry = useRetryCompilation();
  const remove = useDeleteCompilation();
  // Every poll signs afresh; a playing video keeps the URL it started with.
  const playUrl = useStableUrl(compilation.playUrl ?? undefined);
  const name = compilation.title ?? "Compilation";
  const retryError = retry.isError ? describeRefusal(retry.error, "compilation").text : null;

  let state: React.ReactNode = null;
  if (compilation.status === "waiting") {
    state = (
      <StateLine
        icon={<Clock className="size-4 text-fg-2" strokeWidth={1.75} aria-hidden="true" />}
      >
        {COMPILATION_COPY.waiting}
      </StateLine>
    );
  } else if (compilation.status === "rendering") {
    state = (
      <StateLine
        icon={
          <Loader2
            className="size-4 animate-spin text-fg-2"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        }
      >
        {COMPILATION_COPY.rendering}
        {compilation.progress === null ? "" : ` ${String(Math.round(compilation.progress))}%`}
      </StateLine>
    );
  } else if (compilation.status === "failed") {
    state = (
      <StateLine
        icon={
          <AlertTriangle className="size-4 text-rejected" strokeWidth={1.75} aria-hidden="true" />
        }
      >
        {compilationFailureCopy(compilation.failureCode)}
      </StateLine>
    );
  } else if (compilation.status === "expired") {
    state = <StateLine>{COMPILATION_COPY.expired}</StateLine>;
  } else if (compilation.stale) {
    state = <StateLine>{COMPILATION_COPY.stale}</StateLine>;
  }

  return (
    <li
      className="flex flex-col gap-3 rounded-sm border border-border bg-surface p-3"
      data-testid={`compilation-${compilation.id}`}
      data-state={compilation.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-[1_1_200px]">
          <p className="m-0 truncate text-sm font-semibold text-fg-0">{name}</p>
          <p className="m-0 font-mono text-2xs text-fg-2">{compilationSummary(compilation)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {compilation.status === "ready" && compilation.downloadUrl !== null ? (
            <Button variant="ghost" size="sm" asChild>
              <a
                href={compilation.downloadUrl}
                download
                className="no-underline"
                aria-label={`${COMPILATION_COPY.download}: ${name}`}
                data-testid={`compilation-download-${compilation.id}`}
              >
                <Download strokeWidth={1.75} aria-hidden="true" />
                {COMPILATION_COPY.download}
              </a>
            </Button>
          ) : null}
          {compilation.canRetry ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate({ runId, compilationId: compilation.id });
              }}
              data-testid={`compilation-retry-${compilation.id}`}
            >
              {compilation.stale && compilation.status === "ready"
                ? COMPILATION_COPY.makeAgainLatest
                : COMPILATION_COPY.makeAgain}
            </Button>
          ) : null}
          <ConfirmAction
            trigger={
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                data-testid={`compilation-delete-${compilation.id}`}
              >
                {COMPILATION_COPY.delete}
              </Button>
            }
            title={COMPILATION_COPY.deleteTitle}
            description={COMPILATION_COPY.deleteBody}
            confirmLabel={COMPILATION_COPY.deleteConfirm}
            confirmTestId={`compilation-delete-confirm-${compilation.id}`}
            onConfirm={() => remove.mutateAsync({ runId, compilationId: compilation.id })}
          />
        </div>
      </div>

      {state}
      {retryError === null ? null : (
        <p role="alert" className="m-0 text-sm text-rejected">
          {retryError}
        </p>
      )}

      {compilation.status === "ready" && playUrl !== undefined ? (
        <div
          className={`overflow-hidden rounded-sm border border-border bg-ink ${PLAYER_CLASS[compilation.shape]}`}
        >
          <video
            src={playUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={`${name}, ${compilationSummary(compilation)}`}
            className="h-full w-full object-contain"
            data-testid={`compilation-video-${compilation.id}`}
          />
        </div>
      ) : null}
    </li>
  );
}

function SeriesRow({
  runId,
  series,
  titleOf,
}: {
  readonly runId: string;
  readonly series: RepurposeSeries;
  readonly titleOf: (clipId: string) => string;
}): React.JSX.Element {
  const remove = useRemoveSeries();
  const pending = series.parts.some((part) => part.pending > 0);
  const error = remove.isError ? describeRefusal(remove.error, "series").text : null;
  return (
    <li
      className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-3"
      data-testid={`series-${series.id}`}
    >
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {series.parts.map((part) => (
          <li key={part.clipId} className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="w-14 shrink-0 font-mono text-2xs text-fg-2">
              Part {String(part.part)}
            </span>
            <span className="min-w-0 truncate text-fg-0">{titleOf(part.clipId)}</span>
          </li>
        ))}
      </ol>
      {pending ? <p className="m-0 text-xs text-fg-2">{COMPILATION_COPY.seriesPending}</p> : null}
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-rejected">
          {error}
        </p>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate({ runId, seriesId: series.id });
          }}
          data-testid={`series-remove-${series.id}`}
        >
          {remove.isPending ? COMPILATION_COPY.removingSeries : COMPILATION_COPY.removeSeries}
        </Button>
      </div>
    </li>
  );
}

function StateLine({
  icon,
  children,
}: {
  readonly icon?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="m-0 inline-flex items-center gap-1.5 text-sm text-fg-1" role="status">
      {icon}
      <span>{children}</span>
    </p>
  );
}
