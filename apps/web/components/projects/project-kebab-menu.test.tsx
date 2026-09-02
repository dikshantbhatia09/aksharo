import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Project } from "@montaj/api-client";

import { ProjectKebabMenu } from "./project-kebab-menu";

import { renderWithProviders } from "@/test/harness";

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

  it("export and share are disabled with a reason, not hidden", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectKebabMenu project={project()} />, { routes: {} });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));
    expect(await screen.findByTestId("kebab-export")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("kebab-share")).toHaveAttribute("data-disabled");
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
