import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COLOR_SWATCH_PRESETS,
  HEIGHT_PRESETS,
  PROGRESS_BAR_POSITION_OPTIONS,
  PROGRESS_BAR_STYLE_OPTIONS,
  VisualElementsPanel,
} from "./visual-elements-panel";

describe("VisualElementsPanel (Pillar 6 §05: Animated Progress Bars & Timers)", () => {
  afterEach(cleanup);

  it("renders with default settings and active controls", () => {
    render(<VisualElementsPanel />);

    expect(screen.getByTestId("visual-elements-panel")).toBeDefined();
    expect(screen.getByTestId("progress-bar-enabled-switch")).toBeDefined();
    expect(screen.getByTestId("progress-bar-controls-container")).toBeDefined();
    expect(screen.getByTestId("progress-style-SLIM_LINE").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("progress-position-BOTTOM_SAFE").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("progress-bar-live-preview")).toBeDefined();
  });

  it("toggles enabled state and fires onToggle / onSettingsChange", () => {
    const onToggle = vi.fn();
    const onSettingsChange = vi.fn();

    render(
      <VisualElementsPanel onToggle={onToggle} onSettingsChange={onSettingsChange} />,
    );

    const toggle = screen.getByTestId("progress-bar-enabled-switch");
    fireEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledWith(false);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    // Controls container should now be hidden
    expect(screen.queryByTestId("progress-bar-controls-container")).toBeNull();
  });

  it("allows selecting style designs and fires onTypeChange", () => {
    const onTypeChange = vi.fn();
    const onSettingsChange = vi.fn();

    render(
      <VisualElementsPanel
        onTypeChange={onTypeChange}
        onSettingsChange={onSettingsChange}
      />
    );

    // Select Neon Glow
    fireEvent.click(screen.getByTestId("progress-style-NEON_GRADIENT"));
    expect(onTypeChange).toHaveBeenCalledWith("NEON_GRADIENT");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NEON_GRADIENT" }),
    );

    // Select Radial Clock
    fireEvent.click(screen.getByTestId("progress-style-RADIAL_DIAL"));
    expect(onTypeChange).toHaveBeenCalledWith("RADIAL_DIAL");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RADIAL_DIAL" }),
    );
  });

  it("allows selecting safe-zone placement and fires onPositionChange", () => {
    const onPositionChange = vi.fn();
    const onSettingsChange = vi.fn();

    render(
      <VisualElementsPanel
        onPositionChange={onPositionChange}
        onSettingsChange={onSettingsChange}
      />
    );

    // Select Top
    fireEvent.click(screen.getByTestId("progress-position-TOP"));
    expect(onPositionChange).toHaveBeenCalledWith("TOP");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ position: "TOP" }),
    );

    // Select Below Video
    fireEvent.click(screen.getByTestId("progress-position-BELOW_VIDEO"));
    expect(onPositionChange).toHaveBeenCalledWith("BELOW_VIDEO");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ position: "BELOW_VIDEO" }),
    );
  });

  it("allows selecting color swatches and editing custom hex", () => {
    const onColorChange = vi.fn();
    const onSettingsChange = vi.fn();

    render(
      <VisualElementsPanel
        onColorChange={onColorChange}
        onSettingsChange={onSettingsChange}
      />
    );

    // Select Cyan swatch
    const cyanSwatch = screen.getByTestId("color-swatch-#00E5FF");
    fireEvent.click(cyanSwatch);
    expect(onColorChange).toHaveBeenCalledWith("#00E5FF");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ fillColor: "#00E5FF" }),
    );

    // Edit hex input directly
    const hexInput = screen.getByTestId("progress-bar-color-input");
    fireEvent.change(hexInput, { target: { value: "#FF007F" } });
    expect(onColorChange).toHaveBeenCalledWith("#FF007F");
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ fillColor: "#FF007F" }),
    );
  });

  it("allows selecting thickness presets and toggling neon glow", () => {
    const onHeightChange = vi.fn();
    const onSettingsChange = vi.fn();

    render(
      <VisualElementsPanel
        onHeightChange={onHeightChange}
        onSettingsChange={onSettingsChange}
      />
    );

    // Select 12px thickness
    fireEvent.click(screen.getByTestId("height-preset-12"));
    expect(onHeightChange).toHaveBeenCalledWith(12);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ heightPx: 12 }),
    );

    // Toggle glow
    const glowToggle = screen.getByTestId("progress-bar-glow-toggle");
    fireEvent.click(glowToggle);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ glow: true }),
    );
  });

  it("disables interactive controls when disabled prop is true", () => {
    render(<VisualElementsPanel disabled={true} />);

    expect(screen.getByTestId("progress-bar-enabled-switch")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("progress-style-SLIM_LINE")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("progress-position-BOTTOM_SAFE")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("progress-bar-color-input")).toHaveProperty("disabled", true);
  });
});
