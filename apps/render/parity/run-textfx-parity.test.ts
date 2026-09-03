import { describe, expect, it } from "vitest";

import { measureAll, TEXTFX_MAX_DIFF_RATIO } from "./run-textfx-parity.js";
import { TEXTFX_PRESET_FIXTURES } from "./textfx-fixtures.js";

describe("text-fx parity gate (D06b)", () => {
  it("measures every preset within tolerance", async () => {
    const output = await measureAll("2026-01-01T00:00:00.000Z");
    expect(Object.keys(output.presets).sort()).toEqual(
      TEXTFX_PRESET_FIXTURES.map((f) => f.preset).sort(),
    );
    for (const fixture of TEXTFX_PRESET_FIXTURES) {
      const result = output.presets[fixture.preset];
      expect(result).toBeDefined();
      expect(result?.maxDiffRatio).toBeLessThanOrEqual(TEXTFX_MAX_DIFF_RATIO);
      expect(result?.pass).toBe(true);
    }
  }, 60_000);
});
