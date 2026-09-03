import { describe, expect, it } from "vitest";

import {
  anchorPointOf,
  type Box,
  boxContains,
  boxToCss,
  cropRectToBox,
  fitStage,
  positionFromDrag,
  safeZonesFor,
  samePosition,
  toProjectPoint,
} from "./stage-geometry";

const CANVAS = { width: 1080, height: 1920 };

describe("fitStage", () => {
  it("letterboxes a tall canvas into a wide box", () => {
    const fit = fitStage({ width: 1000, height: 600 }, CANVAS);
    expect(fit.height).toBeCloseTo(600, 6);
    expect(fit.width).toBeCloseTo(600 * (1080 / 1920), 6);
    expect(fit.top).toBe(0);
    expect(fit.left).toBeGreaterThan(0);
    expect(fit.scale).toBeCloseTo(600 / 1920, 9);
  });

  it("pillarboxes a wide canvas into a tall box", () => {
    const fit = fitStage({ width: 400, height: 900 }, { width: 1920, height: 1080 });
    expect(fit.width).toBe(400);
    expect(fit.top).toBeGreaterThan(0);
    expect(fit.left).toBe(0);
  });

  it("returns an empty fit for a container that has not been laid out yet", () => {
    expect(fitStage({ width: 0, height: 0 }, CANVAS)).toEqual({
      width: 0,
      height: 0,
      left: 0,
      top: 0,
      scale: 0,
    });
    expect(fitStage({ width: 10, height: 10 }, { width: 0, height: 5 }).scale).toBe(0);
  });
});

describe("toProjectPoint", () => {
  it("maps a client point back into project pixels", () => {
    const fit = fitStage({ width: 540, height: 960 }, CANVAS);
    expect(toProjectPoint({ x: 100, y: 200 }, { x: 0, y: 0 }, fit)).toEqual({ x: 200, y: 400 });
  });

  it("subtracts the element's own origin and the letterbox bar", () => {
    const fit = fitStage({ width: 1000, height: 960 }, CANVAS);
    const point = toProjectPoint({ x: 30 + fit.left + 270, y: 50 + 480 }, { x: 30, y: 50 }, fit);
    expect(point.x).toBeCloseTo(540, 6);
    expect(point.y).toBeCloseTo(960, 6);
  });

  it("answers the origin when the stage has no size", () => {
    expect(
      toProjectPoint(
        { x: 5, y: 5 },
        { x: 0, y: 0 },
        { width: 0, height: 0, left: 0, top: 0, scale: 0 },
      ),
    ).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("anchorPointOf", () => {
  const box: Box = [100, 200, 300, 400];

  it.each([
    ["top-left", 100, 200],
    ["top-center", 200, 200],
    ["top-right", 300, 200],
    ["middle-left", 100, 300],
    ["center", 200, 300],
    ["middle-right", 300, 300],
    ["bottom-left", 100, 400],
    ["bottom-center", 200, 400],
    ["bottom-right", 300, 400],
  ] as const)("%s", (anchor, x, y) => {
    expect(anchorPointOf(box, anchor)).toEqual({ x, y });
  });
});

describe("positionFromDrag", () => {
  const box: Box = [100, 1300, 980, 1500];

  it("moves the anchor by the drag delta", () => {
    const position = positionFromDrag(
      { x: 0, y: -100 },
      { box, canvas: CANVAS, anchor: "bottom-center" },
    );
    expect(position.x).toBeCloseTo(540 / 1080, 4);
    expect(position.y).toBeCloseTo(1400 / 1920, 4);
    expect(position.anchor).toBe("bottom-center");
  });

  it("clamps the box, not the anchor, to the safe area", () => {
    const position = positionFromDrag(
      { x: 0, y: 10_000 },
      { box, canvas: CANVAS, anchor: "bottom-center", safeAreaPct: 12 },
    );
    const margin = (12 / 100) * CANVAS.height;
    // The box's bottom edge stops at the safe margin, so its anchor does too.
    expect(position.y * CANVAS.height).toBeCloseTo(CANVAS.height - margin, 3);
  });

  it("clamps horizontally as well", () => {
    const narrow: Box = [400, 1300, 600, 1400];
    const left = positionFromDrag(
      { x: -10_000, y: 0 },
      { box: narrow, canvas: CANVAS, anchor: "bottom-left", safeAreaPct: 10 },
    );
    // The position is rounded to four decimals, so a fifth of a pixel of slack.
    expect(left.x * CANVAS.width).toBeCloseTo((10 / 100) * CANVAS.height, 1);
  });

  it("never produces a position outside 0…1", () => {
    for (const delta of [-100_000, 100_000]) {
      const position = positionFromDrag(
        { x: delta, y: delta },
        { box, canvas: CANVAS, anchor: "center" },
      );
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x).toBeLessThanOrEqual(1);
      expect(position.y).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeLessThanOrEqual(1);
    }
  });

  it("copes with a caption wider than the safe area rather than inverting the clamp", () => {
    const huge: Box = [0, 0, 2000, 3000];
    const position = positionFromDrag(
      { x: 50, y: 50 },
      { box: huge, canvas: CANVAS, anchor: "top-left", safeAreaPct: 20 },
    );
    expect(Number.isFinite(position.x)).toBe(true);
    expect(position.x).toBeGreaterThanOrEqual(0);
  });

  it("rounds to four decimals so two drops of the same place produce one op", () => {
    const a = positionFromDrag(
      { x: 0.000_001, y: 0 },
      { box, canvas: CANVAS, anchor: "bottom-center" },
    );
    const b = positionFromDrag({ x: 0, y: 0 }, { box, canvas: CANVAS, anchor: "bottom-center" });
    expect(samePosition(a, b)).toBe(true);
  });

  it("treats a NaN delta as no movement rather than crashing", () => {
    const position = positionFromDrag(
      { x: Number.NaN, y: 0 },
      { box, canvas: CANVAS, anchor: "bottom-center" },
    );
    expect(Number.isFinite(position.x)).toBe(true);
  });
});

describe("samePosition", () => {
  it("compares by value and handles absence", () => {
    const position = { x: 0.5, y: 0.8, anchor: "bottom-center" } as const;
    expect(samePosition(position, { ...position })).toBe(true);
    expect(samePosition(position, { ...position, y: 0.81 })).toBe(false);
    expect(samePosition(undefined, undefined)).toBe(true);
    expect(samePosition(position, undefined)).toBe(false);
  });
});

describe("safe zones", () => {
  it("derives every guide from the canvas height", () => {
    const zones = safeZonesFor(CANVAS, 12);
    const margin = (12 / 100) * CANVAS.height;
    expect(zones.safe).toEqual([margin, margin, CANVAS.width - margin, CANVAS.height - margin]);
    expect(zones.top).toEqual([0, 0, CANVAS.width, margin]);
    expect(zones.bottom).toEqual([0, CANVAS.height - margin, CANVAS.width, CANVAS.height]);
  });

  it("collapses to nothing when the style has no safe area", () => {
    expect(safeZonesFor(CANVAS, 0).top).toEqual([0, 0, CANVAS.width, 0]);
  });
});

describe("hit testing and placement", () => {
  const box: Box = [100, 200, 300, 400];

  it("knows what is inside the caption box", () => {
    expect(boxContains(box, { x: 200, y: 300 })).toBe(true);
    expect(boxContains(box, { x: 100, y: 200 })).toBe(true);
    expect(boxContains(box, { x: 99, y: 300 })).toBe(false);
    expect(boxContains(box, { x: 200, y: 401 })).toBe(false);
  });

  it("places the drag handle in CSS pixels", () => {
    const fit = fitStage({ width: 540, height: 960 }, CANVAS);
    expect(boxToCss(box, fit)).toEqual({ left: 50, top: 100, width: 100, height: 100 });
  });
});

describe("cropRectToBox (B20b: the scrub-preview crop-window overlay)", () => {
  it("turns a normalised crop rect into a project-pixel box", () => {
    expect(cropRectToBox({ x: 0.25, y: 0.1, w: 0.5, h: 0.4 }, CANVAS)).toEqual([
      270, 192, 810, 960,
    ]);
  });

  it("the full frame maps to the whole canvas", () => {
    expect(cropRectToBox({ x: 0, y: 0, w: 1, h: 1 }, CANVAS)).toEqual([0, 0, 1080, 1920]);
  });

  it("composes with boxToCss to place the overlay in CSS pixels", () => {
    const fit = fitStage({ width: 540, height: 960 }, CANVAS);
    const projectBox = cropRectToBox({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, CANVAS);
    expect(boxToCss(projectBox, fit)).toEqual({ left: 270, top: 480, width: 135, height: 240 });
  });
});
