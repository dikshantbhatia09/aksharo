/**
 * The parity suite: the same `DrawCommand[]` through CanvasKit and through
 * Skia-in-Node, compared with decision D33's own yardstick.
 *
 * **What the residual is.** Both backends are Skia, so every shape, gradient,
 * blur and shadow matches to the bit once the conventions are right (they are
 * asserted below, on their own, precisely so a regression names the convention
 * rather than a whole frame). Text is the one thing that cannot match exactly:
 * CanvasKit draws glyph *ids* through Skia's glyph cache, which rasterises a
 * hinted mask per glyph, while a Canvas2D surface has no glyph-id entry point at
 * all and has to fill the same outline as a path. The two differ along the
 * anti-aliased edge of every glyph, and the difference is worst where the type
 * is small — a 32 px caption has proportionally far more edge than a 90 px one.
 *
 * That is a *known* property of the D33 architecture, not a defect in this
 * backend: the alternative is a second text-layout engine in the cloud, which is
 * the thing D33 exists to prevent. A18a owns the formal gate; this suite pins
 * today's measured numbers so a regression is visible immediately.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BASELINE_BACKGROUND,
  BASELINE_CANVAS,
  BASELINE_FRAMES,
  CanvasKitBackend,
  loadCanvasKit,
} from "@montaj/render-canvaskit";
import { buildBaselineCommands } from "@montaj/render-canvaskit/testing";
import type { DrawCommand } from "@montaj/render-core";

import { SkiaNodeBackend } from "./backend.js";
import {
  buildParitySweep,
  comparePixels,
  createFixtureRenderer,
  loadFixtureFonts,
  PARITY_BACKGROUND,
  PARITY_MAX_DIFF_RATIO,
  PROXY_CANVAS,
  type ParityFrame,
} from "./testing.js";

import type { CanvasKit } from "canvaskit-wasm";

/**
 * Frames whose glyph-edge residual exceeds D33's 1%, with the measured value and
 * the reason. All three are **small type**, which is the whole pattern:
 *
 * - the two `-80` frames are the entry instant, where the caption is still
 *   scaled below its final size, so every glyph is drawn small;
 * - `neon-glow-english` sets 32 px, wraps twenty-one separate runs in it, and
 *   then puts a σ≈8 glow around them that spreads every edge disagreement into a
 *   halo.
 *
 * The budget is the measured figure plus headroom, not a round number: it is
 * meant to fail on a regression, not to be comfortable. The set moves when
 * layout moves — A16d's line budgets took `punch-pop-tamil-80` under the SLO and
 * put `punch-pop-english-80` over it — which is exactly why the numbers are
 * pinned per frame rather than waved through with one loose global bound.
 */
const KNOWN_TEXT_RESIDUALS: Readonly<Record<string, number>> = Object.freeze({
  "neon-glow-english": 0.04,
  "punch-pop-hinglish-80": 0.015,
  "punch-pop-english-80": 0.015,
});

let ck: CanvasKit;
let browser: CanvasKitBackend;
let cloud: SkiaNodeBackend;
let baselines: Record<string, DrawCommand[]>;
let sweep: ParityFrame[];

beforeAll(async () => {
  ck = await loadCanvasKit();
  browser = await CanvasKitBackend.create({ canvasKit: ck, fonts: loadFixtureFonts() });
  const renderer = await createFixtureRenderer();
  cloud = await SkiaNodeBackend.create({ shaper: renderer.shaper });
  baselines = await buildBaselineCommands();
  sweep = await buildParitySweep(renderer);
}, 120_000);

afterAll(() => {
  browser?.dispose();
  cloud?.dispose();
});

/** Straight RGBA of a CanvasKit render, decoded with the same Skia build. */
function browserPixels(
  commands: readonly DrawCommand[],
  width: number,
  height: number,
  background: string,
): Uint8Array {
  const png = browser.renderToPng(commands, { width, height, background });
  const image = ck.MakeImageFromEncoded(png);
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

function ratioFor(
  commands: readonly DrawCommand[],
  width: number,
  height: number,
  background: string,
): number {
  const expected = browserPixels(commands, width, height, background);
  const actual = cloud.renderFrameToRgba(commands, { width, height, background });
  return comparePixels(expected, actual).ratio;
}

function budgetFor(name: string): number {
  return KNOWN_TEXT_RESIDUALS[name] ?? PARITY_MAX_DIFF_RATIO;
}

describe("A16's baseline frames", () => {
  it.each(BASELINE_FRAMES.map((frame) => [frame.name, frame.covers] as const))(
    "%s draws the same picture in both backends (%s)",
    (name) => {
      const ratio = ratioFor(
        baselines[name] ?? [],
        BASELINE_CANVAS.width,
        BASELINE_CANVAS.height,
        BASELINE_BACKGROUND,
      );
      expect(ratio).toBeLessThanOrEqual(budgetFor(name));
    },
    60_000,
  );

  it("covers every baseline frame A16 committed", () => {
    expect(Object.keys(baselines).sort()).toEqual(BASELINE_FRAMES.map((f) => f.name).sort());
  });
});

describe("the four caption fixtures at three instants", () => {
  it("renders twelve frames", () => {
    expect(sweep).toHaveLength(12);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
    "fixture frame %i matches the browser",
    (index) => {
      const frame = sweep[index];
      expect(frame).toBeDefined();
      if (frame === undefined) return;
      const ratio = ratioFor(
        frame.commands,
        PROXY_CANVAS.width,
        PROXY_CANVAS.height,
        PARITY_BACKGROUND,
      );
      expect(ratio).toBeLessThanOrEqual(budgetFor(frame.name));
    },
    60_000,
  );

  it("keeps the mean disagreement across all nineteen frames inside the D33 SLO", () => {
    const ratios = [
      ...BASELINE_FRAMES.map((frame) =>
        ratioFor(
          baselines[frame.name] ?? [],
          BASELINE_CANVAS.width,
          BASELINE_CANVAS.height,
          BASELINE_BACKGROUND,
        ),
      ),
      ...sweep.map((frame) =>
        ratioFor(frame.commands, PROXY_CANVAS.width, PROXY_CANVAS.height, PARITY_BACKGROUND),
      ),
    ];
    const mean = ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length;
    expect(mean).toBeLessThanOrEqual(PARITY_MAX_DIFF_RATIO);
  }, 120_000);
});

describe("the conventions the two Skia surfaces do not share", () => {
  const size = { width: 160, height: 160, background: "#1a1a20ff" } as const;
  const square: DrawCommand = {
    kind: "rect",
    rect: [50, 50, 110, 110],
    fill: { paint: { type: "solid", color: "#ffffffff" } },
  };

  /**
   * Text is the only source of residual, so a list without any of it must be
   * **exact**. A non-zero number here is a real bug in a conversion, and these
   * are the three conversions with a unit in them.
   */
  const exact = (commands: DrawCommand[]): void => {
    const expected = browserPixels(commands, size.width, size.height, size.background);
    const actual = cloud.renderFrameToRgba(commands, size);
    const diff = comparePixels(expected, actual);
    expect(diff.differing).toBe(0);
  };

  it("draws a Gaussian blur at the same sigma (CSS blur() takes a standard deviation)", () => {
    exact([{ kind: "blur", sigmaX: 6, sigmaY: 6, children: [square] }]);
  });

  it("draws a drop shadow at the same sigma (Canvas2D's blur is a radius, Skia's is a sigma)", () => {
    exact([{ kind: "shadow", dx: 5, dy: 7, sigma: 6, color: "#ff0044ff", children: [square] }]);
  });

  it("draws a shadow-only glow the same way", () => {
    exact([
      {
        kind: "shadow",
        dx: 0,
        dy: 0,
        sigma: 9,
        color: "#00ffaaff",
        shadowOnly: true,
        children: [square],
      },
    ]);
  });

  it("draws a translucent layer once, not twice", () => {
    // The bug this catches drew the source through the shadow *and* over it, so
    // a half-transparent panel came out three-quarters opaque.
    exact([
      {
        kind: "shadow",
        dx: 0,
        dy: 3,
        sigma: 4,
        color: "#000000cc",
        children: [
          {
            kind: "roundRect",
            rect: [40, 40, 120, 120],
            radiusX: 18,
            radiusY: 10,
            fill: { paint: { type: "solid", color: "#ffffff55" } },
          },
        ],
      },
    ]);
  });

  it("uses Skia's miter limit of 4, not Canvas2D's 10", () => {
    exact([
      {
        kind: "path",
        d: "M20 140L80 24L140 140",
        stroke: {
          paint: { type: "solid", color: "#ffcc00ff" },
          widthPx: 14,
          join: "miter",
          cap: "butt",
        },
      },
    ]);
  });

  it("composites a group opacity the same way", () => {
    exact([{ kind: "group", opacity: 0.37, children: [square] }]);
  });

  it("draws elliptical round-rect corners the same way", () => {
    exact([
      {
        kind: "roundRect",
        rect: [20, 40, 140, 120],
        radiusX: 40,
        radiusY: 12,
        fill: { paint: { type: "solid", color: "#33ccffff" } },
        stroke: {
          paint: { type: "solid", color: "#ffffffff" },
          widthPx: 3,
          join: "round",
          cap: "round",
        },
      },
    ]);
  });

  it("places a linear gradient the same way", () => {
    exact([
      {
        kind: "rect",
        rect: [20, 20, 140, 140],
        fill: {
          paint: {
            type: "linear-gradient",
            from: [20, 20],
            to: [140, 140],
            stops: [
              { offset: 0, color: "#ff0000ff" },
              { offset: 0.5, color: "#00ff00ff" },
              { offset: 1, color: "#0000ffff" },
            ],
          },
        },
      },
    ]);
  });

  it("places a radial gradient the same way", () => {
    exact([
      {
        kind: "rect",
        rect: [0, 0, 160, 160],
        fill: {
          paint: {
            type: "radial-gradient",
            centre: [80, 80],
            radius: 60,
            stops: [
              { offset: 0, color: "#ffffffff" },
              { offset: 1, color: "#000000ff" },
            ],
          },
        },
      },
    ]);
  });

  it("applies an affine transform the same way", () => {
    exact([
      {
        kind: "transform",
        matrix: [1.4, 0.3, -0.2, 0.9, 12, -8],
        children: [square],
      },
    ]);
  });

  it("clips to a path the same way, including the even-odd rule", () => {
    exact([
      {
        kind: "clip",
        antiAlias: true,
        shape: {
          type: "path",
          d: "M20 20L140 20L140 140L20 140ZM50 50L110 50L110 110L50 110Z",
          fillRule: "evenodd",
        },
        children: [
          {
            kind: "rect",
            rect: [0, 0, 160, 160],
            fill: { paint: { type: "solid", color: "#ffaa00ff" } },
          },
        ],
      },
    ]);
  });
});

/**
 * The one place the two backends deliberately differ, pinned so that neither
 * side can move without this failing.
 *
 * `render-core` documents a `backdrop` blur as blurring "what is already on the
 * surface **inside `bounds`**", and `@montaj/render-canvaskit` implements that
 * as `saveLayer(undefined, bounds, filter, 0)`. Skia treats `SaveLayerRec`'s
 * bounds as a *hint* and ignores it here, so the browser blurs the whole frame:
 * measured on a 540×960 surface with a hard horizontal edge in the picture, the
 * disagreement is a σ-wide band right across the frame, hundreds of pixels
 * outside the panel.
 *
 * On a flat ground — which is what every committed baseline uses — blurring
 * outside the panel changes nothing, so this never showed up in A16's own
 * suite; over real footage it is the difference between a frosted caption panel
 * and a fogged video. This backend honours the documented contract and clips.
 * Inside `bounds` the two agree **exactly**, which is what the assertions below
 * say, and which is what keeps the divergence a bounded, reviewable one rather
 * than a drift. Fixing `render-canvaskit` is A16/A18a's call; it is outside this
 * work package's file boundaries.
 */
describe("the backdrop blur, where this backend diverges on purpose", () => {
  const width = 540;
  const height = 960;
  const background = "#1a1a20ff";
  const bounds = [120, 400, 420, 560] as const;
  const commands: DrawCommand[] = [
    {
      // A hard edge well outside the panel: without one, a full-frame blur and a
      // clipped one are indistinguishable.
      kind: "rect",
      rect: [0, 0, 540, 480],
      fill: { paint: { type: "solid", color: "#ff8800ff" } },
    },
    {
      kind: "blur",
      sigmaX: 5,
      sigmaY: 5,
      backdrop: true,
      bounds: [...bounds],
      children: [
        {
          kind: "roundRect",
          rect: [...bounds],
          radiusX: 16,
          radiusY: 16,
          fill: { paint: { type: "solid", color: "#ffffff33" } },
        },
      ],
    },
  ];

  function inside(index: number): boolean {
    const pixel = index / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    return x >= bounds[0] && x < bounds[2] && y >= bounds[1] && y < bounds[3];
  }

  it("matches the browser exactly inside the panel", () => {
    const expected = browserPixels(commands, width, height, background);
    const actual = cloud.renderFrameToRgba(commands, { width, height, background });
    let differing = 0;
    for (let index = 0; index < expected.length; index += 4) {
      if (!inside(index)) continue;
      for (let channel = 0; channel < 4; channel += 1) {
        if (Math.abs((expected[index + channel] ?? 0) - (actual[index + channel] ?? 0)) > 2) {
          differing += 1;
          break;
        }
      }
    }
    expect(differing).toBe(0);
  });

  it("leaves the picture outside the panel alone, where the browser blurs it", () => {
    const expected = browserPixels(commands, width, height, background);
    const actual = cloud.renderFrameToRgba(commands, { width, height, background });
    let outsideDiffering = 0;
    for (let index = 0; index < expected.length; index += 4) {
      if (inside(index)) continue;
      for (let channel = 0; channel < 4; channel += 1) {
        if (Math.abs((expected[index + channel] ?? 0) - (actual[index + channel] ?? 0)) > 2) {
          outsideDiffering += 1;
          break;
        }
      }
    }
    // The browser softens the orange/ground edge across the whole width; this
    // backend does not. If `render-canvaskit` is fixed, this drops to zero and
    // the test says so.
    expect(outsideDiffering).toBeGreaterThan(0);
  });

  it("draws nothing outside the bounds that the source picture did not have", () => {
    const withoutPanel: DrawCommand[] = [commands[0] as DrawCommand];
    const plain = cloud.renderFrameToRgba(withoutPanel, { width, height, background });
    const withPanel = Uint8Array.from(
      cloud.renderFrameToRgba(commands, { width, height, background }),
    );
    for (let index = 0; index < plain.length; index += 4) {
      if (inside(index)) continue;
      expect(withPanel[index]).toBe(plain[index]);
      expect(withPanel[index + 3]).toBe(plain[index + 3]);
    }
  });
});
