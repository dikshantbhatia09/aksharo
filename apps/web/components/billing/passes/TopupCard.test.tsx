import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OffersEligibilityView } from "@montaj/api-client";

import { TopupCard } from "./TopupCard";

import { renderWithProviders } from "@/test/harness";

const ELIGIBILITY: OffersEligibilityView = {
  signupGift: { available: false },
  ninePass: {
    available: false,
    eligibleToBuy: true,
    reason: null,
    nextEligibleAt: null,
    priceMinor: 900,
    currency: "INR",
  },
  weekPass: {
    active: false,
    endsAt: null,
    priceMinor: 14_900,
    currency: "INR",
    creditsGrantedTenths: 500,
    days: 7,
  },
  topupFree149: { available: true, priceMinor: 14_900, currency: "INR", credits: 150 },
};

describe("<TopupCard />", () => {
  it("offers the top-up when Razorpay is configured", async () => {
    renderWithProviders(<TopupCard />, { routes: { "/offers/eligibility": ELIGIBILITY } });
    expect(await screen.findByTestId("topup-card-buy")).toHaveTextContent("Top up");
  });

  // A top-up button with no keys opens Razorpay with a fake key: a dead end in the
  // one place the app promises a click always leads somewhere.
  it("replaces the top-up with the admin-credit panel when Razorpay is absent", async () => {
    renderWithProviders(<TopupCard />, {
      config: { razorpayEnabled: false },
      routes: { "/offers/eligibility": ELIGIBILITY },
    });
    expect(await screen.findByTestId("free-stack-billing")).toHaveTextContent(
      "Credits are granted by your admin",
    );
    expect(screen.queryByTestId("topup-card-buy")).toBeNull();
  });
});
