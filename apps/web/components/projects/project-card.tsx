"use client";

/**
 * One tile in the studio's "Pick up where you left off" grid and in
 * `/projects`' grid view, drawn as the premium canvas draws it: a portrait
 * frame with the duration in a dark chip at its corner, then the title and a
 * single status line — a coloured dot, the status word, and the language.
 *
 * What the canvas deliberately does not have, and what came out with it:
 *
 *  - a dashed gold "subtitle bounding box" painted over every thumbnail. It
 *    was drawn from two hard-coded `#FFB800` values, showed a caption position
 *    that had nothing to do with the project's actual caption placement, and
 *    obscured the frame it sat on.
 *  - a green circular play button on hover, in a hard-coded `#10B981` that is
 *    not a colour in this palette and read as a second accent.
 *  - a 1 px border on the tile. Nocturne separates a card from the page with
 *    its own lighter surface; the outline appears on hover, in the accent, as
 *    the selection affordance.
 *
 * Status is live: `useProjectJobs` polls every few seconds while any of the
 * project's jobs are still queued or running (`@montaj/api-client`'s
 * `refetchInterval`) and also reacts to the workspace's realtime channel —
 * `AppShell` already invalidates every `["ws", id, "jobs", ...]` query on a
 * `job.progress` / `job.completed` event, and this card's query key nests
 * under exactly that prefix, so a card update from the WebSocket and a card
 * update from polling both land through the identical refetch path.
 */
import { Film } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useProjectJobs } from "@montaj/api-client";
import type { Project, ProjectAspect } from "@montaj/api-client";
import { Checkbox } from "@montaj/ui";

import { ProjectKebabMenu } from "./project-kebab-menu";
import { activeJobFor, projectCardStatus, STATUS_DOT, STATUS_WORD } from "./project-status";

import { cn } from "@/lib/utils";

function formatDuration(ms: number | null): string | undefined {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

/**
 * FIX-05: the frame is the project's own aspect. A portrait project drawn in a
 * 16:9 box was the grid's half of the audit's "chrome ignores correct data"
 * finding, and the previous fix wrote the comment but left `aspect-[9/16]`
 * hard-coded underneath it.
 *
 * 9:16 is drawn at the canvas's slightly squarer 9:13 so a row of tiles is not
 * a row of slots; the ratio only decides the *frame*, and the thumbnail inside
 * it is `object-cover` either way.
 */
const FRAME: Record<ProjectAspect, string> = {
  "9:16": "aspect-[9/13]",
  "4:5": "aspect-[4/5]",
  "1:1": "aspect-square",
  "16:9": "aspect-video",
};

export function ProjectCard({
  project,
  selectable = false,
  selected = false,
  onToggleSelect,
  onViewDetails,
}: {
  project: Project;
  /** `/projects`' bulk-select mode; the studio never turns this on. */
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
      className={cn(
        "group bg-surface relative flex flex-col overflow-hidden rounded-[10px]",
        "transition-shadow duration-[160ms] ease-[var(--ease-out-soft)]",
        selected
          ? "shadow-[0_0_0_1px_var(--color-accent)]"
          : "hover:shadow-[0_0_0_1px_var(--color-accent)]",
      )}
      data-testid="project-card"
      data-project-id={project.id}
      data-status={status}
      data-selected={selected}
    >
      <div
        className={cn(
          "bg-sunken relative flex w-full items-center justify-center overflow-hidden",
          FRAME[project.aspect],
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
          <Film className="text-neutral-700 size-7" aria-hidden="true" />
        ) : (
          // A plain <img>, as elsewhere in this folder: the src is a short-lived
          // presigned URL on an external origin, which next/image cannot optimise.
          <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        )}

        {duration === undefined ? null : (
          <span
            className="bg-ink/70 text-neutral-200 absolute right-1.5 bottom-1.5 rounded-[4px] px-1.5 py-px font-mono text-[10px]"
            data-testid="project-card-duration"
          >
            {duration}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-[5px] px-2.5 pt-[9px] pb-[11px]">
        <div className="flex items-start justify-between gap-1.5">
          <h3 className="text-fg-0 line-clamp-2 text-[12.5px] leading-[1.3]">{project.title}</h3>
          <ProjectKebabMenu
            project={project}
            {...(onViewDetails === undefined ? {} : { onViewDetails })}
          />
        </div>

        <span className="text-neutral-500 flex items-center gap-1.5 text-[10.5px]">
          {/* eslint-disable-next-line security/detect-object-injection -- `status` is one of the six ChipStatus literals */}
          <span className={cn("size-[5px] shrink-0 rounded-full", STATUS_DOT[status])} />
          {/* eslint-disable-next-line security/detect-object-injection -- as above */}
          {STATUS_WORD[status]}
          {project.sourceLanguage === null ? null : ` · ${project.sourceLanguage}`}
          {active?.etaMs == null ? null : (
            <span className="ml-auto font-mono" data-testid="project-card-eta">
              {formatEta(active.etaMs)}
            </span>
          )}
        </span>
      </div>
    </Link>
  );
}

function formatEta(etaMs: number): string {
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.round(seconds / 60))}m`;
}
