"use client";

/**
 * "Working now" — the canvas's live-jobs card.
 *
 * One row per job the workspace has in flight: the project's thumbnail, its
 * title, what is being done to it, a 2 px progress bar and the ETA in
 * monospace on the right. Rows are separated by the Nocturne rule that fades
 * out 48 px from the right edge rather than stopping at it.
 *
 * Everything here is server truth (`GET /jobs`), not the browser's upload
 * queue — a file still uploading from this tab is the upload tray's business
 * and appears there. The card hides itself when nothing is running, because
 * the canvas has no empty state for it and "0 jobs" is not worth a card.
 */
import Link from "next/link";
import * as React from "react";

import { useWorkspaceJobs } from "@montaj/api-client";
import type { JobSummary, Project } from "@montaj/api-client";
import { cn } from "@montaj/ui";

import { formatEta, jobLabel } from "./job-labels";


function isLive(job: JobSummary): boolean {
  return job.status === "queued" || job.status === "running";
}

export function WorkingNowCard({
  projects,
  className,
}: {
  /** Whatever the page has already loaded, used to name each job's project. */
  projects: readonly Project[];
  className?: string;
}): React.JSX.Element | null {
  const jobs = useWorkspaceJobs();
  const live = (jobs.data?.items ?? []).filter(isLive);

  if (live.length === 0) return null;

  const titleFor = (projectId: string | null): string => {
    if (projectId === null) return "Workspace job";
    return projects.find((project) => project.id === projectId)?.title ?? "A project";
  };
  const thumbFor = (projectId: string | null): string | undefined =>
    projectId === null
      ? undefined
      : projects.find((project) => project.id === projectId)?.thumbnailUrl;

  return (
    <section
      className={cn("bg-surface flex flex-col gap-0.5 rounded-lg px-4 pt-3.5 pb-2", className)}
      data-testid="working-now"
      aria-labelledby="working-now-heading"
    >
      <h2
        id="working-now-heading"
        className="text-neutral-500 flex items-center gap-2 text-[10px] tracking-[0.12em] uppercase"
      >
        Working now
        <span className="bg-accent size-[5px] rounded-full" aria-hidden="true" />
        <span className="text-accent text-[11px] tracking-normal normal-case">
          {String(live.length)} {live.length === 1 ? "job" : "jobs"}
        </span>
      </h2>

      <ul>
        {live.map((job) => {
          const thumb = thumbFor(job.projectId);
          const row = (
            <>
              <span className="bg-sunken h-[30px] w-11 shrink-0 overflow-hidden rounded-[4px]">
                {thumb === undefined ? null : (
                  <img src={thumb} alt="" className="h-full w-full object-cover" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[13px]">{titleFor(job.projectId)}</span>
                  <span className="text-neutral-500 ml-auto text-[11px] whitespace-nowrap">
                    {jobLabel(job.type)} {String(Math.round(job.progress))}%
                  </span>
                </span>
                <span className="bg-neutral-800 block h-0.5 overflow-hidden rounded-full">
                  <span
                    className="bg-accent block h-full"
                    style={{ width: `${String(Math.min(100, Math.max(0, job.progress)))}%` }}
                  />
                </span>
              </span>
              <span className="text-neutral-400 font-mono text-[11px] whitespace-nowrap">
                {formatEta(job.etaMs)}
              </span>
            </>
          );

          return (
            <li key={job.id} data-testid="working-now-row">
              {job.projectId === null ? (
                <span className="rule-fade-b flex items-center gap-3 py-[11px]">{row}</span>
              ) : (
                <Link
                  href={`/p/${job.projectId}`}
                  className="rule-fade-b flex items-center gap-3 py-[11px] no-underline"
                >
                  {row}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
