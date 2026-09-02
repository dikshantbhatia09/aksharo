import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_FILTERS, ProjectToolbar } from "./project-toolbar";

import type { ProjectFilters } from "./project-toolbar";

import { renderWithProviders } from "@/test/harness";


/**
 * `ProjectToolbar`'s search box is a controlled input: a caller that never
 * feeds the new value back in (as a bare `renderWithProviders(<ProjectToolbar
 * filters={EMPTY_FILTERS} .../>)` would) sees the field snap back to empty
 * after every keystroke, exactly like the real `/projects` page's own state
 * would if it ignored `onChange` — so this wrapper closes that loop the way
 * `ProjectsView` does, and the spy still sees every call.
 */
function ControlledToolbar({ onChange }: { onChange: (filters: ProjectFilters) => void }) {
  const [filters, setFilters] = React.useState(EMPTY_FILTERS);
  return (
    <ProjectToolbar
      filters={filters}
      onChange={(next) => {
        setFilters(next);
        onChange(next);
      }}
    />
  );
}

const AGENCY_ENTITLEMENT = {
  "/workspaces/01JWORKSPACE/entitlement": {
    workspaceId: "01JWORKSPACE",
    planKey: "agency",
    planName: "Agency",
    creditsPerMonthTenths: 9000,
    seatsIncluded: 1,
    seatsUsed: 1,
    entitlements: {},
    computedAt: "2026-09-02T00:00:00.000Z",
  },
};

describe("<ProjectToolbar />", () => {
  it("reports typed search text", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ControlledToolbar onChange={onChange} />, { routes: {} });
    await user.type(screen.getByTestId("project-search"), "vlog");
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, q: "vlog" });
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ProjectToolbar filters={EMPTY_FILTERS} onChange={onChange} />, {
      routes: {},
    });
    await user.click(screen.getByTestId("filter-status"));
    await user.click(await screen.findByTestId("filter-status-archived"));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, status: "archived" });
  });

  it("hides the client tag filter off the Agency plan", async () => {
    renderWithProviders(<ProjectToolbar filters={EMPTY_FILTERS} onChange={vi.fn()} />, {
      routes: {},
    });
    expect(screen.queryByTestId("filter-client-tag")).toBeNull();
  });

  it("shows the client tag filter on the Agency plan", async () => {
    renderWithProviders(<ProjectToolbar filters={EMPTY_FILTERS} onChange={vi.fn()} />, {
      routes: AGENCY_ENTITLEMENT,
    });
    await waitFor(() => {
      expect(screen.getByTestId("filter-client-tag")).toBeInTheDocument();
    });
  });

  it("changes the sort order", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ProjectToolbar filters={EMPTY_FILTERS} onChange={onChange} />, {
      routes: {},
    });
    await user.click(screen.getByTestId("sort-order"));
    await user.click(await screen.findByTestId("sort-order-title"));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, sort: "title" });
  });
});
