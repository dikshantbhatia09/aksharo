"use client";

/**
 * The library, in the premium canvas's shape: a filter bar across the top, a
 * narrow folder column, and the projects as a **table** — thumbnail, project,
 * status, language, length, credits, updated.
 *
 * The canvas has one view and it is the table, so that is the default. The
 * card grid is still here behind a Table/Grid toggle, because it is the right
 * shape for judging thumbnails and because `/projects` is where someone goes
 * to *find* something — a list they can scan by name, and a wall they can scan
 * by picture, are two different jobs.
 *
 * Everything the screen already did survives the reshape: search, filters,
 * sort, folders, the archive view (Status → Archived is that view — no
 * separate route for it), bulk select, infinite scroll, and the detail sheet.
 */
import * as React from "react";

import { useProjects } from "@montaj/api-client";
import { Button, cn } from "@montaj/ui";

import type { ProjectFilters } from "@/components/projects/project-toolbar";

import { BulkActionBar } from "@/components/projects/bulk-action-bar";
import { FolderSidebar } from "@/components/projects/folder-sidebar";
import { ProjectDetailSheet } from "@/components/projects/project-detail-sheet";
import { ProjectGrid } from "@/components/projects/project-grid";
import { ProjectTable } from "@/components/projects/project-table";
import { EMPTY_FILTERS, ProjectToolbar, sortProjects } from "@/components/projects/project-toolbar";

export function ProjectsView(): React.JSX.Element {
  const [filters, setFilters] = React.useState<ProjectFilters>(EMPTY_FILTERS);
  const [folderId, setFolderId] = React.useState<string | undefined>(undefined);
  const [selecting, setSelecting] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [detailProjectId, setDetailProjectId] = React.useState<string | undefined>(undefined);
  const [view, setView] = React.useState<"table" | "grid">("table");
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

  // Every filter counts, not just search and status: a language or client-tag
  // filter that matches nothing used to fall through to the cold-start copy and
  // offer a sample project, which is not the way out of a filter (F07-E3).
  const filtersActive =
    filters.q.trim() !== "" ||
    filters.status !== undefined ||
    filters.sourceLanguage !== undefined ||
    filters.clientTag !== undefined ||
    folderId !== undefined;

  const clearFilters = (): void => {
    setFilters(EMPTY_FILTERS);
    setFolderId(undefined);
  };

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

  const listProps = {
    projects,
    loading: query.isPending,
    emptyTitle: filtersActive ? "No projects match these filters" : "Nothing here yet",
    emptyDescription: filtersActive
      ? "Nothing in this workspace matches what you have selected."
      : "Drop a video or audio file on the studio, or start from a ready-made sample.",
    ...(filtersActive
      ? {
          emptyAction: (
            <Button
              type="button"
              variant="outline"
              onClick={clearFilters}
              data-testid="clear-filters"
            >
              Clear filters
            </Button>
          ),
        }
      : {}),
    selectable: selecting,
    selectedIds,
    onToggleSelect: toggleSelect,
    onViewDetails: setDetailProjectId,
  };

  const viewToggle = (on: boolean): string =>
    cn(
      "rounded-[6px] px-2.5 py-1 text-[11.5px] transition-colors duration-[160ms]",
      on ? "bg-accent/16 text-accent-200" : "text-neutral-500 hover:text-neutral-300",
    );

  return (
    <div className="flex flex-col gap-3.5" data-testid="projects-view">
      {/*
        The canvas's filter bar: search, three filters, and — pushed right —
        the sort label and the primary action. Select mode and the view
        toggle sit with them rather than above, so the screen opens on the
        table instead of on a heading.
      */}
      <ProjectToolbar filters={filters} onChange={setFilters}>
        <span className="border-border flex items-center gap-1 rounded-sm border p-[3px]">
          <button
            type="button"
            className={viewToggle(view === "table")}
            aria-pressed={view === "table"}
            onClick={() => {
              setView("table");
            }}
            data-testid="view-table"
          >
            Table
          </button>
          <button
            type="button"
            className={viewToggle(view === "grid")}
            aria-pressed={view === "grid"}
            onClick={() => {
              setView("grid");
            }}
            data-testid="view-grid"
          >
            Grid
          </button>
        </span>
        <Button
          type="button"
          variant={selecting ? "primary" : "secondary"}
          size="sm"
          onClick={() => {
            setSelecting((value) => !value);
            setSelectedIds(new Set());
          }}
          data-testid="toggle-select-mode"
        >
          {selecting ? "Done" : "Select"}
        </Button>
      </ProjectToolbar>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,150px)_minmax(0,1fr)]">
        <FolderSidebar selectedFolderId={folderId} onSelect={setFolderId} />

        <div className={cn("flex min-w-0 flex-col gap-4", selecting && "pb-20")}>
          {view === "table" ? <ProjectTable {...listProps} /> : <ProjectGrid {...listProps} />}

          <div ref={loadMoreRef} />
          {query.hasNextPage === true ? (
            <Button
              type="button"
              variant="secondary"
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
