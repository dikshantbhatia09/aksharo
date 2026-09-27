import { describe, expect, it } from "vitest";

import { FREE_PLAN_CLIPS_LIMITS, clipsLimitsFor } from "./plan-limits.js";

import type { EntitlementView } from "../workspaces/entitlement.service.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function entitlement(values: Record<string, unknown>, planKey = "studio"): EntitlementView {
  return {
    workspaceId: "01JCWS0000000000000000000A",
    planKey: planKey as EntitlementView["planKey"],
    planName: planKey,
    creditsPerMonthTenths: 0,
    seatsIncluded: 0,
    seatsUsed: 1,
    entitlements: values,
    computedAt: "2026-09-27T00:00:00.000Z",
  };
}

describe("clipsLimitsFor — the minutes a clips run may process (2026-09-27)", () => {
  it("reads the plan's window, ceiling and download size", () => {
    expect(
      clipsLimitsFor(
        entitlement({
          clipsWindowMs: 6 * HOUR,
          maxSourceDurationMs: 12 * HOUR,
          maxFileBytes: 8 * 1024 ** 3,
          maxDurationMs: 6 * HOUR,
        }),
      ),
    ).toEqual({
      clipsWindowMs: 6 * HOUR,
      maxSourceDurationMs: 12 * HOUR,
      maxFileBytes: 8 * 1024 ** 3,
      planKey: "studio",
    });
  });

  it("falls back to the plan's own upload cap before Free's, for an entitlement cached before the keys existed", () => {
    // Studio's seeded window IS its 6-hour upload cap; a 60-second-old cache
    // must not shrink a Studio run to Free's 20 minutes.
    expect(clipsLimitsFor(entitlement({ maxDurationMs: 6 * HOUR })).clipsWindowMs).toBe(6 * HOUR);
  });

  it("falls back to Free, never to unlimited, when nothing usable is there", () => {
    for (const values of [
      {},
      { clipsWindowMs: "lots", maxSourceDurationMs: null, maxDurationMs: -1 },
      { clipsWindowMs: Number.POSITIVE_INFINITY, maxSourceDurationMs: 0 },
    ]) {
      const limits = clipsLimitsFor(entitlement(values, "free"));
      expect(limits.clipsWindowMs, JSON.stringify(values)).toBe(
        FREE_PLAN_CLIPS_LIMITS.clipsWindowMs,
      );
      expect(limits.maxSourceDurationMs, JSON.stringify(values)).toBe(
        FREE_PLAN_CLIPS_LIMITS.maxSourceDurationMs,
      );
      expect(limits.maxFileBytes).toBe(500 * 1024 * 1024);
    }
    expect(FREE_PLAN_CLIPS_LIMITS).toEqual({
      clipsWindowMs: 20 * MINUTE,
      maxSourceDurationMs: 12 * HOUR,
    });
  });

  it("never lets a window exceed the ceiling on what may be looked at", () => {
    expect(
      clipsLimitsFor(entitlement({ clipsWindowMs: 24 * HOUR, maxSourceDurationMs: 12 * HOUR }))
        .clipsWindowMs,
    ).toBe(12 * HOUR);
  });
});
