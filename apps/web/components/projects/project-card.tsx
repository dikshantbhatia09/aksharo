"use client";

/**
 * One card in the Recent grid (08 §Home) and in `/projects`' grid view:
 * thumbnail, title, duration, language/script chip, status chip, kebab.
 *
 * Status is live: `useProjectJobs` polls every few seconds while any of the
 * project's jobs are still queued or running (`@montaj/api-client`'s
 * `refetchInterval`) and also reacts to the workspace's realtime channel —
 * `AppShell` already invalidates every `["ws", id, "jobs", ...]` query on a
 * `job.progress` / `job.completed` event, and this card's query key nests
 * under exactly that prefix, so a card update from the WebSocket and a card
 * update from polling both land through the identical refetch path.
 */
import { Clock, Film } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useProjectJobs } from "@montaj/api-client";
import type { Project } from "@montaj/api-client";
import { Checkbox, LangChip, StatusChip } from "@montaj/ui";

import { ProjectKebabMenu } from "./project-kebab-menu";
import { activeJobFor, projectCardStatus } from "./project-status";

import { cn } from "@/lib/utils";

function formatDuration(ms: number | null): string | undefined {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

export function ProjectCard({
  project,
  selectable = false,
  selected = false,
  onToggleSelect,
  onViewDetails,
}: {
  project: Project;
  /** `/projects`' bulk-select mode; Home never turns this on. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (projectId: string) => void;
  onViewDetails?: (projectId: string) => void;
}): React.JSX.Element {
  const jobs = useProjectJobs(project.id);
  const items = jobs.data?.items ?? [];
  const status = projectCardStatus(project, items);
  const active = activeJobFor(project, items);
  const duration = formatDuration(project.durationMs);

  return (
    <Link
      href={selectable ? "#" : `/p/${project.id}`}
      onClick={(event) => {
        if (selectable) {
          event.preventDefault();
          onToggleSelect?.(project.id);
        }
      }}
      className="group border-border bg-bg-1 hover:border-lime-500/40 relative flex flex-col overflow-hidden rounded-md border transition-colors"
      data-testid="project-card"
      data-project-id={project.id}
      data-status={status}
      data-selected={selected}
    >
      {/* FIX-05: the frame is the project's own aspect, and the thumbnail the
          pipeline already produced is finally shown. A portrait project drawn in
          a 16:9 box was the grid's half of the audit's "chrome ignores correct
          data" finding. */}
      <div
        className={cn(
          "bg-bg-2 relative flex items-center justify-center overflow-hidden aspect-[9/16] w-full",
        )}
      >
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={() => {
              onToggleSelect?.(project.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
            }}
            aria-label={`Select ${project.title}`}
            className="absolute top-2 left-2 z-10"
            data-testid="project-card-select"
          />
        ) : null}
        {project.thumbnailUrl === undefined ? (
          <Film className="text-fg-2 size-8" aria-hidden="true" />
        ) : (
          // A plain <img>, as elsewhere in this folder: the src is a short-lived
          // presigned URL on an external origin, which next/image cannot optimise.
          <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        )}

        {/* Subtitle Bounding Box Overlay (Kalakar Parity: orange/gold box in lower third) */}
        <div
          className="pointer-events-none absolute bottom-9 left-1/2 -translate-x-1/2 w-4/5 h-8 rounded border border-dashed border-[#FFB800] bg-[#FFB800]/15 flex items-center justify-center gap-1.5 px-2"
          aria-hidden="true"
        >
          <div className="h-1.5 w-1/3 rounded-full bg-[#FFB800]/70" />
          <div className="h-1.5 w-1/2 rounded-full bg-[#FFB800]/90" />
        </div>

        {/* Play Button Overlay on Hover */}
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          aria-hidden="true"
        >
          <div className="flex size-11 items-center justify-center rounded-full bg-[#10B981] text-black shadow-lg">
            <svg
              className="size-5 fill-current ml-0.5"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        </div>

        {duration === undefined ? null : (
          <span
            className="bg-black/75 absolute right-2 bottom-2 rounded px-1.5 py-0.5 font-mono text-[11px] text-white backdrop-blur-sm"
            data-testid="project-card-duration"
          >
            {duration}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-fg-0 line-clamp-2 text-sm font-medium">{project.title}</h3>
          <ProjectKebabMenu
            project={project}
            {...(onViewDetails === undefined ? {} : { onViewDetails })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip status={status} />
          {project.sourceLanguage === null ? null : <LangChip language={project.sourceLanguage} />}
        </div>

        {active === undefined ? null : (
          <p className="text-fg-2 flex items-center gap-1 text-xs" data-testid="project-card-eta">
            <Clock className="size-3" aria-hidden="true" />
            {active.etaMs === null ? "Working…" : formatEta(active.etaMs)}
          </p>
        )}
      </div>
    </Link>
  );
}

function formatEta(etaMs: number): string {
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 60) return `about ${String(seconds)}s left`;
  return `about ${String(Math.round(seconds / 60))} min left`;
}
