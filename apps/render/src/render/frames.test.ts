import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import {
  createFontRegistry,
  createHarfBuzzShaper,
  type FontRegistry,
  type Shaper,
} from "@montaj/render-core";
import { loadFixtureFonts } from "@montaj/render-core/testing";
import { SkiaNodeBackend } from "@montaj/render-skia-node";

import { createFrameSource, type FrameSourceOptions } from "./frames.js";

/** A projection with no captions of its own — every command in a frame is a title's. */
const EMPTY_PROJECTION: FrameSourceOptions["projection"] = {
  canvas: { width: 320, height: 480 },
  styles: { defaultStyleId: "vertical-clean" },
  segments: [],
  words: [],
};

let registry: FontRegistry;
let shaper: Shaper;
let backend: SkiaNodeBackend;

beforeAll(async () => {
  registry = createFontRegistry(loadFixtureFonts());
  shaper = await createHarfBuzzShaper(registry);
  backend = await SkiaNodeBackend.create({ shaper });
});

afterAll(() => {
  backend.dispose();
});

function baseOptions(): Omit<FrameSourceOptions, "backend" | "batch"> {
  return {
    projection: EMPTY_PROJECTION,
    timemap: null,
    catalogue: loadSystemStyleMap(),
    registry,
    shaper,
    fps: 10,
    watermark: null,
  };
}

describe("createFrameSource with D06b title items", () => {
  it("draws nothing extra when the manifest carries no titles (unchanged from before D06b)", () => {
    const source = createFrameSource({
      ...baseOptions(),
      backend,
      batch: backend.createBatch({ width: 320, height: 480 }),
    });
    expect(source.commandsAt(500)).toEqual([]);
  });

  it("draws a title's commands at an instant it is on screen", () => {
    const style = loadSystemStyleMap().get("vertical-clean");
    if (style === undefined) throw new Error("fixture style missing");
    const source = createFrameSource({
      ...baseOptions(),
      backend,
      batch: backend.createBatch({ width: 320, height: 480 }),
      titles: [
        {
          itemId: "title-1",
          startMs: 0,
          endMs: 2_000,
          text: "Hello world",
          motionPreset: "fade",
        },
      ],
      titleStyle: style,
    });
    const commands = source.commandsAt(1_000);
    expect(commands.length).toBeGreaterThan(0);
  });

  it("draws nothing outside a title's own window", () => {
    const style = loadSystemStyleMap().get("vertical-clean");
    if (style === undefined) throw new Error("fixture style missing");
    const source = createFrameSource({
      ...baseOptions(),
      backend,
      batch: backend.createBatch({ width: 320, height: 480 }),
      titles: [
        {
          itemId: "title-1",
          startMs: 3_000,
          endMs: 5_000,
          text: "Hello world",
          motionPreset: "fade",
        },
      ],
      titleStyle: style,
    });
    expect(source.commandsAt(500)).toEqual([]);
  });

  it("rasterises a title frame without throwing, end to end through the pool-free path", () => {
    const style = loadSystemStyleMap().get("vertical-clean");
    if (style === undefined) throw new Error("fixture style missing");
    const source = createFrameSource({
      ...baseOptions(),
      backend,
      batch: backend.createBatch({ width: 320, height: 480 }),
      titles: [
        { itemId: "title-1", startMs: 0, endMs: 2_000, text: "Hello world", motionPreset: "pop" },
      ],
      titleStyle: style,
    });
    const bytes = source.frame(5); // frame 5 of 10fps lands mid-window
    expect(bytes.length).toBe(320 * 480 * 4);
  });
});
