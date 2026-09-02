import { describe, expect, it } from "vitest";

import { toAssTimestamp, toKaraokeCentis } from "./time.js";

describe("toAssTimestamp", () => {
  it("formats zero", () => {
    expect(toAssTimestamp(0)).toBe("0:00:00.00");
  });

  it("formats hours, minutes, seconds and centiseconds", () => {
    // 1h 02m 03.45s
    const ms = ((1 * 60 + 2) * 60 + 3) * 1000 + 450;
    expect(toAssTimestamp(ms)).toBe("1:02:03.45");
  });

  it("floors rather than rounds", () => {
    expect(toAssTimestamp(459)).toBe("0:00:00.45");
  });

  it("clamps negative input to zero", () => {
    expect(toAssTimestamp(-500)).toBe("0:00:00.00");
  });
});

describe("toKaraokeCentis", () => {
  it("converts ms to centiseconds", () => {
    expect(toKaraokeCentis(250)).toBe(25);
  });

  it("floors", () => {
    expect(toKaraokeCentis(24)).toBe(2);
  });

  it("clamps negative durations to zero", () => {
    expect(toKaraokeCentis(-10)).toBe(0);
  });
});
