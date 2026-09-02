import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StreakView } from "@montaj/api-client";

import { StreakChip } from "./streak-chip";

import { renderWithProviders } from "@/test/harness";

const BASE: StreakView = {
  eligible: true,
  holdout: false,
  creditsOnly: false,
  level: 2,
  publishDaysThisWeek: 3,
  bar: 3,
  paused: false,
  freezesRemaining: 2,
  consecutiveWeeks: 1,
  weekWindowStart: "2027-01-04",
  weekWindowEnd: "2027-01-11",
  nextRewardLabel: null,
  discountPercent: 5,
  creditGrantTenths: 0,
};

describe("<StreakChip />", () => {
  it("renders nothing when the flag is off, regardless of the API response", async () => {
    const { container } = renderWithProviders(<StreakChip />, {
      routes: { "/streak": BASE },
      config: { flags: {} },
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="streak-chip"]')).toBeNull();
    });
  });

  it("shows the exact chip copy when the flag is on and eligible", async () => {
    renderWithProviders(<StreakChip />, {
      routes: { "/streak": BASE },
      config: { flags: { "growth.streakWidget": true } },
    });
    const chip = await screen.findByTestId("streak-chip");
    expect(chip).toHaveTextContent("3 of 3 publish days · L2 · 2 freezes left");
  });

  it("shows the paused copy and never a reset", async () => {
    renderWithProviders(<StreakChip />, {
      routes: { "/streak": { ...BASE, paused: true } },
      config: { flags: { "growth.streakWidget": true } },
    });
    const chip = await screen.findByTestId("streak-chip-paused");
    expect(chip).toHaveTextContent("Streak paused — one export restores it");
    expect(screen.queryByText(/reset/i)).toBeNull();
  });

  it("renders nothing for a holdout workspace even with the flag on", async () => {
    renderWithProviders(<StreakChip />, {
      routes: { "/streak": { ...BASE, holdout: true } },
      config: { flags: { "growth.streakWidget": true } },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("streak-chip")).toBeNull();
    });
  });

  it("renders nothing when not eligible", async () => {
    renderWithProviders(<StreakChip />, {
      routes: { "/streak": { ...BASE, eligible: false } },
      config: { flags: { "growth.streakWidget": true } },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("streak-chip")).toBeNull();
    });
  });
});
