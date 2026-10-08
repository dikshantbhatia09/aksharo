import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RightPanel } from "./RightPanel";
import { SYSTEM_STYLE_MAP } from "./system-styles";

vi.mock("../canvas/StylePreviewCanvas", () => ({
  StylePreviewCanvas: () => <div data-testid="mock-style-preview-canvas" />,
}));

const PUNCH_POP = SYSTEM_STYLE_MAP.get("punch-pop")!;
if (!PUNCH_POP) throw new Error("fixture style punch-pop is missing");

const DOC = { kind: "doc" } as const;

describe("RightPanel tab navigation & accessibility (WEB-004)", () => {
  function renderPanel(props?: { containerWidth?: number }) {
    const onOp = vi.fn();
    const result = render(
      <div style={{ width: props?.containerWidth !== undefined ? `${props.containerWidth}px` : "100%" }}>
        <RightPanel
          style={PUNCH_POP}
          scope={DOC}
          styles={[PUNCH_POP]}
          onOp={onOp}
        />
      </div>,
    );
    return { onOp, ...result };
  }

  it("follows WAI-ARIA tabs pattern with initial states and attributes", () => {
    renderPanel();

    const tablist = screen.getByRole("tablist", { name: "Caption settings" });
    expect(tablist).toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);

    const lookTab = screen.getByTestId("right-panel-tab-look");
    const styleTab = screen.getByTestId("right-panel-tab-style");
    const animTab = screen.getByTestId("right-panel-tab-anim");
    const audioTab = screen.getByTestId("right-panel-tab-audio");

    // Initially "Text" (look) tab is selected
    expect(lookTab).toHaveAttribute("aria-selected", "true");
    expect(lookTab).toHaveAttribute("tabindex", "0");
    expect(lookTab).toHaveAttribute("aria-controls", "right-panel-panel-look");

    expect(styleTab).toHaveAttribute("aria-selected", "false");
    expect(styleTab).toHaveAttribute("tabindex", "-1");
    expect(styleTab).toHaveAttribute("aria-controls", "right-panel-panel-style");

    expect(animTab).toHaveAttribute("aria-selected", "false");
    expect(animTab).toHaveAttribute("tabindex", "-1");

    expect(audioTab).toHaveAttribute("aria-selected", "false");
    expect(audioTab).toHaveAttribute("tabindex", "-1");

    const activePanel = screen.getByRole("tabpanel");
    expect(activePanel).toHaveAttribute("id", "right-panel-panel-look");
    expect(activePanel).toHaveAttribute("aria-labelledby", "right-panel-tab-look");
  });

  it("navigates tabs using ArrowRight, ArrowLeft, Home, and End keys", async () => {
    const user = userEvent.setup();
    renderPanel();

    const lookTab = screen.getByTestId("right-panel-tab-look");
    const styleTab = screen.getByTestId("right-panel-tab-style");
    const animTab = screen.getByTestId("right-panel-tab-anim");
    const audioTab = screen.getByTestId("right-panel-tab-audio");

    // Focus initial tab
    lookTab.focus();
    expect(lookTab).toHaveFocus();

    // ArrowRight -> Templates (style)
    await user.keyboard("{ArrowRight}");
    expect(styleTab).toHaveFocus();
    expect(styleTab).toHaveAttribute("aria-selected", "true");
    expect(lookTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "right-panel-panel-style");

    // ArrowDown -> Transitions (anim)
    await user.keyboard("{ArrowDown}");
    expect(animTab).toHaveFocus();
    expect(animTab).toHaveAttribute("aria-selected", "true");

    // ArrowRight -> AI Audio (audio)
    await user.keyboard("{ArrowRight}");
    expect(audioTab).toHaveFocus();
    expect(audioTab).toHaveAttribute("aria-selected", "true");

    // ArrowRight wraps around -> Text (look)
    await user.keyboard("{ArrowRight}");
    expect(lookTab).toHaveFocus();
    expect(lookTab).toHaveAttribute("aria-selected", "true");

    // ArrowLeft wraps backwards -> AI Audio (audio)
    await user.keyboard("{ArrowLeft}");
    expect(audioTab).toHaveFocus();
    expect(audioTab).toHaveAttribute("aria-selected", "true");

    // ArrowUp -> Transitions (anim)
    await user.keyboard("{ArrowUp}");
    expect(animTab).toHaveFocus();
    expect(animTab).toHaveAttribute("aria-selected", "true");

    // Home -> Text (look)
    await user.keyboard("{Home}");
    expect(lookTab).toHaveFocus();
    expect(lookTab).toHaveAttribute("aria-selected", "true");

    // End -> AI Audio (audio)
    await user.keyboard("{End}");
    expect(audioTab).toHaveFocus();
    expect(audioTab).toHaveAttribute("aria-selected", "true");
  });

  it("ensures every tab is reachable and clickable in a narrow panel (260px)", async () => {
    const user = userEvent.setup();
    renderPanel({ containerWidth: 260 });

    const tabIds = ["look", "style", "anim", "audio"] as const;
    for (const id of tabIds) {
      const tabButton = screen.getByTestId(`right-panel-tab-${id}`);
      expect(tabButton).toBeVisible();
      await user.click(tabButton);
      expect(tabButton).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tabpanel")).toHaveAttribute("id", `right-panel-panel-${id}`);
    }
  });

  it("ensures every tab is reachable and clickable across 1024px, 1280px, and 1440px viewports", async () => {
    const user = userEvent.setup();
    const viewports = [1024, 1280, 1440];

    for (const width of viewports) {
      window.innerWidth = width;
      const { unmount } = renderPanel({ containerWidth: Math.floor(width * 0.25) });

      const tabs = ["look", "style", "anim", "audio"] as const;
      for (const id of tabs) {
        const tabButton = screen.getByTestId(`right-panel-tab-${id}`);
        expect(tabButton).toBeVisible();
        await user.click(tabButton);
        expect(tabButton).toHaveAttribute("aria-selected", "true");
      }
      unmount();
    }
  });
});
