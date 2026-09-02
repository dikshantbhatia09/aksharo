"use client";

/**
 * The Recent projects grid (08 §Home) and the plain grid `/projects` reuses.
 * Empty state offers the seeded sample ("Try with a sample") rather than a
 * bare "nothing here yet" — F-002's onboarding drop zone makes the same
 * offer, and Home makes it again for anyone who skipped that step.
 */
import { FolderOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useCreateSampleProject } from "@montaj/api-client";
import type { Project } from "@montaj/api-client";
import { Button, EmptyState, toast } from "@montaj/ui";

import { ProjectCard } from "./project-card";

import { messageForError } from "@/lib/errors";


export function SampleProjectButton({
  variant = "primary",
}: {
  variant?: "primary" | "outline";
}): React.JSX.Element {
  const router = useRouter();
  const createSample = useCreateSampleProject();

  return (
    <Button
      type="button"
      variant={variant}
      data-testid="try-with-sample"
      disabled={createSample.isPending}
      onClick={() => {
        createSample.mutate(undefined, {
          onSuccess: (project) => {
            router.push(`/p/${project.id}`);
          },
          onError: (error) => {
            toast.error("Could not create the sample project", {
              description: messageForError(error),
            });
          },
        });
      }}
    >
      {createSample.isPending ? "Setting up…" : "Try with a sample"}
    </Button>
  );
}

export function ProjectGrid({
  projects,
  loading = false,
  emptyTitle = "Nothing here yet",
  emptyDescription = "Drop a video or audio file above, or start from a ready-made sample.",
  selectable = false,
  selectedIds,
  onToggleSelect,
  onViewDetails,
}: {
  projects: readonly Project[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
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
        action={selectable ? undefined : <SampleProjectButton />}
      />
    );
  }

  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      data-testid="project-grid"
    >
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          selectable={selectable}
          selected={selectedIds?.has(project.id) ?? false}
          {...(onToggleSelect === undefined ? {} : { onToggleSelect })}
          {...(onViewDetails === undefined ? {} : { onViewDetails })}
        />
      ))}
    </div>
  );
}
