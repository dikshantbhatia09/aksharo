import { describe, expect, it } from "vitest";

import { CROP_PARITY_FIXTURES } from "./crop-fixtures.js";
import { MAX_DIFF_PX_TOLERANCE, measureAll } from "./run.js";

describe("crop-window parity gate (B20b)", () => {
  it("measures both fixtures within tolerance", () => {
    const output = measureAll("2026-01-01T00:00:00.000Z");
    expect(Object.keys(output.edits).sort()).toEqual(CROP_PARITY_FIXTURES.map((f) => f.id).sort());
    for (const fixture of CROP_PARITY_FIXTURES) {
      const result = output.edits[fixture.id];
      expect(result).toBeDefined();
      expect(result?.pass).toBe(true);
      expect(result?.maxDiffPx).toBeLessThanOrEqual(MAX_DIFF_PX_TOLERANCE);
      expect(result?.samples).toBe(fixture.sampleAtSec.length);
    }
  });

  it("is stable across repeated runs (pure function of the fixtures)", () => {
    const first = measureAll("2026-01-01T00:00:00.000Z");
    const second = measureAll("2026-01-01T00:00:00.000Z");
    expect(first).toEqual(second);
  });
});
