import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VisualPacingPanel } from "./visual-pacing-panel";

describe("VisualPacingPanel (Pillar 6 §03: Dynamic Auto-Zoom Pacing)", () => {
  afterEach(cleanup);

  it("renders with default standard preset and shows active cadence", () => {
    render(<VisualPacingPanel />);

    expect(screen.getByTestId("visual-pacing-panel")).toBeDefined();
    expect(screen.getByTestId("active-preset-cadence").textContent).toBe("every 4s");
    expect(screen.getByTestId("pacing-option-standard").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("face-anchor-indicator")).toBeDefined();
  });

  it("allows selecting different zoom frequency presets and fires onPresetChange", () => {
    const onPresetChange = vi.fn();
    render(<VisualPacingPanel onPresetChange={onPresetChange} />);

    // Select Subtle
    fireEvent.click(screen.getByTestId("pacing-option-subtle"));
    expect(onPresetChange).toHaveBeenCalledWith("subtle");
    expect(screen.getByTestId("active-preset-cadence").textContent).toBe("every 7s");

    // Select Fast
    fireEvent.click(screen.getByTestId("pacing-option-fast"));
    expect(onPresetChange).toHaveBeenCalledWith("fast");
    expect(screen.getByTestId("active-preset-cadence").textContent).toBe("every 2.5s");

    // Select Off
    fireEvent.click(screen.getByTestId("pacing-option-off"));
    expect(onPresetChange).toHaveBeenCalledWith("off");
    expect(screen.getByTestId("active-preset-cadence").textContent).toBe("None");
  });

  it("hides transition controls when Off preset is selected", () => {
    render(<VisualPacingPanel preset="off" />);
    expect(screen.queryByTestId("transition-options-container")).toBeNull();
  });

  it("allows selecting transition styles and fires onTransitionChange", () => {
    const onTransitionChange = vi.fn();
    render(<VisualPacingPanel preset="standard" onTransitionChange={onTransitionChange} />);

    expect(screen.getByTestId("transition-options-container")).toBeDefined();

    // Select Jump Cut
    fireEvent.click(screen.getByTestId("transition-option-jump"));
    expect(onTransitionChange).toHaveBeenCalledWith("jump");

    // Select Ken Burns Creep
    fireEvent.click(screen.getByTestId("transition-option-creep"));
    expect(onTransitionChange).toHaveBeenCalledWith("creep");

    // Select Rhythmic Alternation
    fireEvent.click(screen.getByTestId("transition-option-alternate"));
    expect(onTransitionChange).toHaveBeenCalledWith("alternate");
  });

  it("fires onApply callback with current preset and transition", () => {
    const onApply = vi.fn();
    render(<VisualPacingPanel preset="standard" transition="ease" onApply={onApply} />);

    const applyButton = screen.getByTestId("apply-zoom-pacing-button");
    fireEvent.click(applyButton);

    expect(onApply).toHaveBeenCalledWith("standard", "ease");
  });

  it("displays active zoom keyframes count badge when activeZoomCount > 0", () => {
    render(<VisualPacingPanel activeZoomCount={5} />);
    const badge = screen.getByTestId("zoom-count-badge");
    expect(badge.textContent).toContain("5 dynamic zooms active");
  });

  it("disables interactive controls when disabled or isApplying is true", () => {
    render(<VisualPacingPanel disabled={true} onApply={vi.fn()} />);
    expect(screen.getByTestId("pacing-option-standard")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("apply-zoom-pacing-button")).toHaveProperty("disabled", true);
  });
});
