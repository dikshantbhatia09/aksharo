import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import BillingLayout from "./layout";

import { BILLING_NAV } from "@/lib/nav";
import { renderWithProviders } from "@/test/harness";

/**
 * F07-C1: three of the five `/billing` tabs only mean something with a payment
 * rail behind them. `lib/nav.ts` is a plain data module, so the filter lives in
 * this layout and is tested here rather than against the array.
 */
describe("<BillingLayout />", () => {
  it("shows every tab when Razorpay is configured", () => {
    renderWithProviders(
      <BillingLayout>
        <p>panel</p>
      </BillingLayout>,
    );
    for (const section of BILLING_NAV) {
      expect(screen.getByTestId(`billing-nav-${section.key}`)).toHaveTextContent(section.label);
    }
  });

  it("keeps only the tabs that work without a payment rail", () => {
    renderWithProviders(
      <BillingLayout>
        <p>panel</p>
      </BillingLayout>,
      { config: { razorpayEnabled: false } },
    );
    expect(screen.getByTestId("billing-nav-overview")).toBeInTheDocument();
    expect(screen.getByTestId("billing-nav-usage")).toBeInTheDocument();
    for (const key of ["plans", "methods", "invoices"]) {
      expect(screen.queryByTestId(`billing-nav-${key}`)).toBeNull();
    }
  });
});
