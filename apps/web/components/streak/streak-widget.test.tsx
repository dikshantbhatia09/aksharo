import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StreakView } from "@montaj/api-client";

import { StreakWidget } from "./streak-widget";

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
  nextRewardLabel: "10% off your next renewal at L3",
  discountPercent: 5,
  creditGrantTenths: 0,
};

describe("<StreakWidget />", () => {
  it("shows the exact 08 §4 summary copy and the level badge", async () => {
    renderWithProviders(<StreakWidget />, { routes: { "/streak": BASE } });
    const summary = await screen.findByTestId("streak-widget-summary");
    expect(summary).toHaveTextContent("3 of 3 publish days · L2 · 2 freezes left");
    expect(screen.getByText("L2")).toBeInTheDocument();
    expect(screen.getByTestId("streak-widget-next-reward")).toHaveTextContent(
      "10% off your next renewal at L3",
    );
  });

  it("shows the paused copy, never a reset, and hides the progress bar", async () => {
    renderWithProviders(<StreakWidget />, {
      routes: { "/streak": { ...BASE, paused: true, publishDaysThisWeek: 1 } },
    });
    const paused = await screen.findByTestId("streak-widget-paused");
    expect(paused).toHaveTextContent("Streak paused — one export restores it");
    expect(screen.queryByTestId("streak-widget-summary")).toBeNull();
    expect(screen.queryByText(/reset/i)).toBeNull();
  });

  it("renders nothing at all for a holdout workspace", async () => {
    const { container } = renderWithProviders(<StreakWidget />, {
      routes: { "/streak": { ...BASE, holdout: true } },
    });
    await waitFor(() => {
      expect(container.textContent).not.toContain("Loading streak");
    });
    expect(screen.queryByTestId("streak-widget-slot")).toBeNull();
  });

  it("renders nothing when not eligible", async () => {
    renderWithProviders(<StreakWidget />, {
      routes: { "/streak": { ...BASE, eligible: false } },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("streak-widget-slot")).toBeNull();
    });
  });

  it("the Free credits-only variant shows publish days without a level badge", async () => {
    renderWithProviders(<StreakWidget />, {
      routes: {
        "/streak": {
          ...BASE,
          creditsOnly: true,
          level: 1,
          nextRewardLabel: "1 more kept week(s) for +5 credits",
        },
      },
    });
    const summary = await screen.findByTestId("streak-widget-summary");
    expect(summary).toHaveTextContent("3 of 3 publish days");
    expect(summary).not.toHaveTextContent("L1");
    expect(screen.queryByText("L1")).toBeNull();
  });
});
