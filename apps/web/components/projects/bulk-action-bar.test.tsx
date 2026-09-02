import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BulkActionBar } from "./bulk-action-bar";

import { renderWithProviders } from "@/test/harness";

describe("<BulkActionBar />", () => {
  it("renders nothing when nothing is selected", () => {
    renderWithProviders(<BulkActionBar selectedIds={new Set()} onClear={vi.fn()} />, {
      routes: {},
    });
    expect(screen.queryByTestId("bulk-action-bar")).toBeNull();
  });

  it("shows the count and archives every selected project", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const { fetchMock } = renderWithProviders(
      <BulkActionBar selectedIds={new Set(["01JA", "01JB"])} onClear={onClear} />,
      {
        routes: {
          "/projects/01JA": { id: "01JA" },
          "/projects/01JB": { id: "01JB" },
        },
      },
    );
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByTestId("bulk-archive"));
    await waitFor(() => {
      expect(onClear).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("deletes every selected project", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const { fetchMock } = renderWithProviders(
      <BulkActionBar selectedIds={new Set(["01JA"])} onClear={onClear} />,
      { routes: { "/projects/01JA": { id: "01JA" } } },
    );
    await user.click(screen.getByTestId("bulk-delete"));
    await waitFor(() => {
      expect(onClear).toHaveBeenCalled();
    });
    expect(
      fetchMock.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("clears the selection without calling the API", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const { fetchMock } = renderWithProviders(
      <BulkActionBar selectedIds={new Set(["01JA"])} onClear={onClear} />,
      { routes: {} },
    );
    await user.click(screen.getByText("Clear"));
    expect(onClear).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
