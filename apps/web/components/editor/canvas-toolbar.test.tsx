import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CanvasToolbar,
  buildMultiAspectExportVariants,
  computeCanvasAspectPreviewState,
} from "./canvas-toolbar";

describe("CanvasToolbar — Multi-Aspect Ratio Engine (Pillar 3 §06 Step 3)", () => {
  it("computes preview canvas dimensions, crop bounds, and adaptive typography for 9:16, 1:1, 4:5, and 16:9", () => {
    const p9x16 = computeCanvasAspectPreviewState({
      aspect: "9:16",
      resolution: "1080p",
      sourceWidth: 1920,
      sourceHeight: 1080,
      centerX: 0.5,
      centerY: 0.5,
    });
    expect(p9x16.canvas).toEqual({ width: 1080, height: 1920 });
    expect(p9x16.crop).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
    expect(p9x16.typography.fontSizePx).toBe(54);

    const p1x1 = computeCanvasAspectPreviewState({
      aspect: "1:1",
      resolution: "1080p",
      sourceWidth: 1920,
      sourceHeight: 1080,
      centerX: 0.5,
      centerY: 0.5,
    });
    expect(p1x1.canvas).toEqual({ width: 1080, height: 1080 });
    expect(p1x1.crop).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    expect(p1x1.typography.fontSizePx).toBe(42);

    const p4x5 = computeCanvasAspectPreviewState({
      aspect: "4:5",
      resolution: "1080p",
      sourceWidth: 1920,
      sourceHeight: 1080,
      centerX: 0.5,
      centerY: 0.5,
    });
    expect(p4x5.canvas).toEqual({ width: 1080, height: 1350 });
    expect(p4x5.crop).toEqual({ x: 528, y: 0, width: 864, height: 1080 });
    expect(p4x5.typography.fontSizePx).toBe(48);

    const p16x9 = computeCanvasAspectPreviewState({
      aspect: "16:9",
      resolution: "1080p",
      sourceWidth: 1920,
      sourceHeight: 1080,
      centerX: 0.5,
      centerY: 0.5,
    });
    expect(p16x9.canvas).toEqual({ width: 1920, height: 1080 });
    expect(p16x9.crop).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(p16x9.typography.fontSizePx).toBe(44);
  });

  it("switches preview canvas aspect ratio on the fly via segmented control [9:16 | 1:1 | 4:5 | 16:9] and recalculates crop and captions", () => {
    const onAspectChange = vi.fn();

    render(
      <CanvasToolbar
        clipId="clip_01"
        projectId="proj_01"
        sourceWidth={1920}
        sourceHeight={1080}
        centerX={0.5}
        centerY={0.5}
        onAspectChange={onAspectChange}
      />,
    );

    expect(screen.getByTestId("canvas-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-aspect", "9:16");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-width", "1080");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-height", "1920");
    expect(screen.getByTestId("canvas-caption-preview")).toHaveAttribute(
      "data-font-size-px",
      "54",
    );

    // Switch to 1:1 Square
    fireEvent.click(screen.getByTestId("aspect-toggle-1x1"));
    expect(onAspectChange).toHaveBeenCalledTimes(1);
    expect(onAspectChange.mock.calls[0]?.[0]).toBe("1:1");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-aspect", "1:1");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-width", "1080");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-height", "1080");
    expect(screen.getByTestId("canvas-caption-preview")).toHaveAttribute(
      "data-font-size-px",
      "42",
    );
    expect(screen.getByTestId("canvas-crop-bounds")).toHaveTextContent(
      /1080×1080 at \(420, 0\)/i,
    );

    // Switch to 4:5 Portrait
    fireEvent.click(screen.getByTestId("aspect-toggle-4x5"));
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-aspect", "4:5");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-height", "1350");
    expect(screen.getByTestId("canvas-caption-preview")).toHaveAttribute(
      "data-font-size-px",
      "48",
    );

    // Switch to 16:9 Landscape
    fireEvent.click(screen.getByTestId("aspect-toggle-16x9"));
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-aspect", "16:9");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-width", "1920");
    expect(screen.getByTestId("canvas-preview-wrapper")).toHaveAttribute("data-height", "1080");
    expect(screen.getByTestId("canvas-caption-preview")).toHaveAttribute(
      "data-font-size-px",
      "44",
    );
  });

  it("supports simultaneous multi-format batch export selection and presents download cards for all selected aspects", () => {
    const onBatchExport = vi.fn();

    render(
      <CanvasToolbar
        clipId="clip_99"
        projectId="proj_99"
        initialSelectedAspects={["9:16", "1:1"]}
        onBatchExport={onBatchExport}
      />,
    );

    // Also select 4:5
    fireEvent.click(screen.getByTestId("batch-aspect-checkbox-4x5"));
    expect(screen.getByTestId("batch-export-button")).toHaveTextContent(/Export 3 Formats/i);

    // Trigger batch export
    fireEvent.click(screen.getByTestId("batch-export-button"));
    expect(onBatchExport).toHaveBeenCalledTimes(1);
    const [payload, variants] = onBatchExport.mock.calls[0]!;
    expect(payload).toEqual({
      clipId: "clip_99",
      targets: [
        { aspect: "9:16", resolution: "1080p" },
        { aspect: "1:1", resolution: "1080p" },
        { aspect: "4:5", resolution: "1080p" },
      ],
    });
    expect(variants).toHaveLength(3);

    expect(screen.getByTestId("batch-download-card-9x16")).toHaveTextContent(
      /clip_reels_9x16\.mp4/i,
    );
    expect(screen.getByTestId("batch-download-card-1x1")).toHaveTextContent(
      /clip_linkedin_1x1\.mp4/i,
    );
    expect(screen.getByTestId("batch-download-card-4x5")).toHaveTextContent(
      /clip_feed_4x5\.mp4/i,
    );
  });

  it("builds multi-aspect export variants with accurate resolution scaling", () => {
    const variants = buildMultiAspectExportVariants("clip_123", ["9:16", "1:1"], {
      resolution: "720p",
      projectId: "proj_123",
    });
    expect(variants).toHaveLength(2);
    expect(variants[0]?.width).toBe(720);
    expect(variants[0]?.height).toBe(1280);
    expect(variants[0]?.captionFontSizePx).toBe(36);
    expect(variants[1]?.width).toBe(720);
    expect(variants[1]?.height).toBe(720);
    expect(variants[1]?.captionFontSizePx).toBe(28);
  });
});
