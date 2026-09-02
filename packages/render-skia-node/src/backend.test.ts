import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { animate, layoutSegment, type DrawCommand } from "@montaj/render-core";
import { CAPTION_FIXTURES, PROXY_CANVAS } from "@montaj/render-core/testing";

import { SkiaNodeBackend } from "./backend.js";
import { isSkiaNodeError, SkiaNodeError } from "./errors.js";
import {
  commandCount,
  cssColour,
  executeCommands,
  parseColour,
  SHADOW_BLUR_PER_SIGMA,
  SKIA_MITER_LIMIT,
  toTransformArgs,
  tracePath,
  traceRoundRect,
} from "./executor.js";
import { PACKAGE_INFO } from "./package-info.js";
import { comparePixels, createFixtureRenderer } from "./testing.js";
import { NAPI_CANVAS_VERSION } from "./version.js";

const SIZE = { width: 64, height: 64 } as const;

const WHITE_SQUARE: DrawCommand = {
  kind: "rect",
  rect: [16, 16, 48, 48],
  fill: { paint: { type: "solid", color: "#ffffffff" } },
};

/** A 2×2 red PNG, inlined so no test reads a file. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAUSURBVAiZY/zPwPCfgYGBgYkBCgAfFwICvtwYPAAAAABJRU5ErkJggg==",
  "base64",
);

function pixel(rgba: Uint8Array, x: number, y: number, width = SIZE.width): number[] {
  const index = (y * width + x) * 4;
  return [rgba[index] ?? 0, rgba[index + 1] ?? 0, rgba[index + 2] ?? 0, rgba[index + 3] ?? 0];
}

describe("the package", () => {
  it("declares itself implemented by A20", () => {
    expect(PACKAGE_INFO).toEqual({
      name: "@montaj/render-skia-node",
      implementedBy: "A20",
      implemented: true,
    });
  });

  it("pins the Skia build it draws with", async () => {
    const manifest = (await import("../package.json")) as unknown as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@napi-rs/canvas"]).toBe(NAPI_CANVAS_VERSION);
  });
});

describe("colour conversion", () => {
  it("reads #RRGGBB as fully opaque", () => {
    expect(parseColour("#336699")).toEqual([0x33, 0x66, 0x99, 1]);
  });

  it("reads the alpha byte of #RRGGBBAA", () => {
    expect(parseColour("#33669980")).toEqual([0x33, 0x66, 0x99, 128 / 255]);
  });

  it("multiplies a command's opacity into the alpha", () => {
    expect(cssColour("#ff000080", 0.5)).toBe(`rgba(255, 0, 0, ${String((128 / 255) * 0.5)})`);
  });
});

describe("the matrix", () => {
  it("passes straight through: our order is already Canvas2D's", () => {
    expect(toTransformArgs([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("path replay", () => {
  it("replays the M/L/Q/C/Z subset render-core emits", () => {
    const canvas = createCanvas(16, 16);
    const ctx = canvas.getContext("2d");
    expect(() => {
      tracePath(ctx, "M1 1L8 1Q12 1 12 5C12 9 8 12 4 12Z");
    }).not.toThrow();
  });

  it("treats an empty path as an empty path rather than an error", () => {
    const ctx = createCanvas(4, 4).getContext("2d");
    expect(() => {
      tracePath(ctx, "");
    }).not.toThrow();
  });

  it("refuses a token it cannot draw rather than dropping the curve", () => {
    const ctx = createCanvas(4, 4).getContext("2d");
    expect(() => {
      tracePath(ctx, "M0 0A5 5 0 0 1 10 10");
    }).toThrow(SkiaNodeError);
    try {
      tracePath(ctx, "M0 0S1 1 2 2");
    } catch (error) {
      expect(isSkiaNodeError(error, "skia-node/unsupported-command")).toBe(true);
    }
  });

  it("returns to the subpath start after a close", () => {
    const canvas = createCanvas(20, 20);
    const ctx = canvas.getContext("2d");
    tracePath(ctx, "M2 2L18 2L18 18Z L10 10");
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    expect(ctx.getImageData(15, 5, 1, 1).data[3]).toBeGreaterThan(0);
  });
});

describe("round rectangles", () => {
  it("degenerates to a plain rectangle when a radius is zero", () => {
    const canvas = createCanvas(20, 20);
    const ctx = canvas.getContext("2d");
    traceRoundRect(ctx, [2, 2, 18, 18], 0, 6);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    // A real corner would be transparent here.
    expect(ctx.getImageData(3, 3, 1, 1).data[3]).toBe(255);
  });

  it("clamps a radius to half the side, the way SkRRect does", () => {
    const canvas = createCanvas(20, 20);
    const ctx = canvas.getContext("2d");
    traceRoundRect(ctx, [0, 0, 20, 20], 500, 500);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    // Radius 500 clamped to 10 makes a circle: the corner is empty, the centre full.
    expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(0);
    expect(ctx.getImageData(10, 10, 1, 1).data[3]).toBe(255);
  });
});

describe("the backend", () => {
  it("rasterises straight, not premultiplied, RGBA", async () => {
    const backend = await SkiaNodeBackend.create();
    const rgba = backend.renderFrameToRgba(
      [
        {
          kind: "rect",
          rect: [0, 0, 64, 64],
          fill: { paint: { type: "solid", color: "#ff000080" } },
        },
      ],
      SIZE,
    );
    // Premultiplied would read [128, 0, 0, 128]; ffmpeg's `rgba` wants straight.
    expect(pixel(rgba, 32, 32)).toEqual([255, 0, 0, 128]);
  });

  it("starts from a transparent surface when no background is given", async () => {
    const backend = await SkiaNodeBackend.create();
    const rgba = backend.renderFrameToRgba([WHITE_SQUARE], SIZE);
    expect(pixel(rgba, 2, 2)[3]).toBe(0);
    expect(pixel(rgba, 32, 32)).toEqual([255, 255, 255, 255]);
  });

  it("fills an opaque background when one is given", async () => {
    const backend = await SkiaNodeBackend.create();
    const rgba = backend.renderFrameToRgba([], { ...SIZE, background: "#00ff00ff" });
    expect(pixel(rgba, 2, 2)).toEqual([0, 255, 0, 255]);
  });

  it("accepts a six-digit background too", async () => {
    const backend = await SkiaNodeBackend.create();
    const rgba = backend.renderFrameToRgba([], { ...SIZE, background: "#0000ff" });
    expect(pixel(rgba, 2, 2)).toEqual([0, 0, 255, 255]);
  });

  it("encodes a PNG", async () => {
    const backend = await SkiaNodeBackend.create();
    const png = backend.renderToPng([WHITE_SQUARE], SIZE);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("refuses a surface with no pixels", async () => {
    const backend = await SkiaNodeBackend.create();
    expect(() => backend.renderFrameToRgba([], { width: 0, height: 10 })).toThrow(SkiaNodeError);
    expect(() => backend.renderFrameToRgba([], { width: 10.5, height: 10 })).toThrow(
      /cannot make a/,
    );
  });

  it("refuses a text command when it has no shaper", async () => {
    const backend = await SkiaNodeBackend.create();
    const text: DrawCommand = {
      kind: "text",
      run: {
        fontId: "x",
        fontSizePx: 10,
        glyphs: [1],
        positions: [0, 0],
        clusters: [0],
        text: "a",
      },
      fill: { paint: { type: "solid", color: "#ffffffff" } },
    };
    expect(() => backend.outline([{ kind: "group", children: [text] }])).toThrow(
      /without a shaper/,
    );
  });

  it("passes a text-free list through untouched when it has no shaper", async () => {
    const backend = await SkiaNodeBackend.create();
    expect(backend.outline([WHITE_SQUARE])).toEqual([WHITE_SQUARE]);
  });

  it("outlines text into paths when it has one", async () => {
    const { shaper } = await createFixtureRenderer();
    const backend = await SkiaNodeBackend.create({ shaper });
    const style = loadSystemStyleMap().get("subtitle-classic");
    expect(style).toBeDefined();
    if (style === undefined) return;
    const fixture = CAPTION_FIXTURES[3];
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const { registry } = await createFixtureRenderer();
    const layout = layoutSegment({
      style,
      segment: fixture.segment,
      words: fixture.words,
      canvas: PROXY_CANVAS,
      registry,
      shaper,
      tMs: 1500,
    });
    const commands = animate({ layout, style, tMs: 1500 });
    const outlined = backend.outline(commands);
    const kinds = new Set<string>();
    const walk = (list: readonly DrawCommand[]): void => {
      for (const command of list) {
        kinds.add(command.kind);
        if ("children" in command) walk(command.children);
      }
    };
    walk(outlined);
    expect(kinds.has("text")).toBe(false);
    expect(kinds.has("path")).toBe(true);
  });

  it("reports a missing image instead of failing the frame", async () => {
    const backend = await SkiaNodeBackend.create();
    const batch = backend.createBatch(SIZE);
    batch.render([
      WHITE_SQUARE,
      { kind: "image", assetId: "watermark", dest: [0, 0, 16, 16] },
      { kind: "image", assetId: "watermark", dest: [0, 0, 16, 16] },
    ]);
    // Reported once, not twice, and the square still drew.
    expect(batch.diagnostics.missing).toEqual([{ kind: "image", id: "watermark" }]);
    expect(pixel(batch.buffer, 32, 32)).toEqual([255, 255, 255, 255]);
  });

  it("draws a registered image at its destination rectangle and opacity", async () => {
    const backend = await SkiaNodeBackend.create();
    await backend.registerImage("mark", RED_PNG);
    expect(backend.registeredImageIds).toEqual(["mark"]);
    const rgba = backend.renderFrameToRgba(
      [{ kind: "image", assetId: "mark", dest: [0, 0, 32, 32], opacity: 0.5 }],
      SIZE,
    );
    expect(pixel(rgba, 8, 8)[0]).toBe(255);
    expect(pixel(rgba, 8, 8)[3]).toBeCloseTo(128, -1);
    expect(pixel(rgba, 40, 40)[3]).toBe(0);
    backend.dispose();
    expect(backend.registeredImageIds).toEqual([]);
  });

  it("refuses bytes that are not an image", async () => {
    const backend = await SkiaNodeBackend.create();
    await expect(backend.registerImage("junk", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      SkiaNodeError,
    );
  });

  it("reports an anisotropic blur as an approximation rather than drawing a lie", async () => {
    const backend = await SkiaNodeBackend.create();
    const batch = backend.createBatch(SIZE);
    batch.render([{ kind: "blur", sigmaX: 4, sigmaY: 1, children: [WHITE_SQUARE] }]);
    expect(batch.diagnostics.approximations).toHaveLength(1);
    expect(batch.diagnostics.approximations[0]?.kind).toBe("anisotropic-blur");
  });

  it("refuses a command list that nests layers without end", async () => {
    const backend = await SkiaNodeBackend.create({ maxLayerDepth: 4 });
    let nested: DrawCommand = WHITE_SQUARE;
    for (let depth = 0; depth < 6; depth += 1) {
      nested = { kind: "group", opacity: 0.5, children: [nested] };
    }
    expect(() => backend.renderFrameToRgba([nested], SIZE)).toThrow(/nests layers/);
  });

  it("draws a fully opaque group without paying for a layer", async () => {
    const backend = await SkiaNodeBackend.create();
    const withGroup = backend.renderFrameToRgba(
      [{ kind: "group", opacity: 1, children: [WHITE_SQUARE] }],
      SIZE,
    );
    const bare = Uint8Array.from(backend.renderFrameToRgba([WHITE_SQUARE], SIZE));
    expect(comparePixels(bare, withGroup).differing).toBe(0);
  });

  it("clips to a rectangle and to a round rectangle", async () => {
    const backend = await SkiaNodeBackend.create();
    const rect = backend.renderFrameToRgba(
      [
        {
          kind: "clip",
          antiAlias: true,
          shape: { type: "rect", rect: [0, 0, 32, 64] },
          children: [WHITE_SQUARE],
        },
      ],
      SIZE,
    );
    expect(pixel(rect, 20, 32)[3]).toBe(255);
    expect(pixel(rect, 40, 32)[3]).toBe(0);

    const rounded = backend.renderFrameToRgba(
      [
        {
          kind: "clip",
          antiAlias: true,
          shape: { type: "roundRect", rect: [16, 16, 48, 48], radiusX: 15, radiusY: 15 },
          children: [WHITE_SQUARE],
        },
      ],
      SIZE,
    );
    expect(pixel(rounded, 32, 32)[3]).toBe(255);
    expect(pixel(rounded, 17, 17)[3]).toBe(0);
  });

  it("strokes and fills the same shape, stroke under fill", async () => {
    const backend = await SkiaNodeBackend.create();
    const rgba = backend.renderFrameToRgba(
      [
        {
          kind: "roundRect",
          rect: [16, 16, 48, 48],
          radiusX: 4,
          radiusY: 4,
          fill: { paint: { type: "solid", color: "#ffffffff" } },
          stroke: {
            paint: { type: "solid", color: "#ff0000ff" },
            widthPx: 4,
            join: "miter",
            cap: "butt",
          },
        },
      ],
      SIZE,
    );
    expect(pixel(rgba, 32, 32)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba, 32, 16)[0]).toBe(255);
    expect(pixel(rgba, 32, 16)[1]).toBe(0);
  });

  it("refuses an unknown command kind", async () => {
    const backend = await SkiaNodeBackend.create();
    expect(() =>
      backend.renderFrameToRgba([{ kind: "wat" } as unknown as DrawCommand], SIZE),
    ).toThrow(/unhandled draw command/);
  });

  it("exposes the executor for a host that owns its own surface", () => {
    const canvas = createCanvas(SIZE.width, SIZE.height);
    const ctx = canvas.getContext("2d");
    executeCommands(
      {
        ctx,
        width: SIZE.width,
        height: SIZE.height,
        createCanvas: (width, height) => createCanvas(width, height),
      },
      [WHITE_SQUARE],
    );
    expect(ctx.getImageData(32, 32, 1, 1).data[3]).toBe(255);
  });
});

describe("the batch API", () => {
  it("reuses one buffer across frames and counts what it rasterised", async () => {
    const backend = await SkiaNodeBackend.create();
    const batch = backend.createBatch(SIZE);
    expect(batch.buffer).toHaveLength(SIZE.width * SIZE.height * 4);
    expect(batch.rendered).toBe(0);

    const first = batch.render([WHITE_SQUARE]);
    expect(first).toBe(batch.buffer);
    expect(pixel(batch.buffer, 32, 32)).toEqual([255, 255, 255, 255]);

    const second = batch.render([
      {
        kind: "rect",
        rect: [16, 16, 48, 48],
        fill: { paint: { type: "solid", color: "#0000ffff" } },
      },
    ]);
    expect(second).toBe(first);
    expect(batch.rendered).toBe(2);
    // The surface is cleared between frames: no ghost of the white square.
    expect(pixel(batch.buffer, 32, 32)).toEqual([0, 0, 255, 255]);
  });

  it("clears the surface between frames even with no background", async () => {
    const backend = await SkiaNodeBackend.create();
    const batch = backend.createBatch(SIZE);
    batch.render([WHITE_SQUARE]);
    batch.render([]);
    expect(pixel(batch.buffer, 32, 32)).toEqual([0, 0, 0, 0]);
  });

  it("resets the transform between frames", async () => {
    const backend = await SkiaNodeBackend.create();
    const batch = backend.createBatch(SIZE);
    batch.render([{ kind: "transform", matrix: [1, 0, 0, 1, 16, 16], children: [WHITE_SQUARE] }]);
    const shifted = Array.from(batch.buffer);
    batch.render([WHITE_SQUARE]);
    expect(Array.from(batch.buffer)).not.toEqual(shifted);
    expect(pixel(batch.buffer, 32, 32)).toEqual([255, 255, 255, 255]);
  });
});

describe("the constants that keep the two Skia surfaces honest", () => {
  it("names the shadow blur conversion", () => {
    expect(SHADOW_BLUR_PER_SIGMA).toBe(2);
  });

  it("names Skia's miter limit", () => {
    expect(SKIA_MITER_LIMIT).toBe(4);
  });
});

describe("commandCount", () => {
  it("counts nested children", () => {
    expect(
      commandCount([
        { kind: "group", children: [WHITE_SQUARE, { kind: "group", children: [WHITE_SQUARE] }] },
        WHITE_SQUARE,
      ]),
    ).toBe(5);
  });
});
