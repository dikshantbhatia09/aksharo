import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  MultiSpeakerGridSwitcher,
  applyTimestampLayoutOverride,
  buildDefaultDirectorEdl,
  buildPaneAssignmentsForLayout,
} from "./multispeaker-grid-switcher";

describe("MultiSpeakerGridSwitcher (Pillar 3 §03 Step 3)", () => {
  it("builds default AI Director EDL with SOLO and TRI_PANEL cuts >= 2.0s", () => {
    const edl = buildDefaultDirectorEdl(10, 40, [
      "SPEAKER_00",
      "SPEAKER_01",
      "SPEAKER_02",
      "SPEAKER_03",
    ]);
    expect(edl.length).toBeGreaterThanOrEqual(3);
    for (const cut of edl) {
      expect(cut.endSec - cut.startSec).toBeGreaterThanOrEqual(2.0);
    }
    expect(edl.map((c) => c.layoutType)).toContain("SOLO");
    expect(edl.map((c) => c.layoutType)).toContain("TRI_PANEL");
  });

  it("computes exact 9:16 (1080x1920) pane assignments for SOLO, TRI_PANEL (60%/40%), and GRID_4 (2x2)", () => {
    const soloPanes = buildPaneAssignmentsForLayout("SOLO", "SPEAKER_00");
    expect(soloPanes).toHaveLength(1);
    expect(soloPanes[0]?.canvasPosition).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });

    const triPanes = buildPaneAssignmentsForLayout("TRI_PANEL", "SPEAKER_01");
    expect(triPanes).toHaveLength(3);
    expect(triPanes[0]?.speakerId).toBe("SPEAKER_01");
    expect(triPanes[0]?.canvasPosition).toEqual({ x: 0, y: 0, width: 1080, height: 1152 });
    expect(triPanes[1]?.canvasPosition).toEqual({ x: 0, y: 1152, width: 540, height: 768 });
    expect(triPanes[2]?.canvasPosition).toEqual({ x: 540, y: 1152, width: 540, height: 768 });

    const gridPanes = buildPaneAssignmentsForLayout("GRID_4", "SPEAKER_02");
    expect(gridPanes).toHaveLength(4);
    expect(gridPanes[0]?.canvasPosition).toEqual({ x: 0, y: 0, width: 540, height: 960 });
    expect(gridPanes[3]?.canvasPosition).toEqual({ x: 540, y: 960, width: 540, height: 960 });
  });

  it("allows creators to click on a timestamp and manually toggle between Solo Speaker and Multi-Speaker Grid", () => {
    const onChange = vi.fn();
    const onSeek = vi.fn();

    render(
      <MultiSpeakerGridSwitcher
        startSec={0}
        endSec={30}
        onChange={onChange}
        onSeek={onSeek}
      />,
    );

    expect(screen.getByTestId("multispeaker-grid-switcher")).toBeInTheDocument();
    // Initial cut at t=0s is SOLO
    expect(screen.getByTestId("director-active-layout-badge")).toHaveTextContent(/Solo Speaker/i);
    expect(screen.getByTestId("director-mini-preview")).toHaveAttribute("data-layout-type", "SOLO");
    expect(screen.getByTestId("director-mini-preview")).toHaveTextContent(/Panes: 1/i);

    // Click primary toggle button to switch from Solo Speaker to Multi-Speaker Grid (TRI_PANEL)
    fireEvent.click(screen.getByTestId("director-toggle-solo-grid"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [updatedCuts, overridePayload] = onChange.mock.calls[0]!;
    expect(overridePayload.layoutType).toBe("TRI_PANEL");
    expect(updatedCuts[0].layoutType).toBe("TRI_PANEL");
    expect(screen.getByTestId("director-active-layout-badge")).toHaveTextContent(
      /Tri-Panel Grid/i,
    );
    expect(screen.getByTestId("director-mini-preview")).toHaveAttribute(
      "data-layout-type",
      "TRI_PANEL",
    );
    expect(screen.getByTestId("director-mini-preview")).toHaveTextContent(/Panes: 3/i);

    // Switch directly to 2x2 Grid (GRID_4)
    fireEvent.click(screen.getByTestId("director-mode-GRID_4"));
    expect(screen.getByTestId("director-active-layout-badge")).toHaveTextContent(
      /2×2 Reaction Grid/i,
    );
    expect(screen.getByTestId("director-mini-preview")).toHaveTextContent(/Panes: 4/i);

    // Click on cut segment 2 on the EDL timeline (initially SOLO -> toggles to TRI_PANEL)
    fireEvent.click(screen.getByTestId("director-cut-segment-2"));
    expect(onSeek).toHaveBeenCalled();

    // Toggle back to Solo Speaker
    fireEvent.click(screen.getByTestId("director-toggle-solo-grid"));
    expect(screen.getByTestId("director-active-layout-badge")).toHaveTextContent(/Solo Speaker/i);

    // Reset AI cuts
    fireEvent.click(screen.getByTestId("director-reset-edl"));
    expect(screen.getByTestId("director-cut-segment-0")).toHaveAttribute("data-layout-type", "SOLO");
    expect(screen.getByTestId("director-cut-segment-1")).toHaveAttribute(
      "data-layout-type",
      "TRI_PANEL",
    );
  });

  it("overrides the active cut at a clicked timestamp while preserving >= 2.0s shot duration", () => {
    const cuts = buildDefaultDirectorEdl(0, 30);
    const updated = applyTimestampLayoutOverride(cuts, {
      timestampSec: 5.0,
      layoutType: "GRID_4",
      activeSpeakerId: "SPEAKER_02",
    });
    expect(updated).toHaveLength(3);
    expect(updated[0]?.layoutType).toBe("GRID_4");
    expect(updated[0]?.activeSpeakerId).toBe("SPEAKER_02");
    expect(updated[0]?.paneAssignments).toHaveLength(4);
    for (const c of updated) {
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(2.0);
    }
  });
});
