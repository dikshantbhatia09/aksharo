import type { JobSummary, Project, ProjectStatus as ApiProjectStatus } from "@montaj/api-client";
import type { ProjectStatus as ChipStatus } from "@montaj/ui";

/**
 * What a card's `StatusChip` shows, derived from the project row plus its
 * live jobs — never from `project.status` alone, which only ever holds
 * `draft | active | archived` (07 §Projects). The chip vocabulary is richer
 * (`queued`, `processing`, `ready`, `failed`) because a card is answering "is
 * this done yet", and that is a question about its jobs, not its row.
 */
export function projectCardStatus(project: Project, jobs: readonly JobSummary[]): ChipStatus {
  if (project.status === ("archived" satisfies ApiProjectStatus)) return "archived";

  const live = jobs.filter((job) => job.projectId === project.id);
  if (live.some((job) => job.status === "failed")) return "failed";
  if (live.some((job) => job.status === "running")) return "processing";
  if (live.some((job) => job.status === "queued")) return "queued";
  if (project.mediaCount === 0) return "draft";
  return "ready";
}

/** The one live job worth showing progress for, if any (newest first). */
export function activeJobFor(
  project: Project,
  jobs: readonly JobSummary[],
): JobSummary | undefined {
  return jobs
    .filter((job) => job.projectId === project.id)
    .filter((job) => job.status === "queued" || job.status === "running")
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
}

/**
 * The status dot. Shirorekha keeps the accent out of lists, so each state
 * takes its signal hue instead: ready is `accepted`, working is `info`,
 * queued is `proposed`, failed is `rejected`, and draft/archived are neutral.
 * The dot is never alone — `STATUS_WORD` always sits beside it (08 §6).
 */
export const STATUS_DOT: Readonly<Record<ChipStatus, string>> = Object.freeze({
  ready: "bg-accepted",
  processing: "bg-info",
  queued: "bg-proposed",
  failed: "bg-rejected",
  draft: "bg-neutral-600",
  archived: "bg-neutral-700",
});

/** The word beside the dot — never the dot alone (08 §6). */
export const STATUS_WORD: Readonly<Record<ChipStatus, string>> = Object.freeze({
  ready: "Ready",
  processing: "Working",
  queued: "Queued",
  failed: "Failed",
  draft: "Draft",
  archived: "Archived",
});
