import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FolderSidebar } from "./folder-sidebar";

import { renderWithProviders } from "@/test/harness";

// `GET /folders` is a bare array — "the whole tree", never paginated — unlike
// `/projects`, which wraps in `{items, nextCursor}` (`endpoints.ts`).
const FOLDERS_ROUTE = {
  "/folders": [
    {
      id: "01JFOLDERB0000000000000A",
      workspaceId: "01JWORKSPACE",
      name: "Beta",
      parentId: null,
      position: 0,
      projectCount: 3,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    {
      id: "01JFOLDERA0000000000000A",
      workspaceId: "01JWORKSPACE",
      name: "Alpha",
      parentId: null,
      position: 1,
      projectCount: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  ],
};

describe("<FolderSidebar />", () => {
  it("lists folders alphabetically with their project count", async () => {
    renderWithProviders(<FolderSidebar selectedFolderId={undefined} onSelect={vi.fn()} />, {
      routes: FOLDERS_ROUTE,
    });
    await waitFor(() => {
      expect(screen.getByTestId("folder-01JFOLDERA0000000000000A")).toHaveTextContent("Alpha");
    });
    const names = screen.getAllByRole("button").map((el) => el.textContent);
    expect(names.findIndex((t) => t?.includes("Alpha"))).toBeLessThan(
      names.findIndex((t) => t?.includes("Beta")),
    );
    // F07-E2: the count is separated from the name — "Alpha1" read as one word.
    expect(screen.getByTestId("folder-01JFOLDERA0000000000000A")).toHaveTextContent("Alpha · 1");
    expect(screen.getByTestId("folder-01JFOLDERB0000000000000A")).toHaveTextContent("Beta · 3");
  });

  it("selects All projects and No folder", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(<FolderSidebar selectedFolderId={undefined} onSelect={onSelect} />, {
      routes: FOLDERS_ROUTE,
    });
    await user.click(screen.getByTestId("folder-root"));
    expect(onSelect).toHaveBeenCalledWith("root");
  });

  it("creates a folder from the inline form", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <FolderSidebar selectedFolderId={undefined} onSelect={vi.fn()} />,
      { routes: FOLDERS_ROUTE },
    );
    await user.click(screen.getByTestId("folder-create"));
    const input = await screen.findByTestId("folder-create-input");
    // F07-E2: the placeholder says how to commit the name.
    expect(input).toHaveAttribute("placeholder", "Name, then press Enter");
    await user.type(input, "Gamma{Enter}");
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => (call[0] as string).endsWith("/folders"))).toBe(
        true,
      );
    });
  });

  it("marks the selected folder", async () => {
    renderWithProviders(
      <FolderSidebar selectedFolderId="01JFOLDERA0000000000000A" onSelect={vi.fn()} />,
      { routes: FOLDERS_ROUTE },
    );
    await waitFor(() => {
      expect(screen.getByTestId("folder-01JFOLDERA0000000000000A")).toHaveClass("text-fg-0");
    });
  });
});
