import { describe, expect, it } from "vitest";

import { computeSfxParity, type SfxDuckCurve } from "./sfx-parity.js";
import {
  buildSfxDuckVolumeExpr,
  dbToLinear,
  SFX_DUCK_DB,
  SFX_DUCK_RAMP_MS,
} from "../src/ffmpeg/sfx-duck-expr.js";

/** A minimal `libavutil/eval.c` evaluator for `if`/`between`/`min`/arithmetic
 * — the same numerical-proof strategy `sfx-duck-expr.test.ts` uses. */
function evalExpr(expr: string, t: number): number {
  let i = 0;
  const s = expr;
  function peek(): string {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a bounded internal cursor over a fixed expression string, not attacker-controlled -- reviewed for D04a
    return s[i] ?? "";
  }
  function skip(ch: string): void {
    // eslint-disable-next-line security/detect-object-injection -- same bounded internal cursor as peek() -- reviewed for D04a
    if (s[i] !== ch) throw new Error(`expected '${ch}'`);
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
  return result;
}

/**
 * A faithful re-implementation of `apps/web/lib/export/engine.ts`'s
 * `duckGainAt` trapezoid, standing in for the browser path since apps do not
 * import one another in this monorepo (only `packages/*` are shared).
 */
function browserDuckGainAt(
  tMs: number,
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
  duckDb = SFX_DUCK_DB,
  rampMs = SFX_DUCK_RAMP_MS,
): number {
  const duckedGain = dbToLinear(duckDb);
  let deepest = 1;
  for (const range of speechRanges) {
    const outerStart = range.startMs - rampMs;
    const outerEnd = range.endMs + rampMs;
    if (tMs < outerStart || tMs > outerEnd) continue;
    const distanceIn = Math.max(0, Math.min(tMs - outerStart, outerEnd - tMs));
    const depth = Math.min(1, distanceIn / (2 * rampMs));
    deepest = Math.min(deepest, 1 + depth * (duckedGain - 1));
  }
  return deepest;
}

describe("computeSfxParity", () => {
  it("matches with no speech ranges (both curves are unity everywhere)", () => {
    const curve: SfxDuckCurve = { gainAt: (t) => browserDuckGainAt(t, []) };
    const result = computeSfxParity({
      speechRanges: [],
      browserCurve: curve,
      evaluateCloudExpr: evalExpr,
      buildCloudExpr: buildSfxDuckVolumeExpr,
    });
    expect(result.match).toBe(true);
  });

  it("matches across a dense sweep of a single speech range", () => {
    const speechRanges = [{ startMs: 1_000, endMs: 2_000 }];
    const curve: SfxDuckCurve = { gainAt: (t) => browserDuckGainAt(t, speechRanges) };
    const result = computeSfxParity({
      speechRanges,
      browserCurve: curve,
      evaluateCloudExpr: evalExpr,
      buildCloudExpr: buildSfxDuckVolumeExpr,
    });
    expect(result.match).toBe(true);
    expect(result.sampleCount).toBeGreaterThan(0);
    expect(result.mismatches).toEqual([]);
  });

  it("matches across overlapping speech ranges", () => {
    const speechRanges = [
      { startMs: 1_000, endMs: 2_000 },
      { startMs: 1_800, endMs: 3_000 },
    ];
    const curve: SfxDuckCurve = { gainAt: (t) => browserDuckGainAt(t, speechRanges) };
    const result = computeSfxParity({
      speechRanges,
      browserCurve: curve,
      evaluateCloudExpr: evalExpr,
      buildCloudExpr: buildSfxDuckVolumeExpr,
    });
    expect(result.match).toBe(true);
  });

  it("reports a mismatch when the two curves disagree", () => {
    const speechRanges = [{ startMs: 1_000, endMs: 2_000 }];
    // A deliberately wrong "browser" curve (always unity) to prove the
    // parity check actually detects drift rather than trivially passing.
    const curve: SfxDuckCurve = { gainAt: () => 1 };
    const result = computeSfxParity({
      speechRanges,
      browserCurve: curve,
      evaluateCloudExpr: evalExpr,
      buildCloudExpr: buildSfxDuckVolumeExpr,
    });
    expect(result.match).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
  });
});
