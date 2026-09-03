import { describe, expect, it } from "vitest";

import type { CropKeyframe } from "@montaj/render-core";

import { buildDynamicCropFilter } from "./crop-expr.js";

/**
 * A minimal evaluator for the tiny subset of ffmpeg's `libavutil/eval.c`
 * expression language this module emits (`if`, `lt`, `+ - * /`, numeric
 * literals, and the variable `t`) — just enough to numerically prove the
 * generated strings behave the way `sampleCropWindow` (the browser path's
 * equivalent) does, without needing to shell out to a real ffmpeg binary in
 * a unit test.
 */
function evalExpr(expr: string, t: number): number {
  let i = 0;
  const s = expr;

  function peek(): string {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    return s[i] ?? "";
  }
  function skip(ch: string): void {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if (s[i] !== ch) throw new Error(`expected '${ch}' at ${String(i)} in ${expr}`);
    i += 1;
  }
  function parseArgs(): number[] {
    skip("(");
    const args: number[] = [parseExpr()];
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
      if (name === "lt") return args[0]! < args[1]! ? 1 : 0;
      if (name === "if") return args[0]! !== 0 ? args[1]! : args[2]!;
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
  const result = parseExpr();
  if (i !== s.length) throw new Error(`trailing input at ${String(i)} in ${expr}: ${s.slice(i)}`);
  return result;
}

function extractField(filter: string, field: "w" | "h" | "x" | "y"): string {
  // eslint-disable-next-line security/detect-non-literal-regexp -- RegExp built from a fixed/internal string (test fixture or bounded value, not attacker input) -- reviewed for M06's eslint-plugin-security promotion
  const match = new RegExp(`${field}='([^']*)'`).exec(filter);
  if (match === null) throw new Error(`no ${field} field in ${filter}`);
  return match[1]!;
}

describe("buildDynamicCropFilter", () => {
  it("returns null with no keyframes", () => {
    expect(buildDynamicCropFilter([], 1080, 1920)).toBeNull();
  });

  it("holds a single keyframe's rect for every t", () => {
    const kf: CropKeyframe[] = [{ tMs: 500, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } }];
    const filter = buildDynamicCropFilter(kf, 1000, 2000)!;
    expect(evalExpr(extractField(filter, "x"), 0)).toBeCloseTo(100, 5);
    expect(evalExpr(extractField(filter, "x"), 999)).toBeCloseTo(100, 5);
    expect(evalExpr(extractField(filter, "h"), 3)).toBeCloseTo(1200, 5);
  });

  it("linearly interpolates between two keyframes, matching sampleCropWindow", () => {
    const kf: CropKeyframe[] = [
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { tMs: 2000, rect: { x: 0.2, y: 0.4, w: 0.6, h: 0.6 } },
    ];
    const filter = buildDynamicCropFilter(kf, 1000, 1000)!;
    const wExpr = extractField(filter, "w");
    expect(evalExpr(wExpr, 0)).toBeCloseTo(1000, 5);
    expect(evalExpr(wExpr, 1)).toBeCloseTo(800, 5); // halfway: 1000 -> 600
    expect(evalExpr(wExpr, 2)).toBeCloseTo(600, 5);
    // After the last keyframe, holds.
    expect(evalExpr(wExpr, 10)).toBeCloseTo(600, 5);
  });

  it("chains three keyframes correctly, each segment independent", () => {
    const kf: CropKeyframe[] = [
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { tMs: 1000, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      { tMs: 2000, rect: { x: 0, y: 0, w: 1, h: 1 } },
    ];
    const filter = buildDynamicCropFilter(kf, 1000, 1000)!;
    const xExpr = extractField(filter, "x");
    expect(evalExpr(xExpr, 0)).toBeCloseTo(0, 5);
    expect(evalExpr(xExpr, 0.5)).toBeCloseTo(250, 5);
    expect(evalExpr(xExpr, 1)).toBeCloseTo(500, 5);
    expect(evalExpr(xExpr, 1.5)).toBeCloseTo(250, 5);
    expect(evalExpr(xExpr, 2)).toBeCloseTo(0, 5);
  });
});
