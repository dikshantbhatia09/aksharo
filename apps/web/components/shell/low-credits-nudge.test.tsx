import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { CreditsSummary } from "@montaj/api-client";

import { LowCreditsNudge, isLowOnCredits } from "./low-credits-nudge";

import { renderWithProviders } from "@/test/harness";

function credits(balanceTenths: number, monthlyGrantTenths = 2_000): CreditsSummary {
  return {
    workspaceId: "01JWORKSPACE",
    balanceTenths,
    monthlyGrantTenths,
    grantResetAt: "2027-02-01T00:00:00.000Z",
    lots: [],
  };
}

const route = (summary: CreditsSummary): Record<string, unknown> => ({
  "/workspaces/01JWORKSPACE/credits": summary,
});

describe("isLowOnCredits", () => {
  it("is under 15 % of a monthly grant, and never without one", () => {
    expect(isLowOnCredits(290, 2_000)).toBe(true);
    expect(isLowOnCredits(300, 2_000)).toBe(false);
    expect(isLowOnCredits(0, 0)).toBe(false);
  });
});

describe("<LowCreditsNudge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("says how much is left in minutes, and links to the balance", async () => {
    renderWithProviders(<LowCreditsNudge />, { routes: route(credits(240)) });
    const card = await screen.findByTestId("low-credits-nudge");
    expect(card).toHaveTextContent("24 credits left: about 24m of video to find clips in.");
    expect(screen.getByTestId("low-credits-see")).toHaveAttribute("href", "/billing");
  });

  it("stays away while there is plenty", async () => {
    const { fetchMock } = renderWithProviders(<LowCreditsNudge />, {
      routes: route(credits(1_780)),
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("low-credits-nudge")).not.toBeInTheDocument();
  });

  it("is put away until the grant next comes back", async () => {
    const first = renderWithProviders(<LowCreditsNudge />, { routes: route(credits(100)) });
    await userEvent.click(await screen.findByTestId("low-credits-dismiss"));
    expect(screen.queryByTestId("low-credits-nudge")).not.toBeInTheDocument();
    first.unmount();

    const again = renderWithProviders(<LowCreditsNudge />, { routes: route(credits(100)) });
    await waitFor(() => {
      expect(again.fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("low-credits-nudge")).not.toBeInTheDocument();
    again.unmount();

    renderWithProviders(<LowCreditsNudge />, {
      routes: route({ ...credits(100), grantResetAt: "2027-03-01T00:00:00.000Z" }),
    });
    expect(await screen.findByTestId("low-credits-nudge")).toBeInTheDocument();
  });
});
