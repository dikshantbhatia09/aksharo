import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "@montaj/api-client";

import { ProjectGrid, SampleProjectButton } from "./project-grid";

import { renderWithProviders } from "@/test/harness";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "01JPROJECT0000000000000AA",
    workspaceId: "01JWORKSPACE000000000000A",
    title: "Holiday clip",
    folderId: null,
    clientTag: null,
    sourceLanguage: null,
    scripts: [],
    aspect: "9:16",
    status: "active",
    thumbnailKey: null,
    durationMs: null,
    mediaCount: 1,
    lastActivityAt: "2026-09-02T00:00:00.000Z",
    retentionUntil: null,
    createdBy: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_JOBS = { "/jobs": { items: [], nextCursor: null } };

describe("<ProjectGrid />", () => {
  it("renders one card per project", () => {
    renderWithProviders(
      <ProjectGrid projects={[project(), project({ id: "01JB", title: "Second" })]} />,
      { routes: EMPTY_JOBS },
    );
    expect(screen.getAllByTestId("project-card")).toHaveLength(2);
  });

  it("shows the empty state with a sample button when there is nothing and it is not loading", () => {
    renderWithProviders(<ProjectGrid projects={[]} />, { routes: {} });
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("try-with-sample")).toBeInTheDocument();
  });

  it("shows nothing special while loading, even with no projects yet", () => {
    renderWithProviders(<ProjectGrid projects={[]} loading />, { routes: {} });
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("passes selection state through to each card", async () => {
    const onToggleSelect = vi.fn();
    renderWithProviders(
      <ProjectGrid
        projects={[project()]}
        selectable
        selectedIds={new Set(["01JPROJECT0000000000000AA"])}
        onToggleSelect={onToggleSelect}
      />,
      { routes: EMPTY_JOBS },
    );
    expect(screen.getByTestId("project-card")).toHaveAttribute("data-selected", "true");
  });

  it("omits the sample action in selectable (bulk) mode", () => {
    renderWithProviders(<ProjectGrid projects={[]} selectable />, { routes: {} });
    expect(screen.queryByTestId("try-with-sample")).toBeNull();
  });
});

describe("<SampleProjectButton />", () => {
  it("creates the sample project and navigates to it", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<SampleProjectButton />, {
      routes: { "/projects/sample": project({ id: "01JSAMPLE00000000000000A" }) },
    });
    await user.click(screen.getByTestId("try-with-sample"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
