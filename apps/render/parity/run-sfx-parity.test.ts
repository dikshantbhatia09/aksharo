import { describe, expect, it } from "vitest";

import { MAX_DIFF_LINEAR_TOLERANCE, measureAll } from "./run-sfx-parity.js";

const FIXTURE_IDS = ["default-duck", "asymmetric-ramps", "deep-duck-short-ramp"];

describe("sfx-duck parity gate (D04c)", () => {
  it("measures every fixture within tolerance", () => {
    const output = measureAll("2026-01-01T00:00:00.000Z");
    expect(Object.keys(output.fixtures).sort()).toEqual([...FIXTURE_IDS].sort());
    for (const id of FIXTURE_IDS) {
      // eslint-disable-next-line security/detect-object-injection -- `id` comes from the fixed FIXTURE_IDS list above, not attacker input -- reviewed for D04c
      const result = output.fixtures[id];
      expect(result).toBeDefined();
      expect(result?.pass).toBe(true);
      expect(result?.maxDiffLinear).toBeLessThanOrEqual(MAX_DIFF_LINEAR_TOLERANCE);
      expect(result?.samples).toBeGreaterThan(0);
    }
  });

  it("is stable across repeated runs (pure function of the fixtures)", () => {
    const first = measureAll("2026-01-01T00:00:00.000Z");
    const second = measureAll("2026-01-01T00:00:00.000Z");
    expect(first).toEqual(second);
  });
});
