"use client";

/**
 * `/projects`' detail sheet (08 §Home): metadata, retention date, jobs
 * history. Opened from a project row rather than a whole navigation, because
 * looking up when something expires or what a job did should not cost the
 * list its scroll position.
 */
import * as React from "react";

import { useProject, useProjectJobs } from "@montaj/api-client";
import {
  LangChip,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
  StatusChip,
} from "@montaj/ui";

import { projectCardStatus } from "./project-status";

function formatDate(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ProjectDetailSheet({
  projectId,
  onOpenChange,
}: {
  projectId: string | undefined;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const project = useProject(projectId ?? null);
  const jobs = useProjectJobs(projectId ?? null);
  const items = jobs.data?.items ?? [];

  return (
    <Sheet open={projectId !== undefined} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-testid="project-detail-sheet">
        <SheetHeader>
          <SheetTitle>{project.data?.title ?? "Project"}</SheetTitle>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-6">
          {project.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : project.data === undefined ? (
            <p className="text-fg-2 text-sm">This project could not be found.</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-fg-2">Status</dt>
                <dd>
                  <StatusChip status={projectCardStatus(project.data, items)} />
                </dd>

                <dt className="text-fg-2">Language</dt>
                <dd>
                  {project.data.sourceLanguage === null ? (
                    "—"
                  ) : (
                    <LangChip language={project.data.sourceLanguage} />
                  )}
                </dd>

                <dt className="text-fg-2">Aspect</dt>
                <dd className="text-fg-0">{project.data.aspect}</dd>

                <dt className="text-fg-2">Media items</dt>
                <dd className="text-fg-0">{project.data.mediaCount}</dd>

                <dt className="text-fg-2">Created</dt>
                <dd className="text-fg-0">{formatDate(project.data.createdAt)}</dd>

                <dt className="text-fg-2">Last activity</dt>
                <dd className="text-fg-0">{formatDate(project.data.lastActivityAt)}</dd>

                <dt className="text-fg-2">Kept until</dt>
                <dd className="text-fg-0" data-testid="project-detail-retention">
                  {formatDate(project.data.retentionUntil)}
                </dd>
              </dl>

              <div className="flex flex-col gap-2">
                <h3 className="text-fg-0 text-sm font-medium">Jobs</h3>
                {items.length === 0 ? (
                  <p className="text-fg-2 text-sm">No jobs yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2" data-testid="project-detail-jobs">
                    {items.map((job) => (
                      <li
                        key={job.id}
                        className="border-border flex items-center justify-between rounded-sm border px-2.5 py-2 text-sm"
                      >
                        <span className="text-fg-0 font-mono text-xs">{job.type}</span>
                        <span className="text-fg-2 text-xs capitalize">{job.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
