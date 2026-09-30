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

  it("rasterises a title frame without throwing, end to end through the pool-free path", async () => {
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
    const bytes = await source.frame(5); // frame 5 of 10fps lands mid-window
    expect(bytes.length).toBe(320 * 480 * 4);
  });
});

describe("createFrameSource with a hook title (2026-09-29)", () => {
  it("draws the projection's hook title inside its window, and nothing after it", () => {
    const source = createFrameSource({
      ...baseOptions(),
      projection: {
        ...EMPTY_PROJECTION,
        overlays: [
          {
            id: "01JHOOK0000000000000000000",
            kind: "hook-title",
            text: "Paisa bachana easy hai",
            startMs: 0,
            endMs: 2_500,
          },
        ],
      },
      backend,
      batch: backend.createBatch({ width: 320, height: 480 }),
    });
    const during = JSON.stringify(source.commandsAt(1_200));
    expect(during).toContain("hook-title:01JHOOK0000000000000000000");
    expect(source.commandsAt(2_600)).toEqual([]);
  });
});

describe("createFrameSource with a brand kit's logo (2026-10-02)", () => {
  /** An 8×4 opaque red PNG, the logo. */
  const RED_PNG = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAEklEQVR4nGP4z8DwHx9moL0CAHD0P8F+ACg+AAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  const ASSET = "01JASSET000000000000000000";

  it("rasterises the logo in its corner, from the image the render registered", async () => {
    await backend.registerImage(ASSET, RED_PNG);
    const source = createFrameSource({
      ...baseOptions(),
      projection: {
        ...EMPTY_PROJECTION,
        overlays: [
          {
            id: "01JMGG00000000000000000000",
            kind: "logo",
            startMs: 0,
            endMs: 10_000,
            image: { assetId: ASSET, format: "png", width: 8, height: 4 },
            corner: "top-right",
            sizePct: 25,
            opacity: 1,
            marginPct: 5,
          },
        ],
      },
      backend,
      batch: backend.createBatch({ width: 320, height: 480 }),
    });
    const bytes = await source.frame(5);
    // 25 % of 320 wide = 80 × 40, 16 px (5 % of 320) in from the top right.
    const at = (x: number, y: number): number[] => {
      const offset = (y * 320 + x) * 4;
      return [...bytes.slice(offset, offset + 4)];
    };
    const inside = at(320 - 16 - 40, 16 + 20);
    expect(inside[0]).toBeGreaterThan(200);
    expect(inside[3]).toBeGreaterThan(200);
    // The opposite corner is untouched.
    expect(at(20, 460)[3]).toBe(0);
  });
});

describe("createFrameSource with a B-roll cutaway (2026-10-05)", () => {
  const PICTURE = "01JPX0000000000000000000C1";

  it("covers the frame with the picture, under the captions, and fades it", async () => {
    // A 12×8 opaque green picture, wider than the 320×480 frame: covering it
    // scales it up and crops its sides.
    const green = backend.renderToPng(
      [
        {
          kind: "rect",
          rect: [0, 0, 12, 8],
          fill: { paint: { type: "solid", color: "#00c040ff" } },
        },
      ],
      { width: 12, height: 8 },
    );
    await backend.registerImage(PICTURE, green);
    const source = createFrameSource({
      ...baseOptions(),
      projection: {
        ...EMPTY_PROJECTION,
        overlays: [
          {
            id: "01JBR0000000000000000000C1",
            kind: "b-roll",
            startMs: 1_000,
            endMs: 9_000,
            image: { assetId: PICTURE, format: "png", width: 12, height: 8 },
            mode: "full",
            motion: "push-in",
          },
        ],
      },
      backend,
      batch: backend.createBatch({ width: 320, height: 480 }),
    });
    const at = (bytes: Uint8Array, x: number, y: number): number[] => {
      const offset = (y * 320 + x) * 4;
      return [...bytes.slice(offset, offset + 4)];
    };
    // Frame 50 of 10 fps: 5 s, the middle of its window. Every corner is green.
    const middle = await source.frame(50);
    for (const [x, y] of [
      [2, 2],
      [317, 2],
      [160, 240],
      [2, 477],
      [317, 477],
    ] as const) {
      const [r = 0, g = 0, b = 0, a = 0] = at(middle, x, y);
      expect(g, `green at ${String(x)},${String(y)}`).toBeGreaterThan(150);
      expect(r).toBeLessThan(40);
      expect(b).toBeLessThan(100);
      expect(a).toBeGreaterThan(250);
    }
    // Before its window, nothing; a tenth of a second in, still fading in.
    expect(at(await source.frame(5), 160, 240)[3]).toBe(0);
    const fading = at(await source.frame(11), 160, 240)[3] ?? 0;
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(250);
  });
});
