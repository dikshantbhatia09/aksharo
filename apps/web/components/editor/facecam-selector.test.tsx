import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CORNER_PRESETS,
  DEFAULT_STREAMER_COLORS,
  FacecamSelector,
  computeStreamerSplitCrops,
} from "./facecam-selector";

describe("FacecamSelector (Pillar 3 §07 Streamer Gameplay & Facecam Split UI)", () => {
  it("computes accurate pixel crops for 16:9 stream into Top 35% webcam and Bottom 65% gameplay", () => {
    const crops = computeStreamerSplitCrops(1920, 1080, CORNER_PRESETS["bottom-right"]);
    expect(crops.topPaneHeight).toBe(672);
    expect(crops.bottomPaneHeight).toBe(1248);

    // Gameplay crop centered on 16:9 source
    expect(crops.gameplayCrop.height).toBe(1080);
    expect(crops.gameplayCrop.width).toBe(934);
    expect(crops.gameplayCrop.x).toBe(492);
    expect(crops.gameplayCrop.y).toBe(0);

    // Facecam crop from bottom-right preset (x=0.71, y=0.65, w=0.25, h=0.30)
    expect(crops.facecamCrop.x).toBe(1362);
    expect(crops.facecamCrop.y).toBe(702);
    expect(crops.facecamCrop.width).toBe(480);
    expect(crops.facecamCrop.height).toBe(324);
  });

  it("renders 1-click corner presets and toggles between them", () => {
    const onChange = vi.fn();
    render(<FacecamSelector onChange={onChange} />);

    expect(screen.getByTestId("facecam-selector")).toBeInTheDocument();

    // Default corner is bottom-right
    const brBtn = screen.getByTestId("corner-preset-bottom-right");
    expect(brBtn).toHaveAttribute("data-active", "true");

    // Click Top Left preset
    const tlBtn = screen.getByTestId("corner-preset-top-left");
    fireEvent.click(tlBtn);

    expect(tlBtn).toHaveAttribute("data-active", "true");
    expect(brBtn).toHaveAttribute("data-active", "false");
    expect(onChange).toHaveBeenCalled();

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0]!;
    expect(lastCall.facecamCrop.x).toBeLessThan(200);
    expect(lastCall.facecamCrop.y).toBeLessThan(200);
  });

  it("updates neon gamer border color on preset click and manual color input", () => {
    const onChange = vi.fn();
    render(<FacecamSelector onChange={onChange} />);

    // Click Neon Green color preset
    const greenBtn = screen.getByTestId("color-preset-neon-green");
    fireEvent.click(greenBtn);

    expect(greenBtn).toHaveAttribute("data-selected", "true");
    expect(onChange).toHaveBeenCalled();
    let lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0]!;
    expect(lastCall.dividerColor).toBe("#00FFA3");

    // Custom color input
    const colorInput = screen.getByTestId("custom-color-input");
    fireEvent.change(colorInput, { target: { value: "#FF0055" } });
    lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0]!;
    expect(lastCall.dividerColor).toBe("#FF0055");
  });

  it("adjusts facecam crop position via sliders and resets on Reset click", () => {
    const onChange = vi.fn();
    render(<FacecamSelector onChange={onChange} />);

    const sliderX = screen.getByTestId("slider-pos-x");
    fireEvent.change(sliderX, { target: { value: "0.15" } });

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0]!;
    expect(lastCall.facecamCrop.x).toBe(288);

    // Reset button
    const resetBtn = screen.getByTestId("reset-facecam-btn");
    fireEvent.click(resetBtn);

    const resetCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0]!;
    expect(resetCall.facecamCrop.x).toBe(1362); // resets to bottom-right
  });

  it("triggers onAutoDetect when Auto-Detect button is clicked", () => {
    const onAutoDetect = vi.fn();
    render(<FacecamSelector onAutoDetect={onAutoDetect} />);

    const autoBtn = screen.getByTestId("auto-detect-btn");
    fireEvent.click(autoBtn);
    expect(onAutoDetect).toHaveBeenCalledTimes(1);
  });
});
