import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { animate, type DrawCommand, layoutSegment } from "@montaj/render-core";
import { createFixtureRenderer, GOLDEN_CANVAS } from "@montaj/render-core/testing";

import { Arena, withArena } from "./arena.js";
import { CanvasKitBackend, CanvasKitError } from "./backend.js";
import { CANVASKIT_VERSION, loadCanvasKit, resetCanvasKit } from "./canvaskit.js";
import { toMatrix3x3 } from "./execute.js";
import { BASELINE_BACKGROUND, BASELINE_CANVAS, BASELINE_FRAMES } from "./frames.js";
import { PACKAGE_INFO } from "./package-info.js";
import {
  buildBaselineCommands,
  comparePixels,
  loadFixtureFonts,
  PARITY_MAX_DIFF_RATIO,
} from "./testing.js";

import type { CanvasKit } from "canvaskit-wasm";

const BASELINE_DIR = join(__dirname, "..", "fixtures", "baselines");

let ck: CanvasKit;
let backend: CanvasKitBackend;
let commands: Record<string, DrawCommand[]>;

beforeAll(async () => {
  ck = await loadCanvasKit();
  backend = await CanvasKitBackend.create({ canvasKit: ck, fonts: loadFixtureFonts() });
  commands = await buildBaselineCommands();
});

afterAll(() => {
  backend.dispose();
});

/** Straight RGBA of an encoded frame, decoded with the same Skia build. */
function decode(bytes: Uint8Array): Uint8Array {
  const image = ck.MakeImageFromEncoded(bytes);
  if (image === null) throw new Error("could not decode a PNG");
  try {
    const pixels = image.readPixels(0, 0, {
      width: image.width(),
      height: image.height(),
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (pixels === null) throw new Error("could not read the decoded PNG");
    return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);
  } finally {
    image.delete();
  }
}

function render(name: string): Uint8Array {
  const list = commands[name];
  if (list === undefined) throw new Error(`no commands for ${name}`);
  return backend.renderToPng(list, {
    width: BASELINE_CANVAS.width,
    height: BASELINE_CANVAS.height,
    background: BASELINE_BACKGROUND,
  });
}

describe("the arena", () => {
  it("frees what it was given, newest first", () => {
    const freed: string[] = [];
    const arena = new Arena();
    arena.keep({
      delete: () => {
        freed.push("first");
      },
    });
    arena.keep({
      delete: () => {
        freed.push("second");
      },
    });
    expect(arena.size).toBe(2);
    arena.release();
    expect(freed).toEqual(["second", "first"]);
    expect(arena.size).toBe(0);
    arena.release();
    expect(freed).toEqual(["second", "first"]);
  });

  it("skips an object that says it is already deleted", () => {
    let deleted = 0;
    const arena = new Arena();
    arena.keep({
      delete: () => {
        deleted += 1;
      },
      isDeleted: () => true,
    });
    arena.release();
    expect(deleted).toBe(0);
  });

  it("survives a delete that throws", () => {
    const arena = new Arena();
    arena.keep({
      delete: () => {
        throw new Error("boom");
      },
    });
    expect(() => {
      arena.release();
    }).not.toThrow();
  });

  it("releases however the body ends", () => {
    let freed = 0;
    const track = (arena: Arena): void => {
      arena.keep({
        delete: () => {
          freed += 1;
        },
      });
    };
    expect(
      withArena((arena) => {
        track(arena);
        return 7;
      }),
    ).toBe(7);
    expect(() =>
      withArena((arena) => {
        track(arena);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(freed).toBe(2);
  });
});

describe("the CanvasKit module", () => {
  it("is pinned to the version the baselines were drawn with", () => {
    expect(CANVASKIT_VERSION).toBe("0.42.0");
  });

  it("is loaded once per process", async () => {
    expect(await loadCanvasKit()).toBe(ck);
  });
});

describe("package identity", () => {
  it("reports itself as implemented now that A16 has landed", () => {
    expect(PACKAGE_INFO).toEqual({
      name: "@montaj/render-canvaskit",
      implementedBy: "A16",
      implemented: true,
    });
  });

  it("can be asked to forget the cached module", async () => {
    resetCanvasKit();
    const reloaded = await loadCanvasKit();
    expect(typeof reloaded.MakeSurface).toBe("function");
  });
});

describe("matrices", () => {
  it("expands Skia's six-element form into a row-major 3×3", () => {
    expect(toMatrix3x3([2, 0, 0, 3, 10, 20])).toEqual([2, 0, 10, 0, 3, 20, 0, 0, 1]);
  });
});

describe("font and image registration", () => {
  it("registers one typeface per face id", () => {
    expect(backend.registeredFontIds).toContain("noto-sans-400");
    expect(backend.registeredFontIds).toContain("noto-sans-devanagari-400");
    expect(backend.registeredFontIds).toContain("noto-sans-tamil-400");
    expect(backend.registeredFontIds).toHaveLength(30);
  });

  it("names the face Skia could not read", async () => {
    const bare = await CanvasKitBackend.create({ canvasKit: ck });
    expect(() =>
      bare.registerFont({
        id: "junk",
        family: "Junk",
        weight: 400,
        italic: false,
        data: new Uint8Array([1, 2, 3, 4]),
      }),
    ).toThrow(CanvasKitError);
    bare.dispose();
  });

  it("re-registering a face replaces it", () => {
    const fonts = loadFixtureFonts();
    const first = fonts[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(() => {
      backend.registerFont(first);
    }).not.toThrow();
    expect(backend.registeredFontIds).toHaveLength(30);
  });

  it("decodes an image for the watermark command and refuses junk", () => {
    const png = render("vertical-clean-tamil");
    expect(() => {
      backend.registerImage("frame", png);
    }).not.toThrow();
    expect(() => {
      backend.registerImage("junk", new Uint8Array([0, 1, 2]));
    }).toThrow(CanvasKitError);
  });
});

describe("drawing", () => {
  it("reproduces every committed PNG baseline", () => {
    for (const frame of BASELINE_FRAMES) {
      const drawn = decode(render(frame.name));
      const baseline = decode(readFileSync(join(BASELINE_DIR, `${frame.name}.png`)));
      const diff = comparePixels(drawn, baseline);
      expect(
        diff.ratio,
        `${frame.name}: ${String(diff.differing)} pixels differ`,
      ).toBeLessThanOrEqual(PARITY_MAX_DIFF_RATIO);
    }
  });

  it("is deterministic: the same commands encode to the same bytes", () => {
    expect(
      Buffer.from(render("punch-pop-hinglish")).equals(Buffer.from(render("punch-pop-hinglish"))),
    ).toBe(true);
  });

  it("actually puts ink on the canvas", () => {
    const pixels = decode(render("punch-pop-hinglish"));
    const background = decode(
      backend.renderToPng([], {
        width: BASELINE_CANVAS.width,
        height: BASELINE_CANVAS.height,
        background: BASELINE_BACKGROUND,
      }),
    );
    const diff = comparePixels(pixels, background);
    expect(diff.differing).toBeGreaterThan(1000);
  });

  it("draws a caption without a background over a transparent surface", () => {
    const list = commands["vertical-clean-tamil"];
    expect(list).toBeDefined();
    if (list === undefined) return;
    const png = backend.renderToPng(list, { width: 200, height: 120 });
    expect(png.length).toBeGreaterThan(0);
  });

  it("reports a font it could not find instead of throwing", () => {
    const missingFont: DrawCommand[] = [
      {
        kind: "text",
        run: {
          fontId: "ghost-400",
          fontSizePx: 40,
          glyphs: [1],
          positions: [10, 40],
          clusters: [0],
          text: "x",
        },
        fill: { paint: { type: "solid", color: "#ffffffff" } },
      },
    ];
    backend.renderToPng(missingFont, { width: 64, height: 64 });
    expect(backend.missingResources).toEqual([{ kind: "font", id: "ghost-400" }]);
  });

  it("reports an image it could not find instead of throwing", () => {
    backend.renderToPng([{ kind: "image", assetId: "nope", dest: [0, 0, 10, 10] }], {
      width: 32,
      height: 32,
    });
    expect(backend.missingResources).toEqual([{ kind: "image", id: "nope" }]);
  });

  it("draws an image once it is registered", () => {
    backend.registerImage("mark", render("vertical-clean-tamil"));
    const png = backend.renderToPng(
      [{ kind: "image", assetId: "mark", dest: [0, 0, 64, 64], opacity: 0.5 }],
      {
        width: 64,
        height: 64,
        background: "#000000ff",
      },
    );
    const pixels = decode(png);
    const blank = decode(
      backend.renderToPng([], { width: 64, height: 64, background: "#000000ff" }),
    );
    expect(comparePixels(pixels, blank).differing).toBeGreaterThan(0);
    expect(backend.missingResources).toEqual([]);
  });

  it("executes every command kind the union defines", () => {
    const every: DrawCommand[] = [
      {
        kind: "rect",
        rect: [0, 0, 40, 40],
        fill: { paint: { type: "solid", color: "#ff0000ff" } },
      },
      {
        kind: "rect",
        rect: [0, 0, 40, 40],
        stroke: {
          paint: { type: "solid", color: "#00ff00ff" },
          widthPx: 2,
          join: "miter",
          cap: "butt",
        },
      },
      {
        kind: "roundRect",
        rect: [10, 10, 60, 60],
        radiusX: 8,
        radiusY: 8,
        fill: {
          paint: {
            type: "linear-gradient",
            from: [10, 10],
            to: [60, 60],
            stops: [
              { offset: 0, color: "#ff00ffff" },
              { offset: 1, color: "#00ffffff" },
            ],
          },
        },
        stroke: {
          paint: { type: "solid", color: "#ffffffff" },
          widthPx: 1,
          join: "bevel",
          cap: "square",
        },
      },
      {
        kind: "path",
        d: "M4 4L60 4L60 60Z",
        fillRule: "evenodd",
        fill: {
          paint: {
            type: "radial-gradient",
            centre: [32, 32],
            radius: 30,
            stops: [
              { offset: 0, color: "#ffffffff" },
              { offset: 1, color: "#00000000" },
            ],
          },
        },
        stroke: {
          paint: { type: "solid", color: "#000000ff" },
          widthPx: 1,
          join: "round",
          cap: "round",
        },
      },
      { kind: "path", d: "not a path", fill: { paint: { type: "solid", color: "#ffffffff" } } },
      {
        kind: "group",
        id: "faded",
        opacity: 0.4,
        children: [
          {
            kind: "rect",
            rect: [0, 0, 20, 20],
            fill: { paint: { type: "solid", color: "#ffffffff" } },
          },
        ],
      },
      { kind: "group", children: [{ kind: "rect", rect: [0, 0, 5, 5] }] },
      {
        kind: "transform",
        matrix: [1, 0, 0, 1, 5, 5],
        children: [
          {
            kind: "rect",
            rect: [0, 0, 8, 8],
            fill: { paint: { type: "solid", color: "#123456ff" } },
          },
        ],
      },
      {
        kind: "clip",
        shape: { type: "rect", rect: [0, 0, 30, 30] },
        antiAlias: true,
        children: [
          {
            kind: "rect",
            rect: [0, 0, 64, 64],
            fill: { paint: { type: "solid", color: "#0000ffff" } },
          },
        ],
      },
      {
        kind: "clip",
        shape: { type: "roundRect", rect: [0, 0, 30, 30], radiusX: 4, radiusY: 4 },
        antiAlias: false,
        children: [{ kind: "rect", rect: [0, 0, 64, 64] }],
      },
      {
        kind: "clip",
        shape: { type: "path", d: "M0 0L30 0L30 30Z", fillRule: "evenodd" },
        antiAlias: true,
        children: [{ kind: "rect", rect: [0, 0, 64, 64] }],
      },
      {
        kind: "clip",
        shape: { type: "path", d: "still not a path" },
        antiAlias: true,
        children: [{ kind: "rect", rect: [0, 0, 64, 64] }],
      },
      {
        kind: "shadow",
        dx: 2,
        dy: 2,
        sigma: 3,
        color: "#000000aa",
        children: [
          {
            kind: "rect",
            rect: [20, 20, 40, 40],
            fill: { paint: { type: "solid", color: "#ffffffff" } },
          },
        ],
      },
      {
        kind: "shadow",
        dx: 0,
        dy: 0,
        sigma: 4,
        color: "#ff00ffff",
        shadowOnly: true,
        children: [
          {
            kind: "rect",
            rect: [20, 20, 40, 40],
            fill: { paint: { type: "solid", color: "#ffffffff" } },
          },
        ],
      },
      {
        kind: "blur",
        sigmaX: 2,
        sigmaY: 2,
        children: [
          {
            kind: "rect",
            rect: [10, 10, 50, 50],
            fill: { paint: { type: "solid", color: "#00ff00ff" } },
          },
        ],
      },
      {
        kind: "blur",
        sigmaX: 6,
        sigmaY: 6,
        backdrop: true,
        bounds: [0, 0, 64, 64],
        children: [
          {
            kind: "rect",
            rect: [0, 0, 64, 64],
            fill: { paint: { type: "solid", color: "#ffffff22" } },
          },
        ],
      },
      {
        kind: "blur",
        sigmaX: 1,
        sigmaY: 1,
        backdrop: true,
        children: [{ kind: "rect", rect: [0, 0, 4, 4] }],
      },
    ];
    expect(() =>
      backend.renderToPng(every, { width: 64, height: 64, background: "#101018ff" }),
    ).not.toThrow();
  });

  it("refuses a command kind that is not in the union", () => {
    expect(() =>
      backend.renderToPng([{ kind: "nope" } as unknown as DrawCommand], { width: 8, height: 8 }),
    ).toThrow(/unhandled draw command/);
  });

  it("names an impossible surface", () => {
    expect(() => backend.renderToPng([], { width: 0, height: 0 })).toThrow(CanvasKitError);
  });
});

describe("a whole frame end to end", () => {
  it("draws a caption laid out from a StyleDoc at the proxy size", async () => {
    const { registry, shaper } = await createFixtureRenderer();
    const style = loadSystemStyleMap().get("hype-bold");
    expect(style).toBeDefined();
    if (style === undefined) return;
    const layout = layoutSegment({
      style,
      segment: { id: "seg", startMs: 0, endMs: 2000 },
      words: [
        { wid: "0:0", t: "one", s: 0, e: 1000 },
        { wid: "0:1", t: "two", s: 1000, e: 2000 },
      ],
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 1200,
    });
    const png = backend.renderToPng(animate({ layout, style, tMs: 1200 }), {
      width: GOLDEN_CANVAS.width,
      height: GOLDEN_CANVAS.height,
      background: "#000000ff",
    });
    expect(png.length).toBeGreaterThan(1000);
    expect(backend.missingResources).toEqual([]);
  });
});

describe("comparePixels", () => {
  it("counts pixels whose worst channel is over the tolerance", () => {
    const a = new Uint8Array([0, 0, 0, 255, 10, 10, 10, 255]);
    const b = new Uint8Array([0, 0, 0, 255, 12, 10, 10, 255]);
    expect(comparePixels(a, b)).toEqual({ differing: 0, total: 2, ratio: 0, maxChannelDelta: 2 });
    expect(comparePixels(a, new Uint8Array([0, 0, 0, 255, 20, 10, 10, 255])).differing).toBe(1);
  });

  it("refuses buffers of different sizes", () => {
    expect(() => comparePixels(new Uint8Array(4), new Uint8Array(8))).toThrow(/cannot compare/);
  });

  it("treats two empty buffers as identical", () => {
    expect(comparePixels(new Uint8Array(0), new Uint8Array(0)).ratio).toBe(0);
  });
});
