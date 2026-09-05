import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "@montaj/api-client";

import { ProjectKebabMenu } from "./project-kebab-menu";

import { renderWithProviders } from "@/test/harness";
import { routerMock } from "@/test/next-router";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "01JPROJECT0000000000000AA",
    workspaceId: "01JWORKSPACE000000000000A",
    title: "Holiday clip",
    folderId: null,
    clientTag: null,
    sourceLanguage: "hi-Latn",
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

describe("<ProjectKebabMenu />", () => {
  it("duplicates the project through POST /projects", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<ProjectKebabMenu project={project()} />, {
      routes: { "/projects": project({ id: "01JCOPY000000000000000000" }) },
    });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));
    await user.click(await screen.findByTestId("kebab-duplicate"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((entry) => (entry[0] as string).endsWith("/projects"));
      expect(call).toBeDefined();
    });
  });

  it("archives an active project", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<ProjectKebabMenu project={project()} />, {
      routes: { "/projects/01JPROJECT0000000000000AA": project({ status: "archived" }) },
    });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));
    await user.click(await screen.findByTestId("kebab-archive"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("shows Unarchive for an already-archived project", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectKebabMenu project={project({ status: "archived" })} />, {
      routes: {},
    });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));
    expect(await screen.findByTestId("kebab-archive")).toHaveTextContent("Unarchive");
  });

  it("asks for confirmation before deleting, and only deletes on confirm", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<ProjectKebabMenu project={project()} />, {
      routes: { "/projects/01JPROJECT0000000000000AA": { id: "01JPROJECT0000000000000AA" } },
    });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));
    await user.click(await screen.findByTestId("kebab-delete"));

    expect(await screen.findByTestId("delete-confirm-dialog")).toBeInTheDocument();
    const wasDeleteCalled = (): boolean =>
      fetchMock.mock.calls.some(
        (entry) => (entry[1] as RequestInit | undefined)?.method === "DELETE",
      );
    expect(wasDeleteCalled()).toBe(false);

    await user.click(screen.getByTestId("confirm-delete"));
    await waitFor(() => {
      expect(wasDeleteCalled()).toBe(true);
    });
  });

  // F07-E5: Export shipped, so it is a real item now; Share is still disabled
  // because nothing in the app mounts an owner-side share screen (see REPORT.md).
  it("navigates to the editor's export dialog, and keeps Share disabled with a reason", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectKebabMenu project={project()} />, { routes: {} });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));

    const exportItem = await screen.findByTestId("kebab-export");
    expect(exportItem).not.toHaveAttribute("data-disabled");
    // Assert Share before the click: selecting Export closes the menu.
    expect(screen.getByTestId("kebab-share")).toHaveAttribute("data-disabled");

    await user.click(exportItem);
    expect(routerMock.push).toHaveBeenCalledWith("/p/01JPROJECT0000000000000AA?export=1");
  });

  /**
   * S-03: the grid's half of "bring your own captions". Offered for every
   * project — no client-side gating the route does not have — and, unlike every
   * other item here, selecting it must NOT close the menu: the file picker is
   * still open at that point and closing would unmount the input it reports to.
   */
  it("offers Import subtitles and keeps the menu open while the picker is up", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectKebabMenu project={project()} />, { routes: {} });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));

    const item = await screen.findByTestId("import-subtitles");
    expect(item).toHaveTextContent("Import subtitles");
    expect(item).not.toHaveAttribute("data-disabled");

    const input = screen.getByTestId("import-subtitles-input") as HTMLInputElement;
    expect(input).toHaveAttribute("accept", ".srt,.vtt,.ass,.txt");
    // jsdom has no OS picker, so this is what proves the item reached the input.
    const clickSpy = vi.spyOn(input, "click");

    await user.click(item);
    expect(clickSpy).toHaveBeenCalled();
    expect(screen.getByTestId("import-subtitles")).toBeInTheDocument();
  });

  it("offers a Details item only when the caller wants one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectKebabMenu project={project()} onViewDetails={() => undefined} />, {
      routes: {},
    });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));
    expect(await screen.findByTestId("kebab-details")).toBeInTheDocument();
  });
});
