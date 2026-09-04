import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OffersEligibilityView } from "@montaj/api-client";

import { ExportUpsellPanel } from "./ExportUpsellPanel";

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

describe("<ExportUpsellPanel />", () => {
  it("offers both passes when Razorpay is configured", async () => {
    renderWithProviders(<ExportUpsellPanel />, {
      routes: { "/offers/eligibility": ELIGIBILITY },
    });
    expect(await screen.findByTestId("export-upsell-buy-nine-pass")).toBeInTheDocument();
    expect(screen.getByTestId("export-upsell-buy-week-pass")).toBeInTheDocument();
  });

  // The watermark upsell sits in the core export journey, so a buy button that
  // cannot charge is the most visible dead end in the product.
  it("hides both buy buttons and explains who grants credits without Razorpay", async () => {
    renderWithProviders(<ExportUpsellPanel />, {
      config: { razorpayEnabled: false },
      routes: { "/offers/eligibility": ELIGIBILITY },
    });
    expect(await screen.findByTestId("export-upsell-free-stack")).toHaveTextContent(
      "Ask an administrator to grant credits",
    );
    expect(screen.queryByTestId("export-upsell-buy-nine-pass")).toBeNull();
    expect(screen.queryByTestId("export-upsell-buy-week-pass")).toBeNull();
  });

  // A price with no button is a broken offer, not a softer one: the panel must
  // quote nothing it cannot charge, and must not send the user to a price list.
  it("prints no price at all and drops See plans without Razorpay", async () => {
    renderWithProviders(<ExportUpsellPanel />, {
      config: { razorpayEnabled: false },
      routes: { "/offers/eligibility": ELIGIBILITY },
    });
    const panel = await screen.findByTestId("export-upsell-panel");
    expect(panel.textContent).not.toContain("₹");
    expect(screen.queryByTestId("export-upsell-see-plans")).toBeNull();
    expect(panel).toHaveTextContent("Clean export — ask an administrator for credits");
    expect(panel).toHaveTextContent("Week pass — not available in this build");
  });

  it("still quotes both prices and links the plans when Razorpay is configured", async () => {
    renderWithProviders(<ExportUpsellPanel />, {
      routes: { "/offers/eligibility": ELIGIBILITY },
    });
    const panel = await screen.findByTestId("export-upsell-panel");
    expect(panel).toHaveTextContent("Remove for ₹9 (first export)");
    expect(panel).toHaveTextContent("₹149 for 7 days");
    expect(screen.getByTestId("export-upsell-see-plans")).toHaveAttribute("href", "/pricing");
  });
});
