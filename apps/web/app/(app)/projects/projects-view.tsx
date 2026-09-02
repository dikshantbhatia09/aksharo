"use client";

/**
 * `/projects` (08 §Home; F-102): search, filters, sort, folders, an archive
 * view (Status → Archived is that view — no separate route for it), bulk
 * select, infinite scroll, and the detail sheet.
 */
import * as React from "react";

import { useProjects } from "@montaj/api-client";
import { Button, cn } from "@montaj/ui";

import type { ProjectFilters } from "@/components/projects/project-toolbar";

import { BulkActionBar } from "@/components/projects/bulk-action-bar";
import { FolderSidebar } from "@/components/projects/folder-sidebar";
import { ProjectDetailSheet } from "@/components/projects/project-detail-sheet";
import { ProjectGrid } from "@/components/projects/project-grid";
import { EMPTY_FILTERS, ProjectToolbar, sortProjects } from "@/components/projects/project-toolbar";

export function ProjectsView(): React.JSX.Element {
  const [filters, setFilters] = React.useState<ProjectFilters>(EMPTY_FILTERS);
  const [folderId, setFolderId] = React.useState<string | undefined>(undefined);
  const [selecting, setSelecting] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [detailProjectId, setDetailProjectId] = React.useState<string | undefined>(undefined);
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  const query = useProjects({
    ...(filters.q.trim() === "" ? {} : { q: filters.q.trim() }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    // `sourceLanguage` has no server-side filter on `GET /projects` (07
    // §Projects lists `q`, `status`, `folder`, `clientTag` only); applied
    // client-side below instead, over whatever page is already loaded.
    ...(filters.clientTag === undefined ? {} : { clientTag: filters.clientTag }),
    ...(folderId === undefined ? {} : { folder: folderId }),
    limit: 30,
  });

  const loaded = query.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered =
    filters.sourceLanguage === undefined
      ? loaded
      : loaded.filter((project) => project.sourceLanguage === filters.sourceLanguage);
  const projects = sortProjects(filtered, filters.sort);

  // Infinite scroll: fetch the next page once the sentinel below the grid
  // enters the viewport. The "Load more" button is the same action, kept for
  // anyone whose input device does not scroll (and for the e2e suite, where
  // it is a great deal less flaky than simulating a real scroll gesture).
  React.useEffect(() => {
    const node = loadMoreRef.current;
    if (node === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (
        entries.some((entry) => entry.isIntersecting) &&
        query.hasNextPage === true &&
        !query.isFetchingNextPage
      ) {
        void query.fetchNextPage();
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [query]);

  const toggleSelect = (projectId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="projects-view">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">Projects</h1>
        <Button
          type="button"
          variant={selecting ? "secondary" : "outline"}
          size="sm"
          onClick={() => {
            setSelecting((value) => !value);
            setSelectedIds(new Set());
          }}
          data-testid="toggle-select-mode"
        >
          {selecting ? "Done" : "Select"}
        </Button>
      </div>

      <ProjectToolbar filters={filters} onChange={setFilters} />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[14rem_1fr]">
        <FolderSidebar selectedFolderId={folderId} onSelect={setFolderId} />

        <div className={cn("flex flex-col gap-4", selecting && "pb-20")}>
          <ProjectGrid
            projects={projects}
            loading={query.isPending}
            emptyTitle={
              filters.q !== "" || filters.status !== undefined
                ? "No projects match that"
                : "Nothing here yet"
            }
            emptyDescription={
              filters.q !== "" || filters.status !== undefined
                ? "Try a different search or clear the filters."
                : "Drop a video or audio file on Home, or start from a ready-made sample."
            }
            selectable={selecting}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onViewDetails={setDetailProjectId}
          />

          <div ref={loadMoreRef} />
          {query.hasNextPage === true ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void query.fetchNextPage();
              }}
              disabled={query.isFetchingNextPage}
              data-testid="load-more"
              className="self-center"
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      </div>

      {selecting ? (
        <BulkActionBar
          selectedIds={selectedIds}
          onClear={() => {
            setSelectedIds(new Set());
          }}
        />
      ) : null}

      <ProjectDetailSheet
        projectId={detailProjectId}
        onOpenChange={(open) => {
          if (!open) setDetailProjectId(undefined);
        }}
      />
    </div>
  );
}
