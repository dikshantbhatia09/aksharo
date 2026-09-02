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
      <div className="bg-bg-2 relative flex aspect-video items-center justify-center">
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
        <Film className="text-fg-2 size-8" aria-hidden="true" />
        {duration === undefined ? null : (
          <span className="bg-overlay absolute right-2 bottom-2 rounded-sm px-1.5 py-0.5 font-mono text-2xs text-white">
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
