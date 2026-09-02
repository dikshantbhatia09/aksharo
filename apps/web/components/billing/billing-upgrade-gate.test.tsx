import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BillingUpgradeGate } from "./billing-upgrade-gate";

import type { PlanView } from "@/lib/billing/types";

import * as razorpay from "@/lib/billing/razorpay";
import { renderWithProviders } from "@/test/harness";

vi.mock("@/lib/billing/razorpay", () => ({
  openRazorpayCheckout: vi.fn(),
  loadRazorpayCheckout: vi.fn(),
}));

// `restoreMocks: true` (packages/config/vitest.base.mjs) clears every mock's
// implementation before each test, so this is re-armed here rather than once
// at module scope.
beforeEach(() => {
  vi.mocked(razorpay.openRazorpayCheckout).mockResolvedValue(false);
  vi.mocked(razorpay.loadRazorpayCheckout).mockResolvedValue(null);
});

const PLANS: PlanView[] = [
  {
    key: "creator",
    name: "Creator",
    prices: { INR: { month: 69_900, year: 698_400 }, USD: { month: 1_900, year: 18_960 } },
    creditsPerMonthTenths: 5_000,
    seatPrice: null,
    hasHalfyear: { INR: false, USD: false },
  },
];

/**
 * The one composed gate every other work package's gated control is meant to
 * use (08 §5: "any locked control shows the plan needed inline ... with a
 * single-click checkout sheet; never a dead end").
 */
describe("<BillingUpgradeGate />", () => {
  it("names the required plan and its price", async () => {
    renderWithProviders(<BillingUpgradeGate requiredPlan="creator" feature="4K export" />, {
      routes: { "/billing/plans": PLANS },
    });
    const gate = await screen.findByTestId("upgrade-gate");
    expect(gate).toHaveTextContent("4K export is on Creator");
    // The price arrives once `GET /billing/plans` resolves, a render after
    // the gate itself first appears.
    await waitFor(() => {
      expect(gate).toHaveTextContent("₹699/mo");
    });
  });

  it("opens the checkout sheet for that exact plan on a single click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingUpgradeGate requiredPlan="creator" feature="4K export" />, {
      routes: {
        "/billing/plans": PLANS,
        "/workspaces/01JWORKSPACE": {
          id: "01JWORKSPACE",
          currency: "INR",
          billingCountry: "IN",
          billingCountryConfirmedAt: "2027-01-01T00:00:00.000Z",
          billingStateCode: "27",
          gstin: null,
          legalName: null,
          currencyLocked: false,
          role: "owner",
        },
        "/billing/subscription": null,
      },
    });
    await screen.findByTestId("upgrade-gate");
    await user.click(screen.getByRole("button", { name: "Upgrade to Creator" }));
    const sheet = await screen.findByTestId("checkout-sheet");
    expect(sheet).toHaveTextContent("Creator");
  });
});
