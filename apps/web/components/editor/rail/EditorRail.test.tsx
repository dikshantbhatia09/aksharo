import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@montaj/ui";

import { EditorRail } from "./EditorRail";

import type { EditorRailTab } from "./EditorRail";

function Harness({ initial = "captions" as EditorRailTab }): React.JSX.Element {
  const [active, setActive] = React.useState<EditorRailTab>(initial);
  return (
    <TooltipProvider delayDuration={0}>
      <EditorRail
        active={active}
        onActiveChange={setActive}
        captions={<div data-testid="captions-content">Captions body</div>}
        fonts={<div data-testid="fonts-content">Fonts body</div>}
        library={<div data-testid="library-content">Library body</div>}
      />
    </TooltipProvider>
  );
}

describe("<EditorRail />", () => {
  it("shows Captions by default, with the other two tab panels hidden", () => {
    render(<Harness />);
    expect(screen.getByTestId("captions-content")).toBeVisible();
    expect(screen.getByTestId("fonts-content").closest('[role="tabpanel"]')).not.toBeVisible();
    expect(screen.getByTestId("library-content").closest('[role="tabpanel"]')).not.toBeVisible();
  });

  it("switches to Custom Fonts on click, without unmounting the other panels", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("editor-rail-tab-fonts"));
    expect(screen.getByTestId("fonts-content")).toBeVisible();
    expect(screen.getByTestId("captions-content").closest('[role="tabpanel"]')).not.toBeVisible();
    // Still in the DOM (not unmounted) — switching tabs must not lose transcript state.
    expect(screen.getByTestId("captions-content")).toBeInTheDocument();
  });

  it("switches to Library on click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("editor-rail-tab-library"));
    expect(screen.getByTestId("library-content")).toBeVisible();
  });

  it("marks the active tab for assistive technology", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId("editor-rail-tab-captions")).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByTestId("editor-rail-tab-library"));
    expect(screen.getByTestId("editor-rail-tab-library")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("editor-rail-tab-captions")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("calls onActiveChange with the clicked tab's id", async () => {
    const user = userEvent.setup();
    const onActiveChange = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <EditorRail
          active="captions"
          onActiveChange={onActiveChange}
          captions={<div />}
          fonts={<div />}
          library={<div />}
        />
      </TooltipProvider>,
    );
    await user.click(screen.getByTestId("editor-rail-tab-fonts"));
    expect(onActiveChange).toHaveBeenCalledWith("fonts");
  });
});
