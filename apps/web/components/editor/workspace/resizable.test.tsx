import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./resizable";

/**
 * The wrapper is thin on purpose, so these cover the three things the editor
 * actually depends on: that a group renders a real `separator` between its
 * panels (the library's keyboard a11y hangs off that role), that our slot
 * attributes survive the pass-through, and that the double-click-to-reset
 * affordance ported from OpenCut's desktop twin reaches its handler.
 */
function Workspace({ onResetLayout }: { onResetLayout?: () => void } = {}): React.JSX.Element {
  return (
    <ResizablePanelGroup orientation="horizontal" id="test-group">
      <ResizablePanel id="left" defaultSize="50%">
        left
      </ResizablePanel>
      <ResizableHandle {...(onResetLayout === undefined ? {} : { onResetLayout })} />
      <ResizablePanel id="right" defaultSize="50%">
        right
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

describe("<ResizablePanelGroup />", () => {
  it("renders its panels either side of a separator", () => {
    render(<Workspace />);

    const group = screen.getByTestId("test-group");
    expect(group).toHaveAttribute("data-slot", "resizable-panel-group");
    expect(screen.getByTestId("left")).toHaveTextContent("left");
    expect(screen.getByTestId("right")).toHaveTextContent("right");
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("marks the handle with our slot attribute", () => {
    render(<Workspace />);

    expect(screen.getByRole("separator")).toHaveAttribute("data-slot", "resizable-handle");
  });

  it("resets the layout when the handle is double-clicked", () => {
    const onResetLayout = vi.fn();
    render(<Workspace onResetLayout={onResetLayout} />);

    fireEvent.doubleClick(screen.getByRole("separator"));

    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });
});
