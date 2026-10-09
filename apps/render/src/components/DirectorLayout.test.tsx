/* eslint-disable security/detect-object-injection */
/** @jsx h */
import { describe, expect, it } from "vitest";

import {
  DirectorLayout,
  DirectorView,
  applyLayoutOverrideToEdl,
  buildDirectorCutFfmpegFilter,
  compositeDirectorLayoutRgbaFrame,
  findVNodeByTestId,
  findVNodesByType,
  h,
  resolveActiveLayoutCut,
  type LayoutCut,
} from "./DirectorLayout.js";

const SAMPLE_EDL: readonly LayoutCut[] = [
  {
    startSec: 0.0,
    endSec: 4.0,
    layoutType: "SOLO",
    activeSpeakerId: "SPEAKER_00",
    paneAssignments: [
      {
        speakerId: "SPEAKER_00",
        cropRect: { x: 120, y: 0, width: 608, height: 1080 },
        canvasPosition: { x: 0, y: 0, width: 1080, height: 1920 },
      },
    ],
  },
  {
    startSec: 4.0,
    endSec: 7.5,
    layoutType: "TRI_PANEL",
    activeSpeakerId: "SPEAKER_01",
    paneAssignments: [
      {
        speakerId: "SPEAKER_01",
        cropRect: { x: 640, y: 80, width: 640, height: 682 },
        canvasPosition: { x: 0, y: 0, width: 1080, height: 1152 },
      },
      {
        speakerId: "SPEAKER_00",
        cropRect: { x: 100, y: 120, width: 500, height: 710 },
        canvasPosition: { x: 0, y: 1152, width: 540, height: 768 },
      },
      {
        speakerId: "SPEAKER_02",
        cropRect: { x: 1280, y: 120, width: 500, height: 710 },
        canvasPosition: { x: 540, y: 1152, width: 540, height: 768 },
      },
    ],
  },
  {
    startSec: 7.5,
    endSec: 11.0,
    layoutType: "GRID_4",
    activeSpeakerId: "SPEAKER_02",
    paneAssignments: [
      {
        speakerId: "SPEAKER_00",
        cropRect: { x: 80, y: 100, width: 450, height: 800 },
        canvasPosition: { x: 0, y: 0, width: 540, height: 960 },
      },
      {
        speakerId: "SPEAKER_01",
        cropRect: { x: 560, y: 100, width: 450, height: 800 },
        canvasPosition: { x: 540, y: 0, width: 540, height: 960 },
      },
      {
        speakerId: "SPEAKER_02",
        cropRect: { x: 1020, y: 100, width: 450, height: 800 },
        canvasPosition: { x: 0, y: 960, width: 540, height: 960 },
      },
      {
        speakerId: "SPEAKER_03",
        cropRect: { x: 1420, y: 100, width: 450, height: 800 },
        canvasPosition: { x: 540, y: 960, width: 540, height: 960 },
      },
    ],
  },
];

describe("DirectorLayout Multi-Pane Remotion Compositor & Camera Switcher (Pillar 3 §03)", () => {
  it("dynamically switches between SOLO, TRI_PANEL (Top 60% / Bottom 40%), and GRID_4 (2x2) across timecodes", () => {
    expect(typeof h).toBe("function");
    expect(DirectorView).toBe(DirectorLayout);

    // 1. At t = 1.5s -> SOLO full-screen on SPEAKER_00
    const soloTree = (
      <DirectorLayout
        src="https://cdn.aksharo.test/roundtable-4p.mp4"
        cuts={SAMPLE_EDL}
        currentTimeSec={1.5}
      />
    );
    expect(soloTree.props["data-layout-type"]).toBe("SOLO");
    expect(soloTree.props["data-active-speaker-id"]).toBe("SPEAKER_00");
    expect(findVNodesByType(soloTree, "OffthreadVideo")).toHaveLength(1);
    const soloPane = findVNodeByTestId(soloTree, "director-active-cut-layer-pane-0");
    expect(soloPane?.props.style?.width).toBe(1080);
    expect(soloPane?.props.style?.height).toBe(1920);

    // 2. At t = 5.0s -> TRI_PANEL (Top 60% = 1080x1152, Bottom 40% = two 540x768 reaction tiles)
    const triTree = (
      <DirectorLayout
        src="https://cdn.aksharo.test/roundtable-4p.mp4"
        cuts={SAMPLE_EDL}
        currentTimeSec={5.0}
      />
    );
    expect(triTree.props["data-layout-type"]).toBe("TRI_PANEL");
    expect(triTree.props["data-active-speaker-id"]).toBe("SPEAKER_01");
    const triVideos = findVNodesByType(triTree, "OffthreadVideo");
    expect(triVideos).toHaveLength(3);
    // Only primary pane plays audio; reaction tiles are muted
    expect(triVideos[0]?.props["muted"]).toBe(false);
    expect(triVideos[1]?.props["muted"]).toBe(true);
    expect(triVideos[2]?.props["muted"]).toBe(true);

    const topPane = findVNodeByTestId(triTree, "director-active-cut-layer-pane-0");
    const blPane = findVNodeByTestId(triTree, "director-active-cut-layer-pane-1");
    const brPane = findVNodeByTestId(triTree, "director-active-cut-layer-pane-2");
    expect(topPane?.props.style?.top).toBe(0);
    expect(topPane?.props.style?.width).toBe(1080);
    expect(topPane?.props.style?.height).toBe(1152);
    expect(blPane?.props.style?.top).toBe(1152);
    expect(blPane?.props.style?.left).toBe(0);
    expect(blPane?.props.style?.width).toBe(540);
    expect(blPane?.props.style?.height).toBe(768);
    expect(brPane?.props.style?.top).toBe(1152);
    expect(brPane?.props.style?.left).toBe(540);
    expect(brPane?.props.style?.width).toBe(540);
    expect(brPane?.props.style?.height).toBe(768);

    // 3. At t = 8.5s -> GRID_4 (2x2 Grid of 540x960 tiles)
    const gridTree = (
      <DirectorLayout
        src="https://cdn.aksharo.test/roundtable-4p.mp4"
        cuts={SAMPLE_EDL}
        currentTimeSec={8.5}
      />
    );
    expect(gridTree.props["data-layout-type"]).toBe("GRID_4");
    expect(findVNodesByType(gridTree, "OffthreadVideo")).toHaveLength(4);
    const tile2 = findVNodeByTestId(gridTree, "director-active-cut-layer-pane-2");
    expect(tile2?.props["data-speaker-id"]).toBe("SPEAKER_02");
    expect(tile2?.props["data-active-speaker"]).toBe("true");
    expect(tile2?.props.style?.left).toBe(0);
    expect(tile2?.props.style?.top).toBe(960);
    expect(tile2?.props.style?.width).toBe(540);
    expect(tile2?.props.style?.height).toBe(960);
  });

  it("renders fluid 150ms crossfade transitions and supports hard-cut mode between camera angles", () => {
    // Cut boundary is at t = 4.0s (SOLO -> TRI_PANEL). At t = 4.075s (halfway through 150ms crossfade):
    const crossfadeTree = (
      <DirectorLayout
        src="https://cdn.aksharo.test/roundtable-4p.mp4"
        cuts={SAMPLE_EDL}
        currentTimeSec={4.075}
        transitionMode="crossfade"
        crossfadeDurationSec={0.15}
      />
    );
    expect(crossfadeTree.props["data-in-transition"]).toBe("true");
    const outgoingLayer = findVNodeByTestId(crossfadeTree, "director-outgoing-cut-layer");
    const incomingLayer = findVNodeByTestId(crossfadeTree, "director-active-cut-layer");
    expect(outgoingLayer).toBeDefined();
    expect(outgoingLayer?.props["data-layout-type"]).toBe("SOLO");
    expect(outgoingLayer?.props.style?.opacity).toBeCloseTo(0.5, 3);
    expect(incomingLayer?.props["data-layout-type"]).toBe("TRI_PANEL");
    expect(incomingLayer?.props.style?.opacity).toBeCloseTo(0.5, 3);

    // In hard-cut mode at the exact same timestamp t = 4.075s, no outgoing layer is rendered
    const hardCutTree = (
      <DirectorLayout
        src="https://cdn.aksharo.test/roundtable-4p.mp4"
        cuts={SAMPLE_EDL}
        currentTimeSec={4.075}
        transitionMode="hard"
      />
    );
    expect(hardCutTree.props["data-in-transition"]).toBe("false");
    expect(findVNodeByTestId(hardCutTree, "director-outgoing-cut-layer")).toBeUndefined();
    expect(findVNodeByTestId(hardCutTree, "director-active-cut-layer")?.props.style?.opacity).toBe(
      1,
    );
  });

  it("applies manual timestamp overrides to toggle between SOLO and Multi-Speaker Grid", () => {
    // At t = 2.0s, original EDL is SOLO. Override t = 2.0s to TRI_PANEL:
    const overriddenTree = (
      <DirectorLayout
        src="https://cdn.aksharo.test/roundtable-4p.mp4"
        cuts={SAMPLE_EDL}
        currentTimeSec={2.0}
        overrides={[{ timestampSec: 2.0, layoutType: "TRI_PANEL", activeSpeakerId: "SPEAKER_00" }]}
      />
    );
    expect(overriddenTree.props["data-layout-type"]).toBe("TRI_PANEL");
    expect(findVNodesByType(overriddenTree, "OffthreadVideo")).toHaveLength(3);

    // And override t = 5.5s (originally TRI_PANEL) to SOLO:
    const updatedEdl = applyLayoutOverrideToEdl(SAMPLE_EDL, {
      timestampSec: 5.5,
      layoutType: "SOLO",
      activeSpeakerId: "SPEAKER_02",
    });
    const resolved = resolveActiveLayoutCut(updatedEdl, 5.5);
    expect(resolved?.activeCut.layoutType).toBe("SOLO");
    expect(resolved?.activeCut.activeSpeakerId).toBe("SPEAKER_02");
    expect(resolved?.activeCut.paneAssignments).toHaveLength(1);
  });

  it("composites TRI_PANEL and GRID_4 RGBA frames and builds FFmpeg multi-tile filtergraphs", () => {
    const srcW = 1920;
    const srcH = 1080;
    const sourceRgba = new Uint8Array(srcW * srcH * 4);
    for (let i = 0; i < srcW * srcH; i += 1) {
      const idx = i * 4;
      sourceRgba[idx] = 40;
      sourceRgba[idx + 1] = 80;
      sourceRgba[idx + 2] = 160;
      sourceRgba[idx + 3] = 255;
    }

    const triCut = SAMPLE_EDL[1]!;
    const rendered = compositeDirectorLayoutRgbaFrame(sourceRgba, srcW, srcH, triCut, {
      previousCut: SAMPLE_EDL[0]!,
      crossfadeAlpha: 0.5,
    });
    expect(rendered.width).toBe(1080);
    expect(rendered.height).toBe(1920);
    expect(rendered.geometries).toHaveLength(3);
    for (const geom of rendered.geometries) {
      expect(geom.aspectRatioPreserved).toBe(true);
    }

    const triFilter = buildDirectorCutFfmpegFilter(triCut);
    expect(triFilter).toContain("[bl][br]hstack=inputs=2[bottom_row]");
    expect(triFilter).toContain("[top][bottom_row]vstack=inputs=2");

    const gridFilter = buildDirectorCutFfmpegFilter(SAMPLE_EDL[2]!);
    expect(gridFilter).toContain("[tl][tr]hstack=inputs=2[top_row]");
    expect(gridFilter).toContain("[bl][br]hstack=inputs=2[bottom_row]");
    expect(gridFilter).toContain("[top_row][bottom_row]vstack=inputs=2");
  });
});
