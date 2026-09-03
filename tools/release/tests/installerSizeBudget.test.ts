import { describe, expect, it } from "vitest";

import {
  checkInstallerSizeBudget,
  INSTALLER_SIZE_BUDGET_BYTES,
  InstallerBudgetExceededError,
} from "../src/commands/buildDesktop.js";

describe("installer size budget (05-system-architecture.md §6-7)", () => {
  it("Windows NSIS budget is 150 MB, macOS DMG budget is 180 MB", () => {
    expect(INSTALLER_SIZE_BUDGET_BYTES.win).toBe(150 * 1024 * 1024);
    expect(INSTALLER_SIZE_BUDGET_BYTES.mac).toBe(180 * 1024 * 1024);
  });

  it("passes silently at or under budget", () => {
    expect(() => checkInstallerSizeBudget("win", INSTALLER_SIZE_BUDGET_BYTES.win)).not.toThrow();
    expect(() => checkInstallerSizeBudget("mac", 1)).not.toThrow();
  });

  it("throws InstallerBudgetExceededError with the offending size and budget over budget", () => {
    const overBudget = INSTALLER_SIZE_BUDGET_BYTES.win + 1;
    expect(() => checkInstallerSizeBudget("win", overBudget)).toThrow(InstallerBudgetExceededError);
    try {
      checkInstallerSizeBudget("win", overBudget);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InstallerBudgetExceededError);
      const budgetError = error as InstallerBudgetExceededError;
      expect(budgetError.platform).toBe("win");
      expect(budgetError.sizeBytes).toBe(overBudget);
      expect(budgetError.budgetBytes).toBe(INSTALLER_SIZE_BUDGET_BYTES.win);
      expect(budgetError.message).toMatch(/over the 150 MB budget/);
    }
  });

  it("mac budget uses its own 180 MB threshold, independent of win", () => {
    const justOverMac = INSTALLER_SIZE_BUDGET_BYTES.mac + 1;
    expect(() => checkInstallerSizeBudget("mac", justOverMac)).toThrow(/180 MB budget/);
    expect(() => checkInstallerSizeBudget("win", justOverMac)).toThrow(/150 MB budget/);
  });
});
