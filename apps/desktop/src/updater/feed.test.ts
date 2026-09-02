import { describe, expect, it } from "vitest";

import { feedUrl, isEligibleForRollout, isUpdateChannel } from "./feed.js";

describe("isUpdateChannel", () => {
  it("accepts the three known channels", () => {
    expect(isUpdateChannel("alpha")).toBe(true);
    expect(isUpdateChannel("beta")).toBe(true);
    expect(isUpdateChannel("stable")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUpdateChannel("nightly")).toBe(false);
    expect(isUpdateChannel("")).toBe(false);
  });
});

describe("feedUrl", () => {
  it("builds the C00 releases layout per channel", () => {
    expect(feedUrl("stable")).toMatch(/^https:\/\/releases\..+\/releases\/stable\/$/);
    expect(feedUrl("alpha")).toContain("/releases/alpha/");
  });
});

describe("isEligibleForRollout", () => {
  it("is eligible with no rollout percentage set", () => {
    expect(isEligibleForRollout("install-1", {})).toBe(true);
  });

  it("is eligible at 100%", () => {
    expect(isEligibleForRollout("install-1", { stagedRolloutPercentage: 100 })).toBe(true);
  });

  it("is never eligible at 0%", () => {
    for (const id of ["a", "b", "c", "d"]) {
      expect(isEligibleForRollout(id, { stagedRolloutPercentage: 0 })).toBe(false);
    }
  });

  it("is deterministic for the same install id", () => {
    const meta = { stagedRolloutPercentage: 50 };
    const first = isEligibleForRollout("stable-install-id", meta);
    for (let i = 0; i < 5; i++) {
      expect(isEligibleForRollout("stable-install-id", meta)).toBe(first);
    }
  });

  it("splits a population roughly at the percentage over many ids", () => {
    let eligible = 0;
    const total = 2000;
    for (let i = 0; i < total; i++) {
      if (isEligibleForRollout(`install-${i}`, { stagedRolloutPercentage: 30 })) eligible++;
    }
    const ratio = eligible / total;
    expect(ratio).toBeGreaterThan(0.22);
    expect(ratio).toBeLessThan(0.38);
  });
});
