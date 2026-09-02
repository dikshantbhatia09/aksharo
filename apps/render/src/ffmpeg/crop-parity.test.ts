/**
 * B20 §4/§6/§7's "parity gate extension", scoped to what B20 actually
 * introduced.
 *
 * A18a's parity gate (`packages/ass-exporter/parity/run.ts`) measures caption
 * *style* rendering fidelity (canvas-vs-Skia, ass-vs-Skia) over
 * `CAPTION_FIXTURES` — text/style fixtures, not edited timelines. It has no
 * axis for "a cut/zoom was applied" to extend with a fixture: nothing about
 * an accepted cut or a zoom window changes which pixels a caption's glyphs
 * occupy. Reported as a brief/architecture mismatch in the B20 final report
 * rather than forced in there.
 *
 * What B20 actually needs proven is that its *two* independent
 * implementations of "sample the zoom/reframe crop window at an output
 * instant" — the browser exporter's `sampleCropWindow` (`@montaj/render-
 * core`, evaluated in TypeScript against every frame) and the cloud
 * renderer's `buildDynamicCropFilter` (`crop-expr.ts`, evaluated by ffmpeg's
 * own expression language) — agree. A silent drift between them is exactly
 * the "browser export and cloud export disagree" failure mode D33 exists to
 * catch for captions; this is the same check for B20's crop window.
 *
 * Two fixtures, as the brief asked for: one with a cut *and* a zoom, one
 * with a cut *and* a reframe (reframe's crop window is the same `CropRect`
 * shape as zoom's after `cropRectFromCentre`/`cropRectFromZoom`, so both
 * exercise the same code path — the fixtures differ in the curve shape, not
 * in which function runs).
 */
import { describe, expect, it } from "vitest";

import { sampleCropWindow, type CropKeyframe } from "@montaj/render-core";

import { buildDynamicCropFilter } from "./crop-expr.js";

/** Evaluates the tiny ffmpeg expression subset `crop-expr.ts` emits — see `crop-expr.test.ts` for the grammar this covers. */
function evalExpr(expr: string, t: number): number {
  let i = 0;
  function peek(): string {
    return expr[i] ?? "";
  }
  function skip(ch: string): void {
    if (expr[i] !== ch) throw new Error(`expected '${ch}' at ${String(i)}`);
    i += 1;
  }
  function parseArgs(): number[] {
    skip("(");
    const args = [parseExpr()];
    while (peek() === ",") {
      i += 1;
      args.push(parseExpr());
    }
    skip(")");
    return args;
  }
  function parseAtom(): number {
    if (peek() === "(") {
      i += 1;
      const v = parseExpr();
      skip(")");
      return v;
    }
    if (/[a-z]/i.test(peek())) {
      let name = "";
      while (/[a-z]/i.test(peek())) {
        name += peek();
        i += 1;
      }
      if (name === "t") return t;
      const args = parseArgs();
      if (name === "lt") return (args[0] ?? 0) < (args[1] ?? 0) ? 1 : 0;
      if (name === "if") return (args[0] ?? 0) !== 0 ? (args[1] ?? 0) : (args[2] ?? 0);
      throw new Error(`unknown fn ${name}`);
    }
    let sign = 1;
    if (peek() === "-") {
      sign = -1;
      i += 1;
    }
    let num = "";
    while (/[0-9.]/.test(peek())) {
      num += peek();
      i += 1;
    }
    return sign * Number(num);
  }
  function parseTerm(): number {
    let v = parseAtom();
    for (;;) {
      if (peek() === "*") {
        i += 1;
        v *= parseAtom();
      } else if (peek() === "/") {
        i += 1;
        v /= parseAtom();
      } else break;
    }
    return v;
  }
  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      if (peek() === "+") {
        i += 1;
        v += parseTerm();
      } else if (peek() === "-") {
        i += 1;
        v -= parseTerm();
      } else break;
    }
    return v;
  }
  return parseExpr();
}

function extractField(filter: string, field: "w" | "h" | "x" | "y"): string {
  const match = new RegExp(`${field}='([^']*)'`).exec(filter);
  if (match === null) throw new Error(`no ${field} in ${filter}`);
  return match[1] ?? "";
}

/** Cloud (ffmpeg expr) crop rect, in pixels, at output second `tSec`. */
function cloudRectPx(
  keyframes: readonly CropKeyframe[],
  sourceWidth: number,
  sourceHeight: number,
  tSec: number,
): { x: number; y: number; w: number; h: number } {
  const filter = buildDynamicCropFilter(keyframes, sourceWidth, sourceHeight);
  if (filter === null) throw new Error("expected a crop filter for this fixture");
  return {
    x: evalExpr(extractField(filter, "x"), tSec),
    y: evalExpr(extractField(filter, "y"), tSec),
    w: evalExpr(extractField(filter, "w"), tSec),
    h: evalExpr(extractField(filter, "h"), tSec),
  };
}

/** Browser (`sampleCropWindow`) crop rect, in the same pixel space, at output second `tSec`. */
function browserRectPx(
  keyframes: readonly CropKeyframe[],
  sourceWidth: number,
  sourceHeight: number,
  tSec: number,
): { x: number; y: number; w: number; h: number } {
  const rect = sampleCropWindow(keyframes, tSec * 1000);
  if (rect === null) throw new Error("expected a crop window for this fixture");
  return {
    x: rect.x * sourceWidth,
    y: rect.y * sourceHeight,
    w: rect.w * sourceWidth,
    h: rect.h * sourceHeight,
  };
}

function expectRectsClose(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  tolerancePx = 0.05,
): void {
  expect(a.x).toBeCloseTo(b.x, 0);
  expect(a.y).toBeCloseTo(b.y, 0);
  expect(a.w).toBeCloseTo(b.w, 0);
  expect(a.h).toBeCloseTo(b.h, 0);
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tolerancePx + 1);
}

const SOURCE_WIDTH = 1080;
const SOURCE_HEIGHT = 1920;

describe("crop-window parity: browser (sampleCropWindow) vs cloud (buildDynamicCropFilter)", () => {
  it("fixture A — a cut plus a zoom-in: agrees at the start, midpoint and end of the ramp", () => {
    // A 3s clip with a [1000,1500)ms cut already applied upstream (this
    // fixture's keyframes are already on the output clock, as
    // outputCropKeyframesFromTracks hands both backends): zoom holds full
    // frame, then punches in on a subject over 1s.
    const keyframes: CropKeyframe[] = [
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, easing: "linear" },
      { tMs: 1_000, rect: { x: 0.3, y: 0.35, w: 0.4, h: 0.4 } },
    ];
    for (const tSec of [0, 0.25, 0.5, 0.75, 1, 2]) {
      const browser = browserRectPx(keyframes, SOURCE_WIDTH, SOURCE_HEIGHT, tSec);
      const cloud = cloudRectPx(keyframes, SOURCE_WIDTH, SOURCE_HEIGHT, tSec);
      expectRectsClose(browser, cloud);
    }
  });

  it("fixture B — a cut plus a reframe: agrees across a three-keyframe crop-window walk", () => {
    // A reframe item's crop window (already the same CropRect shape as a
    // zoom's, per cropRectFromCentre) sweeping left to right across the
    // frame — three keyframes, two ramp segments.
    const keyframes: CropKeyframe[] = [
      { tMs: 0, rect: { x: 0, y: 0.1, w: 0.5, h: 0.8 }, easing: "linear" },
      { tMs: 1_500, rect: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 }, easing: "linear" },
      { tMs: 3_000, rect: { x: 0.5, y: 0.1, w: 0.5, h: 0.8 } },
    ];
    for (const tSec of [0, 0.5, 1, 1.5, 2, 2.5, 3, 4]) {
      const browser = browserRectPx(keyframes, SOURCE_WIDTH, SOURCE_HEIGHT, tSec);
      const cloud = cloudRectPx(keyframes, SOURCE_WIDTH, SOURCE_HEIGHT, tSec);
      expectRectsClose(browser, cloud);
    }
  });
});
