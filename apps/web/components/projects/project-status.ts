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
export function activeJobFor(project: Project, jobs: readonly JobSummary[]): JobSummary | undefined {
  return jobs
    .filter((job) => job.projectId === project.id)
    .filter((job) => job.status === "queued" || job.status === "running")
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
}
