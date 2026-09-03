import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { alignCutBoundariesToBeats, DEFAULT_BEAT_SNAP_TOLERANCE_MS } from "./beats.js";

/**
 * Property test (brief §6: "beat-aligned cuts ... never crossing a protected
 * range"): whatever cuts, bpm, anchor and protected ranges fast-check throws
 * at `alignCutBoundariesToBeats`, every adjustment it emits must satisfy two
 * invariants that no hand-picked example set can fully cover — it never
 * lands inside a protected range, and it never moves a boundary further than
 * the configured tolerance.
 */

const boundaryArbitrary = fc.record({
  itemId: fc.string({ minLength: 1, maxLength: 8 }),
  startMs: fc.integer({ min: 0, max: 60_000 }),
  endMs: fc.integer({ min: 0, max: 60_000 }),
});

const protectedRangeArbitrary = fc
  .tuple(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 1, max: 2_000 }))
  .map(([start, length]): [number, number] => [start, start + length]);

describe("alignCutBoundariesToBeats — properties", () => {
  it("never emits an adjustment landing inside a protected range", () => {
    fc.assert(
      fc.property(
        fc.array(boundaryArbitrary, { maxLength: 20 }),
        fc.integer({ min: 40, max: 220 }), // plausible bpm range
        fc.integer({ min: 0, max: 2_000 }), // anchor phase
        fc.array(protectedRangeArbitrary, { maxLength: 10 }),
        (cuts, bpm, anchorMs, protectedRanges) => {
          const adjustments = alignCutBoundariesToBeats(cuts, { bpm, anchorMs, protectedRanges });
          for (const adjustment of adjustments) {
            for (const [start, end] of protectedRanges) {
              expect(adjustment.toMs > start && adjustment.toMs < end).toBe(false);
            }
          }
        },
      ),
    );
  });

  it("never moves a boundary further than the configured tolerance", () => {
    fc.assert(
      fc.property(
        fc.array(boundaryArbitrary, { maxLength: 20 }),
        fc.integer({ min: 40, max: 220 }),
        fc.integer({ min: 1, max: 300 }),
        (cuts, bpm, toleranceMs) => {
          const adjustments = alignCutBoundariesToBeats(cuts, { bpm, toleranceMs });
          for (const adjustment of adjustments) {
            expect(Math.abs(adjustment.toMs - adjustment.fromMs)).toBeLessThanOrEqual(toleranceMs);
          }
        },
      ),
    );
  });

  it("every adjustment lands exactly on the beat grid", () => {
    fc.assert(
      fc.property(
        fc.array(boundaryArbitrary, { maxLength: 20 }),
        fc.integer({ min: 40, max: 220 }),
        fc.integer({ min: 0, max: 2_000 }),
        (cuts, bpm, anchorMs) => {
          const adjustments = alignCutBoundariesToBeats(cuts, { bpm, anchorMs });
          const intervalMs = 60_000 / bpm;
          for (const adjustment of adjustments) {
            const beatsFromAnchor = (adjustment.toMs - anchorMs) / intervalMs;
            expect(Math.abs(beatsFromAnchor - Math.round(beatsFromAnchor))).toBeLessThan(1e-6);
          }
        },
      ),
    );
  });

  it("defaults to the brief's ±120ms tolerance when none is given", () => {
    fc.assert(
      fc.property(fc.array(boundaryArbitrary, { maxLength: 20 }), fc.integer({ min: 40, max: 220 }), (cuts, bpm) => {
        const adjustments = alignCutBoundariesToBeats(cuts, { bpm });
        for (const adjustment of adjustments) {
          expect(Math.abs(adjustment.toMs - adjustment.fromMs)).toBeLessThanOrEqual(
            DEFAULT_BEAT_SNAP_TOLERANCE_MS,
          );
        }
      }),
    );
  });
});
