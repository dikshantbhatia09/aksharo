import { describe, expect, it } from "vitest";

import {
  createFallbackSnapshot,
  isStatusUnknown,
  STALE_THRESHOLD_MS,
  type StatusSnapshot,
} from "./status-data";

describe("status unknown state and freshness rules", () => {
  const now = new Date("2026-09-19T12:00:00.000Z").getTime();

  it("treats fallback snapshot as unknown", () => {
    const fallback = createFallbackSnapshot();
    expect(fallback.components).toHaveLength(0);
    expect(fallback.generatedAt).toBe("unknown");
    expect(isStatusUnknown(fallback, now)).toBe(true);
  });

  it("treats empty components array as unknown even if generatedAt is fresh", () => {
    const freshEmpty: StatusSnapshot = {
      generatedAt: new Date(now).toISOString(),
      overall: "operational",
      components: [],
      incidents: [],
    };
    expect(isStatusUnknown(freshEmpty, now)).toBe(true);
  });

  it("treats generatedAt='unknown' as unknown", () => {
    const unknownTime: StatusSnapshot = {
      generatedAt: "unknown",
      overall: "operational",
      components: [{ id: "api", label: "API", status: "operational" }],
      incidents: [],
    };
    expect(isStatusUnknown(unknownTime, now)).toBe(true);
  });

  it("treats snapshot older than 15 minutes as unknown/stale", () => {
    const sixteenMinutesAgo = new Date(now - 16 * 60 * 1000).toISOString();
    const staleSnapshot: StatusSnapshot = {
      generatedAt: sixteenMinutesAgo,
      overall: "operational",
      components: [{ id: "api", label: "API", status: "operational" }],
      incidents: [],
    };
    expect(isStatusUnknown(staleSnapshot, now)).toBe(true);
  });

  it("treats fresh snapshot with components as known/available", () => {
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString();
    const freshSnapshot: StatusSnapshot = {
      generatedAt: fiveMinutesAgo,
      overall: "operational",
      components: [{ id: "api", label: "API", status: "operational" }],
      incidents: [],
    };
    expect(isStatusUnknown(freshSnapshot, now)).toBe(false);
  });

  it("STALE_THRESHOLD_MS is exactly 15 minutes", () => {
    expect(STALE_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });
});
