import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CreditsSummary, Entitlement } from "@montaj/api-client";

import { CreditsCard } from "./credits-card";

import { renderWithProviders } from "@/test/harness";

const ENTITLEMENT: Entitlement = {
  workspaceId: "01JWORKSPACE",
  planKey: "free",
  planName: "Free",
  creditsPerMonthTenths: 2_000,
  seatsIncluded: 1,
  seatsUsed: 1,
  entitlements: {},
  computedAt: "2027-01-01T00:00:00.000Z",
};

function credits(overrides: Partial<CreditsSummary>): CreditsSummary {
  return {
    workspaceId: "01JWORKSPACE",
    balanceTenths: 1_780,
    monthlyGrantTenths: 2_000,
    grantResetAt: "2027-02-01T00:00:00.000Z",
    lots: [],
    ...overrides,
  };
}

const ROUTES_BASE = {
  "/workspaces/01JWORKSPACE/entitlement": ENTITLEMENT,
};

describe("<CreditsCard />", () => {
  it("shows the balance against the monthly grant", async () => {
    renderWithProviders(<CreditsCard />, {
      routes: { ...ROUTES_BASE, "/workspaces/01JWORKSPACE/credits": credits({}) },
    });
    await waitFor(() =>
      expect(screen.getByTestId("credits-card-balance")).toHaveTextContent("178 / 200"),
    );
  });

  // Same bug as `this-month-card.tsx` (CLAUDE.md §8) and the billing overview
  // card: an admin "adjustment" lot on top of the monthly grant can push the
  // balance past it (this workspace's real one does, by a large margin), and
  // "N / grant" then reads as a broken/overflowing counter even though the
  // ledger underneath is correct. This sidebar widget had the identical bug,
  // unfixed, until now.
  it("does not claim a false denominator once a lot pushes the balance past the monthly grant", async () => {
    renderWithProviders(<CreditsCard />, {
      routes: {
        ...ROUTES_BASE,
        "/workspaces/01JWORKSPACE/credits": credits({ balanceTenths: 100_001_780 }),
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("credits-card-balance")).toHaveTextContent("10000178"),
    );
    expect(screen.getByTestId("credits-card-balance")).not.toHaveTextContent("/");
  });

  it("shows an em dash rather than dividing by zero when there is no grant", async () => {
    renderWithProviders(<CreditsCard />, { routes: {} });
    await waitFor(() =>
      expect(screen.getByTestId("credits-card-balance")).toHaveTextContent("—"),
    );
  });
});
