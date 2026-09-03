import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseTimeMap } from "./serialise.js";
import { buildTimeMap } from "./timemap.js";

import type { CutEdit, Edit, HoldEdit, SpeedEdit } from "./edits.js";
import type { TimeMap } from "./timemap.js";

/**
 * The guarantees from the brief, checked against generated timelines rather than
 * hand-picked ones: monotonicity, inverse consistency on retained source, the
 * duration identity, and `mapRange` covering exactly the retained part of a range.
 */

const SOURCE_MS = 60_000;

/** Disjoint cuts, ordered, inside `[0, SOURCE_MS]`. */
const cutsArbitrary = fc
  .array(fc.tuple(fc.integer({ min: 0, max: SOURCE_MS }), fc.integer({ min: 1, max: 4000 })), {
    maxLength: 12,
  })
  .map((pairs): CutEdit[] =>
    pairs.map(([start, length]) => ({
      kind: "cut",
      startMs: start,
      endMs: Math.min(start + length, SOURCE_MS),
    })),
  );

/** Non-overlapping speed ranges: laid end to end from a list of gaps and lengths. */
const speedsArbitrary = fc
  .array(
    fc.tuple(
      fc.integer({ min: 0, max: 3000 }),
      fc.integer({ min: 1, max: 3000 }),
      fc.constantFrom(0.25, 0.5, 2, 4),
    ),
    { maxLength: 6 },
  )
  .map((triples): SpeedEdit[] => {
    const speeds: SpeedEdit[] = [];
    let cursor = 0;
    for (const [gap, length, factor] of triples) {
      const startMs = cursor + gap;
      const endMs = startMs + length;
      if (endMs > SOURCE_MS) break;
      speeds.push({ kind: "speed", startMs, endMs, factor });
      cursor = endMs;
    }
    return speeds;
  });

const holdsArbitrary = fc
  .array(fc.tuple(fc.integer({ min: 0, max: SOURCE_MS }), fc.integer({ min: 1, max: 2000 })), {
    maxLength: 6,
  })
  .map((pairs): HoldEdit[] =>
    pairs.map(([atMs, durationMs]) => ({ kind: "hold", atMs, durationMs })),
  );

const cutOnlyMap = cutsArbitrary.map((cuts) =>
  buildTimeMap({ sourceDurationMs: SOURCE_MS, edits: cuts }),
);

const fullMap = fc
  .tuple(cutsArbitrary, speedsArbitrary, holdsArbitrary)
  .map(([cuts, speeds, holds]) =>
    buildTimeMap({
      sourceDurationMs: SOURCE_MS,
      edits: [...cuts, ...speeds, ...holds] as Edit[],
    }),
  );

const sourceMs = fc.integer({ min: 0, max: SOURCE_MS });

/**
 * `true` when `ms` sits on material that survived: it lies on a retained span and
 * is not the first instant of a removed range (the half-open rule `[start, end)`).
 * A trailing cut leaves the media's exclusive end on no span at all, so it is out.
 */
function isRetained(map: TimeMap, ms: number): boolean {
  if (map.cuts.some((cut) => cut.startMs <= ms && ms < cut.endMs)) return false;
  return map.spans.some(
    (span) => span.kind === "retained" && span.sourceStart <= ms && ms <= span.sourceEnd,
  );
}

/** Largest speed factor in play; the round trip loses up to half an output ms times this. */
function maxFactor(map: TimeMap): number {
  return map.speeds.reduce((highest, speed) => Math.max(highest, speed.factor), 1);
}

/** Smallest speed factor in play; slow motion spreads one source ms over `1/factor` output ms. */
function minFactor(map: TimeMap): number {
  return map.speeds.reduce((lowest, speed) => Math.min(lowest, speed.factor), 1);
}

describe("monotonicity", () => {
  it("toOutput never goes backwards", () => {
    fc.assert(
      fc.property(fullMap, sourceMs, sourceMs, (map, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const first = map.toOutput(low);
        const second = map.toOutput(high);
        if (first === null || second === null) return true;
        return first <= second;
      }),
      { numRuns: 400 },
    );
  });

  it("toSource never goes backwards", () => {
    fc.assert(
      fc.property(fullMap, fc.integer({ min: 0, max: 4 * SOURCE_MS }), (map, offset) => {
        const first = Math.min(offset, map.outputDurationMs);
        const second = Math.min(offset + 1, map.outputDurationMs);
        return map.toSource(first) <= map.toSource(second);
      }),
      { numRuns: 400 },
    );
  });

  it("the span list is ordered and contiguous on both clocks", () => {
    fc.assert(
      fc.property(fullMap, (map) => {
        let source = 0;
        let output = 0;
        for (const span of map.spans) {
          expect(span.sourceStart).toBe(source);
          expect(span.outputStart).toBe(output);
          expect(span.sourceEnd).toBeGreaterThanOrEqual(span.sourceStart);
          expect(span.outputEnd).toBeGreaterThanOrEqual(span.outputStart);
          source = span.sourceEnd;
          output = span.outputEnd;
        }
        expect(source).toBe(map.spans.length === 0 ? 0 : map.sourceDurationMs);
        expect(output).toBe(map.outputDurationMs);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe("inverse consistency", () => {
  it("toSource(toOutput(s)) === s exactly for retained s when nothing is retimed", () => {
    fc.assert(
      fc.property(cutOnlyMap, sourceMs, (map, ms) => {
        fc.pre(isRetained(map, ms));
        const output = map.toOutput(ms);
        expect(output).not.toBeNull();
        return map.toSource(output as number) === ms;
      }),
      { numRuns: 500 },
    );
  });

  it("toSource(toOutput(s)) stays within the rounding budget when material is retimed", () => {
    // Retiming quantises: at 4x, four source milliseconds share one output
    // millisecond, so the inverse can only land within half an output ms scaled
    // back by the factor. Cuts are excluded here because the last output
    // millisecond before a splice legitimately resolves to the far side of it —
    // that instant shows the post-cut frame. `toOutput ∘ toSource ∘ toOutput`
    // below is the round trip that holds for every map.
    const speedOnly = speedsArbitrary.map((speeds) =>
      buildTimeMap({ sourceDurationMs: SOURCE_MS, edits: speeds }),
    );
    fc.assert(
      fc.property(speedOnly, sourceMs, (map, ms) => {
        const output = map.toOutput(ms);
        expect(output).not.toBeNull();
        const budget = Math.ceil(maxFactor(map) / 2) + 1;
        return Math.abs(map.toSource(output as number) - ms) <= budget;
      }),
      { numRuns: 500 },
    );
  });

  it("the round trip is stable on the output clock for every map", () => {
    fc.assert(
      fc.property(fullMap, sourceMs, (map, ms) => {
        const output = map.toOutput(ms);
        if (output === null) return true;
        return map.toOutput(map.toSource(output)) === output;
      }),
      { numRuns: 500 },
    );
  });

  it("the round trip is stable on the source clock for every map", () => {
    fc.assert(
      fc.property(fullMap, fc.double({ min: 0, max: 1, noNaN: true }), (map, ratio) => {
        const output = Math.round(ratio * map.outputDurationMs);
        const source = map.toSource(output);
        const forward = map.toOutput(source);
        expect(forward).not.toBeNull();
        return map.toSource(forward as number) === source;
      }),
      { numRuns: 500 },
    );
  });

  it("toOutput(toSource(o)) returns to within the rounding budget when nothing is held", () => {
    // A freeze frame is excluded on purpose: it maps a whole output interval back
    // to one source instant, whose forward answer is the *first* output instant it
    // appears at, so the gap there is the hold's own length by design.
    const unheld = fc
      .tuple(cutsArbitrary, speedsArbitrary)
      .map(([cuts, speeds]) =>
        buildTimeMap({ sourceDurationMs: SOURCE_MS, edits: [...cuts, ...speeds] as Edit[] }),
      );
    fc.assert(
      fc.property(unheld, fc.double({ min: 0, max: 1, noNaN: true }), (map, ratio) => {
        const output = Math.round(ratio * map.outputDurationMs);
        const back = map.toOutput(map.toSource(output));
        expect(back).not.toBeNull();
        const budget = Math.ceil(1 / (2 * minFactor(map))) + 1;
        return Math.abs((back as number) - output) <= budget;
      }),
      { numRuns: 500 },
    );
  });
});

describe("duration identity", () => {
  it("output length = source length − Σ cuts + Σ holds when nothing is retimed", () => {
    fc.assert(
      fc.property(fc.tuple(cutsArbitrary, holdsArbitrary), ([cuts, holds]) => {
        const map = buildTimeMap({
          sourceDurationMs: SOURCE_MS,
          edits: [...cuts, ...holds] as Edit[],
        });
        const removed = map.cuts.reduce((total, cut) => total + (cut.endMs - cut.startMs), 0);
        const inserted = map.holds.reduce((total, hold) => total + hold.durationMs, 0);
        return map.outputDurationMs === SOURCE_MS - removed + inserted;
      }),
      { numRuns: 400 },
    );
  });

  it("retiming only moves the total by the exact speed effect, within half a millisecond", () => {
    fc.assert(
      fc.property(fullMap, (map) => {
        const removed = map.cuts.reduce((total, cut) => total + (cut.endMs - cut.startMs), 0);
        const inserted = map.holds.reduce((total, hold) => total + hold.durationMs, 0);
        const retimed = map.speeds.reduce((total, speed) => {
          const length = speed.endMs - speed.startMs;
          return total + length / speed.factor - length;
        }, 0);
        const exact = SOURCE_MS - removed + inserted + retimed;
        return Math.abs(map.outputDurationMs - exact) <= 0.5;
      }),
      { numRuns: 400 },
    );
  });
});

describe("mapRange", () => {
  it("returns ordered, disjoint pieces that cover exactly the retained part of the range", () => {
    fc.assert(
      fc.property(fullMap, sourceMs, sourceMs, (map, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const pieces = map.mapRange(low, high);

        let cursor = low;
        let covered = 0;
        for (const piece of pieces) {
          expect(piece.sourceStart).toBeGreaterThanOrEqual(cursor);
          expect(piece.sourceEnd).toBeGreaterThan(piece.sourceStart);
          expect(piece.outputEnd).toBeGreaterThanOrEqual(piece.outputStart);
          cursor = piece.sourceEnd;
          covered += piece.sourceEnd - piece.sourceStart;
        }
        expect(cursor).toBeLessThanOrEqual(high);

        const removedInside = map.cuts.reduce((total, cut) => {
          const overlap = Math.min(high, cut.endMs) - Math.max(low, cut.startMs);
          return total + Math.max(0, overlap);
        }, 0);
        return covered === high - low - removedInside;
      }),
      { numRuns: 500 },
    );
  });

  it("every piece boundary agrees with toOutput", () => {
    fc.assert(
      fc.property(fullMap, sourceMs, sourceMs, (map, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        for (const piece of map.mapRange(low, high)) {
          expect(map.toOutput(piece.sourceStart)).toBe(piece.outputStart);
          expect(map.toOutput(piece.sourceEnd)).toBe(piece.outputEnd);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe("serialisation", () => {
  it("round-trips to an identical map", () => {
    fc.assert(
      fc.property(fullMap, (map) => {
        const reparsed = parseTimeMap(JSON.parse(JSON.stringify(map.serialize())) as unknown);
        expect(reparsed.serialize()).toEqual(map.serialize());
        expect(reparsed.spans).toEqual(map.spans);
        return reparsed.outputDurationMs === map.outputDurationMs;
      }),
      { numRuns: 300 },
    );
  });
});

describe("normalisation invariants", () => {
  it("leaves cuts disjoint, ordered and non-touching", () => {
    fc.assert(
      fc.property(fullMap, (map) => {
        for (let i = 1; i < map.cuts.length; i += 1) {
          const previous = map.cuts[i - 1] as CutEdit;
          // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
          const current = map.cuts[i] as CutEdit;
          expect(current.startMs).toBeGreaterThan(previous.endMs);
        }
        return map.cuts.every((cut) => cut.endMs > cut.startMs && cut.endMs <= SOURCE_MS);
      }),
      { numRuns: 300 },
    );
  });

  it("never leaves a speed range overlapping a cut", () => {
    fc.assert(
      fc.property(fullMap, (map) => {
        for (const speed of map.speeds) {
          for (const cut of map.cuts) {
            expect(
              Math.min(speed.endMs, cut.endMs) - Math.max(speed.startMs, cut.startMs),
            ).toBeLessThanOrEqual(0);
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
