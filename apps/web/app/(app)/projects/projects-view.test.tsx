import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ProjectsView } from "./projects-view";

import { renderWithProviders } from "@/test/harness";

// The view's infinite scroll observes a sentinel; jsdom has no
// IntersectionObserver and `vitest.setup.ts` only fills in ResizeObserver.
beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return [];
      }
    },
  );
});

const PROJECT = {
  id: "01JPROJECT0000000000000AA",
  workspaceId: "01JWORKSPACE",
  title: "Hindi reel",
  status: "active",
  sourceLanguage: "hi",
  aspect: "9:16",
  durationMs: 30_000,
  folderId: null,
  clientTag: null,
  thumbnailUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const ROUTES = {
  "/projects": { items: [PROJECT], nextCursor: null },
  "/folders": [],
};

/**
 * F07-E3: the empty state used to branch on search and status only, so a
 * language or client-tag filter that matched nothing fell through to the
 * cold-start copy — and offered a sample project, which is not the way out of
 * a filter.
 */
describe("<ProjectsView /> empty states", () => {
  it("shows the cold-start empty state when the workspace really is empty", async () => {
    renderWithProviders(<ProjectsView />, {
      routes: { "/projects": { items: [], nextCursor: null }, "/folders": [] },
    });
    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByTestId("clear-filters")).toBeNull();
  });

  it("shows the filter empty state, with a way out, when a language filter matches nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsView />, { routes: ROUTES });

    // The one project is Hindi; filtering to another language empties the list
    // without the workspace being empty. The canvas's default view is the
    // table, so that is what a populated list renders.
    expect(await screen.findByTestId("project-table")).toBeInTheDocument();
    await user.click(screen.getByTestId("filter-language"));
    await user.click(await screen.findByTestId("filter-language-ta"));

    expect(await screen.findByText("No projects match these filters")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).toBeNull();

    // And the way out is a clear, not a new sample project.
    const clear = screen.getByTestId("clear-filters");
    await user.click(clear);
    expect(await screen.findByTestId("project-table")).toBeInTheDocument();
  });

  it("switches between the canvas's table and the card grid", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsView />, { routes: ROUTES });

    expect(await screen.findByTestId("project-table")).toBeInTheDocument();
    expect(screen.queryByTestId("project-grid")).toBeNull();

    await user.click(screen.getByTestId("view-grid"));
    expect(await screen.findByTestId("project-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("project-table")).toBeNull();
  });
});
