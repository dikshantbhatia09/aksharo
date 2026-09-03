import { describe, expect, it } from "vitest";

import {
  defaultQualityGateConfig,
  evaluateBoundaryError,
  evaluateLatency,
  evaluateTierMatch,
  evaluateWer,
  overallVerdict,
} from "./thresholds.js";

describe("evaluateBoundaryError", () => {
  it("passes at exactly the 80ms bar", () => {
    expect(evaluateBoundaryError(80).verdict).toBe("pass");
  });

  it("fails just above the bar", () => {
    expect(evaluateBoundaryError(80.1).verdict).toBe("fail");
  });

  it("is not-applicable when there is no figure (mismatched word counts)", () => {
    const result = evaluateBoundaryError(null);
    expect(result.verdict).toBe("not-applicable");
    expect(result.detail).toContain("word counts differ");
  });

  it("respects a custom config", () => {
    const config = { ...defaultQualityGateConfig, maxMedianBoundaryErrorMs: 40 };
    expect(evaluateBoundaryError(50, config).verdict).toBe("fail");
    expect(evaluateBoundaryError(40, config).verdict).toBe("pass");
  });
});

describe("evaluateWer", () => {
  it("passes inside the configured band", () => {
    expect(evaluateWer(0.1).verdict).toBe("pass");
  });

  it("fails above the band's max", () => {
    expect(evaluateWer(0.9).verdict).toBe("fail");
  });

  it("fails below the band's min when the band is narrowed", () => {
    const config = { ...defaultQualityGateConfig, werBand: [0.05, 0.25] as const };
    expect(evaluateWer(0.0, config).verdict).toBe("fail");
  });
});

describe("evaluateLatency", () => {
  it("passes tier A at or under 60s", () => {
    expect(evaluateLatency("A", 60).verdict).toBe("pass");
    expect(evaluateLatency("A", 59.9).verdict).toBe("pass");
  });

  it("fails tier A over 60s", () => {
    expect(evaluateLatency("A", 60.1).verdict).toBe("fail");
  });

  it("passes tier B at 90s and tier C at 120s", () => {
    expect(evaluateLatency("B", 90).verdict).toBe("pass");
    expect(evaluateLatency("C", 120).verdict).toBe("pass");
    expect(evaluateLatency("C", 120.1).verdict).toBe("fail");
  });

  it("is not-applicable for tier D (local engine disabled)", () => {
    const result = evaluateLatency("D", 1);
    expect(result.verdict).toBe("not-applicable");
    expect(result.detail).toContain("local disabled");
  });
});

describe("evaluateTierMatch", () => {
  it("passes when the harness's own detection agrees with /health", () => {
    expect(evaluateTierMatch("B", "B").verdict).toBe("pass");
  });

  it("fails and explains a mismatch", () => {
    const result = evaluateTierMatch("B", "C");
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("harness detected B");
    expect(result.detail).toContain("server reported C");
  });
});

describe("overallVerdict", () => {
  it("is pass when every result is pass or not-applicable, with at least one real pass", () => {
    expect(
      overallVerdict([
        { verdict: "pass", detail: "" },
        { verdict: "not-applicable", detail: "" },
      ]),
    ).toBe("pass");
  });

  it("is fail if any result fails, even if others pass", () => {
    expect(
      overallVerdict([
        { verdict: "pass", detail: "" },
        { verdict: "fail", detail: "" },
      ]),
    ).toBe("fail");
  });

  it("is not-applicable when nothing was actually evaluated", () => {
    expect(overallVerdict([{ verdict: "not-applicable", detail: "" }])).toBe("not-applicable");
  });

  it("is not-applicable for an empty result set", () => {
    expect(overallVerdict([])).toBe("not-applicable");
  });
});
