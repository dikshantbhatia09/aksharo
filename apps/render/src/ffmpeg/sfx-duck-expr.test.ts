import { describe, expect, it } from "vitest";

import {
  buildSfxDuckAudioFilter,
  buildSfxDuckVolumeExpr,
  dbToLinear,
  SFX_DUCK_DB,
  SFX_DUCK_RAMP_MS,
  type SpeechRange,
} from "./sfx-duck-expr.js";

/**
 * A minimal evaluator for the tiny subset of ffmpeg's `libavutil/eval.c`
 * expression language this module emits (`if`, `between`, `min`, `+ - * /`,
 * numeric literals, and the variable `t`) — the same numerical-proof
 * strategy `crop-expr.test.ts` uses for the dynamic crop filter, extended
 * with the two functions this expression needs that the crop one didn't.
 */
function evalExpr(expr: string, t: number): number {
  let i = 0;
  const s = expr;

  function peek(): string {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a bounded internal cursor over a fixed expression string, not attacker-controlled -- reviewed for D04a
    return s[i] ?? "";
  }
  function skip(ch: string): void {
    // eslint-disable-next-line security/detect-object-injection -- same bounded internal cursor as peek() -- reviewed for D04a
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
      if (name === "if") return args[0]! !== 0 ? args[1]! : args[2]!;
      if (name === "min") return Math.min(...args);
      if (name === "between") return args[0]! >= args[1]! && args[0]! <= args[2]! ? 1 : 0;
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

describe("buildSfxDuckVolumeExpr", () => {
  it('is unity ("1") with no speech ranges', () => {
    expect(buildSfxDuckVolumeExpr([])).toBe("1");
  });

  it("is unity far from every speech range", () => {
    const ranges: SpeechRange[] = [{ startMs: 1_000, endMs: 2_000 }];
    const expr = buildSfxDuckVolumeExpr(ranges);
    expect(evalExpr(expr, 10)).toBeCloseTo(1, 6);
  });

  it("reaches the full duck at the centre of a long range", () => {
    const ranges: SpeechRange[] = [{ startMs: 200, endMs: 800 }];
    const expr = buildSfxDuckVolumeExpr(ranges);
    expect(evalExpr(expr, 0.5)).toBeCloseTo(dbToLinear(SFX_DUCK_DB), 5);
  });

  it("is unity exactly rampMs before a range's start", () => {
    const ranges: SpeechRange[] = [{ startMs: 1_000, endMs: 2_000 }];
    const expr = buildSfxDuckVolumeExpr(ranges);
    expect(evalExpr(expr, (1_000 - SFX_DUCK_RAMP_MS) / 1000)).toBeCloseTo(1, 5);
  });

  it("takes the deepest duck across overlapping ranges (min of the trapezoids)", () => {
    const ranges: SpeechRange[] = [
      { startMs: 1_000, endMs: 2_000 },
      { startMs: 1_400, endMs: 1_600 },
    ];
    const expr = buildSfxDuckVolumeExpr(ranges);
    expect(evalExpr(expr, 1.5)).toBeCloseTo(dbToLinear(SFX_DUCK_DB), 5);
  });

  it("matches the browser path's duckGainAt at several sample instants", () => {
    // Same values `apps/web/lib/export/engine.test.ts` exercises against
    // `duckGainAt`, proving both render paths agree (parity, D04a).
    const ranges: SpeechRange[] = [{ startMs: 1_000, endMs: 2_000 }];
    const expr = buildSfxDuckVolumeExpr(ranges);
    const atStart = evalExpr(expr, 1.0);
    const atCentre = evalExpr(expr, 1.5);
    const farBefore = evalExpr(expr, 0.1);
    expect(farBefore).toBeCloseTo(1, 5);
    expect(atCentre).toBeCloseTo(dbToLinear(SFX_DUCK_DB), 5);
    expect(atStart).toBeGreaterThan(atCentre);
    expect(atStart).toBeLessThan(1);
  });
});

describe("buildSfxDuckAudioFilter", () => {
  it("wraps the expression in a volume=eval=frame filter", () => {
    const filter = buildSfxDuckAudioFilter([{ startMs: 1_000, endMs: 2_000 }]);
    expect(filter).toMatch(/^volume=eval=frame:volume='.*'$/);
  });

  it("is exactly \"volume=eval=frame:volume='1'\" with no speech ranges", () => {
    expect(buildSfxDuckAudioFilter([])).toBe("volume=eval=frame:volume='1'");
  });
});
