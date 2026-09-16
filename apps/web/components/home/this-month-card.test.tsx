import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CreditsSummary, Entitlement } from "@montaj/api-client";

import { ThisMonthCard } from "./this-month-card";

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

describe("<ThisMonthCard />", () => {
  it("shows how many credits are left against the monthly grant", async () => {
    renderWithProviders(<ThisMonthCard />, {
      routes: { ...ROUTES_BASE, "/workspaces/01JWORKSPACE/credits": credits({}) },
    });
    await waitFor(() => expect(screen.getByTestId("this-month-balance")).toHaveTextContent("178"));
    expect(screen.getByText("credits left of 200")).toBeInTheDocument();
  });

  // A workspace can carry an admin "adjustment" lot on top of its monthly
  // grant (Subscription -> Usage draws these as separate "Grant" and "Adjust"
  // lots for exactly this reason). Before this fix, this card summed every
  // lot into one balance and always framed it as "left of {grant}" -- so a
  // workspace with such a lot read "10000178 credits left of 200", which
  // looks exactly like a broken counter even though the ledger underneath it
  // is correct. A denominator that the numerator can exceed is worse than no
  // denominator.
  it("does not claim a false denominator once a lot pushes the balance past the monthly grant", async () => {
    renderWithProviders(<ThisMonthCard />, {
      routes: {
        ...ROUTES_BASE,
        "/workspaces/01JWORKSPACE/credits": credits({ balanceTenths: 100_001_780 }),
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("this-month-balance")).toHaveTextContent("10000178"),
    );
    expect(screen.getByText("credits left")).toBeInTheDocument();
    expect(screen.queryByText(/credits left of/)).toBeNull();
  });
});
