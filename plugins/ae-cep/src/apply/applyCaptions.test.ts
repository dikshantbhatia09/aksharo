import { beforeEach, describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { applyCaptions } from "./applyCaptions.js";
import { MockAeHost } from "../host/ae.js";

const SUPPORTED_STYLE = loadSystemStyles().find((s) => s.id === "subtitle-classic")!;
const UNSUPPORTED_STYLE = loadSystemStyles().find((s) => s.id === "karaoke-fill")!;

const SEGMENTS: [
  { segmentId: string; text: string; startSeconds: number; endSeconds: number },
  { segmentId: string; text: string; startSeconds: number; endSeconds: number },
] = [
  { segmentId: "seg-1", text: "Hello", startSeconds: 0, endSeconds: 1 },
  { segmentId: "seg-2", text: "World", startSeconds: 1, endSeconds: 2 },
];

describe("applyCaptions", () => {
  let host: MockAeHost;

  beforeEach(() => {
    host = new MockAeHost();
  });

  it("adds styled text layers for a supported style, inside one undo group", async () => {
    const result = await applyCaptions(host, {
      projectId: "proj-1",
      rev: 1,
      compId: "comp-mock-1",
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUPPORTED_STYLE,
      segments: SEGMENTS,
      overlaySourcePath: "/tmp/overlay.mov",
    });
    expect(result.mode).toBe("styled-text-layers");
    expect(result.layerIds).toHaveLength(2);
    expect(host.undoGroupNames).toEqual(["Aksharo: apply captions"]);

    const tracked = await host.listAksharoLayers();
    expect(tracked).toHaveLength(2);
    expect(tracked.map((t) => t.metadata.aksharo.segmentId).sort()).toEqual(["seg-1", "seg-2"]);
  });

  it("falls back to the alpha overlay for an unsupported style", async () => {
    const result = await applyCaptions(host, {
      projectId: "proj-1",
      rev: 1,
      compId: "comp-mock-1",
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: UNSUPPORTED_STYLE,
      segments: SEGMENTS,
      overlaySourcePath: "/tmp/overlay.mov",
    });
    expect(result.mode).toBe("alpha-overlay");
    expect(result.layerIds).toHaveLength(1);
    expect(result.styleSupport).toBe("unsupported");
  });

  it("re-apply replaces only this project's previously tagged layers", async () => {
    await applyCaptions(host, {
      projectId: "proj-1",
      rev: 1,
      compId: "comp-mock-1",
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUPPORTED_STYLE,
      segments: SEGMENTS,
      overlaySourcePath: "/tmp/overlay.mov",
    });
    const firstLayerIds = (await host.listAksharoLayers()).map((t) => t.layerId);

    const second = await applyCaptions(host, {
      projectId: "proj-1",
      rev: 2,
      compId: "comp-mock-1",
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUPPORTED_STYLE,
      segments: [SEGMENTS[0]],
      overlaySourcePath: "/tmp/overlay.mov",
    });

    const tracked = await host.listAksharoLayers();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.metadata.aksharo.rev).toBe(2);
    for (const oldId of firstLayerIds) {
      expect(tracked.map((t) => t.layerId)).not.toContain(oldId);
    }
    expect(second.layerIds).toHaveLength(1);
  });

  it("does not disturb a different project's tagged layers on re-apply", async () => {
    await applyCaptions(host, {
      projectId: "proj-other",
      rev: 1,
      compId: "comp-mock-1",
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUPPORTED_STYLE,
      segments: [SEGMENTS[0]],
      overlaySourcePath: "/tmp/overlay.mov",
    });
    await applyCaptions(host, {
      projectId: "proj-1",
      rev: 1,
      compId: "comp-mock-1",
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUPPORTED_STYLE,
      segments: [SEGMENTS[1]],
      overlaySourcePath: "/tmp/overlay.mov",
    });
    const tracked = await host.listAksharoLayers();
    expect(tracked.map((t) => t.metadata.aksharo.projectId).sort()).toEqual([
      "proj-1",
      "proj-other",
    ]);
  });
});
