import { describe, expect, it } from "vitest";

import { createLocalModeGate } from "./entitlement-gate.js";

describe("createLocalModeGate", () => {
  it("fails closed until a plan is reported", () => {
    const gate = createLocalModeGate();
    expect(gate.currentPlan()).toBeNull();
    expect(gate.isEnabled()).toBe(false);
  });

  it("stays disabled on Free", () => {
    const gate = createLocalModeGate();
    gate.setPlan("free");
    expect(gate.isEnabled()).toBe(false);
  });

  it("enables on Starter and above", () => {
    for (const plan of ["starter", "creator", "studio", "agency"] as const) {
      const gate = createLocalModeGate();
      gate.setPlan(plan);
      expect(gate.isEnabled()).toBe(true);
    }
  });

  it("accepts an initial plan", () => {
    expect(createLocalModeGate("agency").isEnabled()).toBe(true);
    expect(createLocalModeGate("free").isEnabled()).toBe(false);
  });
});
