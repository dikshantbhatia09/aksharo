"use client";

/**
 * The library as a table — the premium canvas's view of `/projects`.
 *
 * Thumbnail, project, status, language, length, credits, updated, kebab. The
 * whole row is the link; the kebab and the select box stop the click before it
 * reaches it.
 *
 * Each row reads its own jobs (`useProjectJobs`), which is what makes both the
 * status and the credits column live. That is one request per visible row —
 * exactly what the card grid has always done, and the alternative (one
 * workspace-wide `GET /jobs`) is a paginated list, so on a busy workspace it
 * would silently under-count an older project's credits rather than being
 * merely slower.
 */
import { FolderOpen } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useProjectJobs } from "@montaj/api-client";
import type { JobSummary, Project } from "@montaj/api-client";
import { Checkbox, cn, EmptyState, Skeleton } from "@montaj/ui";

import { SampleProjectButton } from "./project-grid";
import { ProjectKebabMenu } from "./project-kebab-menu";
import { projectCardStatus, STATUS_DOT, STATUS_WORD } from "./project-status";

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/** Tenths → "18.4", "0.0". Every project shows a figure, including zero. */
function formatCredits(jobs: readonly JobSummary[], projectId: string): string {
  const tenths = jobs
    .filter((job) => job.projectId === projectId)
    .reduce((sum, job) => sum + job.creditsChargedTenths, 0);
  return (tenths / 10).toFixed(1);
}

/**
 * "2 hours ago", "yesterday", "3 days ago" — the canvas's Updated column.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder, so the phrasing
 * is the platform's and follows the user's locale rather than a hard-coded
 * English one. Anything under a minute is "just now": "in 0 seconds" is what
 * the formatter says otherwise, and it is both wrong-tensed and useless.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  if (abs < 2_592_000) return format.format(Math.round(seconds / 86_400), "day");
  if (abs < 31_536_000) return format.format(Math.round(seconds / 2_592_000), "month");
  return format.format(Math.round(seconds / 31_536_000), "year");
}

function ProjectRow({
  project,
  selectable,
  selected,
  onToggleSelect,
  onViewDetails,
}: {
  project: Project;
  selectable: boolean;
  selected: boolean;
  onToggleSelect?: ((projectId: string) => void) | undefined;
  onViewDetails?: ((projectId: string) => void) | undefined;
}): React.JSX.Element {
  const jobs = useProjectJobs(project.id);
  const items = jobs.data?.items ?? [];
  const status = projectCardStatus(project, items);

  return (
    <tr
      data-testid="project-row"
      data-project-id={project.id}
      data-status={status}
      data-selected={selected}
      className="rule-fade-b hover:bg-neutral-100/5"
    >
      <td className="w-[52px]">
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={() => {
              onToggleSelect?.(project.id);
            }}
            aria-label={`Select ${project.title}`}
            data-testid="project-row-select"
          />
        ) : (
          <span className="bg-sunken block h-[26px] w-[38px] overflow-hidden rounded-sm">
            {project.thumbnailUrl === undefined ? null : (
              <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            )}
          </span>
        )}
      </td>
      <td className="text-sm">
        <Link
          href={selectable ? "#" : `/p/${project.id}`}
          onClick={(event) => {
            if (selectable) {
              event.preventDefault();
              onToggleSelect?.(project.id);
            }
          }}
          className="text-fg-0 decoration-fg-2 block truncate py-1.5 no-underline underline-offset-4 hover:underline"
          data-testid="project-row-link"
        >
          {project.title}
        </Link>
      </td>
      <td>
        <span className="text-fg-1 flex items-center gap-1.5 text-xs">
          <span
            // eslint-disable-next-line security/detect-object-injection -- `status` is one of the six ChipStatus literals
            className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
            aria-hidden="true"
          />
          {/* eslint-disable-next-line security/detect-object-injection -- as above */}
          {STATUS_WORD[status]}
        </span>
      </td>
      <td className="text-fg-1 text-xs">{project.sourceLanguage ?? "—"}</td>
      <td className="text-fg-1 font-mono text-xs">
        {formatDuration(project.durationMs)}
      </td>
      <td className="text-fg-1 font-mono text-xs" data-testid="project-row-credits">
        {jobs.isPending ? <Skeleton className="h-3 w-7" /> : formatCredits(items, project.id)}
      </td>
      <td className="text-fg-2 text-xs whitespace-nowrap">
        {formatRelative(project.lastActivityAt)}
      </td>
      <td className="text-right">
        <ProjectKebabMenu
          project={project}
          {...(onViewDetails === undefined ? {} : { onViewDetails })}
        />
      </td>
    </tr>
  );
}

export function ProjectTable({
  projects,
  loading = false,
  emptyTitle = "Nothing here yet",
  emptyDescription = "Drop a video or audio file on the studio, or start from a ready-made sample.",
  emptyAction,
  selectable = false,
  selectedIds,
  onToggleSelect,
  onViewDetails,
}: {
  projects: readonly Project[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (projectId: string) => void;
  onViewDetails?: (projectId: string) => void;
}): React.JSX.Element {
  if (!loading && projects.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen aria-hidden="true" />}
        title={emptyTitle}
        description={emptyDescription}
        // The same way out the grid offers on a cold start. A list emptied by
        // filters passes its own "Clear filters" as `emptyAction` (F07-E3).
        action={emptyAction ?? (selectable ? undefined : <SampleProjectButton />)}
      />
    );
  }

  return (
    <div
      className="border-border bg-surface relative min-w-0 overflow-x-auto rounded-md border px-3 pt-1 pb-2"
      data-testid="project-table"
    >
      <table className="w-full border-collapse text-sm [&_td]:px-1.5 [&_td]:py-1.5 [&_th]:px-1.5 [&_th]:py-1.5">
        <thead>
          <tr className="rule-fade-b">
            {["Thumbnail", "Project", "Status", "Language", "Length", "Credits", "Updated", "Actions"].map(
              (heading, index) => (
                <th
                  key={`${heading}-${String(index)}`}
                  scope="col"
                  className="text-fg-2 text-left text-2xs font-medium tracking-[0.06em] uppercase"
                >
                  {/* The thumbnail and kebab columns show no heading, but a
                      screen reader still gets a name for each. */}
                  {heading === "Thumbnail" || heading === "Actions" ? (
                    <span className="sr-only">{heading}</span>
                  ) : (
                    heading
                  )}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              selectable={selectable}
              selected={selectedIds?.has(project.id) ?? false}
              {...(onToggleSelect === undefined ? {} : { onToggleSelect })}
              {...(onViewDetails === undefined ? {} : { onViewDetails })}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
