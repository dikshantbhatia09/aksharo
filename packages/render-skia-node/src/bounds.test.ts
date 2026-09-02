/**
 * The bounding boxes the layer surfaces are sized from.
 *
 * Every assertion here is really the same one: a box may be **too big**, which
 * only costs time, but never too small, which would clip the picture. So the
 * tests check that geometry is contained rather than that a number is exact.
 */

import { describe, expect, it } from "vitest";

import {
  BLUR_SIGMA_MARGIN,
  deviceBounds,
  hasContainers,
  IDENTITY,
  inflate,
  intersect,
  multiply,
  offset,
  snapToSurface,
  union,
  type Box,
} from "./bounds.js";

import type { DrawCommand } from "@montaj/render-core";

const SQUARE: DrawCommand = {
  kind: "rect",
  rect: [20, 30, 60, 80],
  fill: { paint: { type: "solid", color: "#ffffffff" } },
};

function contains(outer: Box | null, inner: Box): boolean {
  if (outer === null) return false;
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
}

describe("box arithmetic", () => {
  it("multiplies matrices in draw order", () => {
    // A translate then a scale is not a scale then a translate.
    const translate = [1, 0, 0, 1, 10, 20] as const;
    const scale = [2, 0, 0, 2, 0, 0] as const;
    expect(multiply(translate, scale)).toEqual([2, 0, 0, 2, 10, 20]);
    expect(multiply(scale, translate)).toEqual([2, 0, 0, 2, 20, 40]);
    expect(multiply(IDENTITY, scale)).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("offsets, inflates, unions and intersects", () => {
    const box: Box = { left: 10, top: 10, right: 20, bottom: 20 };
    expect(offset(box, 5, -5)).toEqual({ left: 15, top: 5, right: 25, bottom: 15 });
    expect(inflate(box, 2)).toEqual({ left: 8, top: 8, right: 22, bottom: 22 });
    expect(union(box, { left: 0, top: 0, right: 5, bottom: 5 })).toEqual({
      left: 0,
      top: 0,
      right: 20,
      bottom: 20,
    });
    expect(union(null, box)).toEqual(box);
    expect(union(box, null)).toEqual(box);
    expect(union(null, null)).toBeNull();
    expect(intersect(box, { left: 15, top: 15, right: 30, bottom: 30 })).toEqual({
      left: 15,
      top: 15,
      right: 20,
      bottom: 20,
    });
    expect(intersect(box, { left: 30, top: 30, right: 40, bottom: 40 })).toBeNull();
    expect(intersect(null, box)).toBeNull();
    expect(intersect(box, null)).toBeNull();
  });

  it("snaps outwards, never inwards, and clamps to the surface", () => {
    // Rounding inwards would clip the edge pixel the anti-aliasing lives in —
    // exactly the pixel the parity gate measures.
    expect(snapToSurface({ left: 10.4, top: 10.6, right: 20.1, bottom: 20.9 }, 100, 100)).toEqual({
      left: 10,
      top: 10,
      right: 21,
      bottom: 21,
    });
    expect(snapToSurface({ left: -50, top: -50, right: 500, bottom: 500 }, 100, 100)).toEqual({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
    });
    expect(snapToSurface({ left: -20, top: -20, right: -5, bottom: -5 }, 100, 100)).toBeNull();
    expect(snapToSurface(null, 100, 100)).toBeNull();
  });
});

describe("deviceBounds", () => {
  it("is null for a list that draws nothing", () => {
    expect(deviceBounds([])).toBeNull();
    expect(deviceBounds([{ kind: "group", children: [] }])).toBeNull();
  });

  it("bounds a rectangle", () => {
    expect(deviceBounds([SQUARE])).toEqual({ left: 20, top: 30, right: 60, bottom: 80 });
  });

  it("pads a stroked shape by its whole width, so a mitre cannot poke out", () => {
    const box = deviceBounds([
      {
        ...SQUARE,
        stroke: {
          paint: { type: "solid", color: "#000000ff" },
          widthPx: 8,
          join: "miter",
          cap: "butt",
        },
      },
    ]);
    expect(box).toEqual({ left: 12, top: 22, right: 68, bottom: 88 });
  });

  it("bounds a round rectangle and an image by their rectangles", () => {
    expect(
      deviceBounds([
        { kind: "roundRect", rect: [0, 0, 10, 10], radiusX: 4, radiusY: 4 },
        { kind: "image", assetId: "x", dest: [5, 5, 30, 40] },
      ]),
    ).toEqual({ left: 0, top: 0, right: 30, bottom: 40 });
  });

  it("bounds a path by its control points, which contain its curves", () => {
    const box = deviceBounds([{ kind: "path", d: "M0 0Q50 100 100 0Z" }]);
    // The curve peaks at y = 50, well inside the control point's y = 100.
    expect(contains(box, { left: 0, top: 0, right: 100, bottom: 50 })).toBe(true);
  });

  it("survives a path with no numbers in it", () => {
    expect(deviceBounds([{ kind: "path", d: "Z" }])).toBeNull();
  });

  it("bounds a glyph run by its positions plus an em, in case it is not outlined", () => {
    const box = deviceBounds([
      {
        kind: "text",
        run: {
          fontId: "f",
          fontSizePx: 40,
          glyphs: [1, 2],
          positions: [100, 200, 140, 200],
          clusters: [0, 1],
          text: "ab",
        },
      },
    ]);
    expect(contains(box, { left: 100, top: 200, right: 140, bottom: 200 })).toBe(true);
    expect(box?.left).toBe(60);
    expect(box?.bottom).toBe(240);
  });

  it("applies a transform, including a rotation, to all four corners", () => {
    const rotated = deviceBounds([
      // 45°: cos = sin ≈ 0.7071.
      { kind: "transform", matrix: [0.7071, 0.7071, -0.7071, 0.7071, 0, 0], children: [SQUARE] },
    ]);
    // An axis-aligned box round a rotated rectangle is wider than the original.
    expect((rotated?.right ?? 0) - (rotated?.left ?? 0)).toBeGreaterThan(40);
  });

  it("shrinks to a rectangular clip, but not to a path clip", () => {
    const clipped = deviceBounds([
      {
        kind: "clip",
        antiAlias: true,
        shape: { type: "rect", rect: [30, 40, 50, 60] },
        children: [SQUARE],
      },
    ]);
    expect(clipped).toEqual({ left: 30, top: 40, right: 50, bottom: 60 });

    // A path clip only ever shrinks what the children cover, so their own box
    // is still a correct outer bound.
    const pathClipped = deviceBounds([
      {
        kind: "clip",
        antiAlias: true,
        shape: { type: "path", d: "M0 0L5 0L5 5Z" },
        children: [SQUARE],
      },
    ]);
    expect(pathClipped).toEqual({ left: 20, top: 30, right: 60, bottom: 80 });
  });

  it("is null when a clip and its children do not meet", () => {
    expect(
      deviceBounds([
        {
          kind: "clip",
          antiAlias: true,
          shape: { type: "rect", rect: [500, 500, 600, 600] },
          children: [SQUARE],
        },
      ]),
    ).toBeNull();
  });

  it("covers both the children and the shadow they cast", () => {
    const box = deviceBounds([
      { kind: "shadow", dx: 10, dy: 20, sigma: 4, color: "#000000ff", children: [SQUARE] },
    ]);
    expect(contains(box, { left: 20, top: 30, right: 60, bottom: 80 })).toBe(true);
    // The offset silhouette, blurred by three sigmas.
    expect(box?.right).toBeCloseTo(60 + 10 + 4 * BLUR_SIGMA_MARGIN, 5);
    expect(box?.bottom).toBeCloseTo(80 + 20 + 4 * BLUR_SIGMA_MARGIN, 5);
  });

  it("is null for a shadow around nothing", () => {
    expect(
      deviceBounds([{ kind: "shadow", dx: 1, dy: 1, sigma: 1, color: "#000", children: [] }]),
    ).toBeNull();
  });

  it("inflates a blur by three sigmas", () => {
    const box = deviceBounds([{ kind: "blur", sigmaX: 5, sigmaY: 2, children: [SQUARE] }]);
    expect(box?.left).toBe(20 - 5 * BLUR_SIGMA_MARGIN);
  });

  it("takes a backdrop blur's own bounds, whatever its children cover", () => {
    const box = deviceBounds([
      {
        kind: "blur",
        sigmaX: 3,
        sigmaY: 3,
        backdrop: true,
        bounds: [0, 0, 200, 200],
        children: [SQUARE],
      },
    ]);
    expect(box).toEqual({ left: 0, top: 0, right: 200, bottom: 200 });
  });

  it("falls back to the children when a backdrop blur names no bounds", () => {
    const box = deviceBounds([
      { kind: "blur", sigmaX: 3, sigmaY: 3, backdrop: true, children: [SQUARE] },
    ]);
    expect(box).toEqual({ left: 20, top: 30, right: 60, bottom: 80 });
  });

  it("unions a whole caption's worth of nesting", () => {
    const box = deviceBounds([
      {
        kind: "group",
        opacity: 0.5,
        children: [SQUARE, { kind: "transform", matrix: [1, 0, 0, 1, 200, 0], children: [SQUARE] }],
      },
    ]);
    expect(box).toEqual({ left: 20, top: 30, right: 260, bottom: 80 });
  });
});

describe("hasContainers", () => {
  it("says whether a list nests at all", () => {
    expect(hasContainers([SQUARE])).toBe(false);
    expect(hasContainers([{ kind: "group", children: [SQUARE] }])).toBe(true);
  });
});
