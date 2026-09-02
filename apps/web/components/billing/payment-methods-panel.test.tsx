import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PaymentMethodsPanel } from "./payment-methods-panel";

import type { MandateView, PaymentMethodView } from "@/lib/billing/types";

import { renderWithProviders } from "@/test/harness";

const METHODS: PaymentMethodView[] = [
  { method: "upi", label: "UPI", isDefault: true },
  { method: "card", label: "Visa •••• 4242", last4: "4242", network: "Visa" },
];

const MANDATE: MandateView = {
  id: "mandate_1",
  method: "upi_autopay",
  maxAmountMinor: 69_900,
  currency: "INR",
  status: "active",
  afaRequiredPerDebit: false,
  validFrom: "2027-01-01T00:00:00.000Z",
  validUntil: null,
};

describe("<PaymentMethodsPanel />", () => {
  it("lists payment methods on file and marks the default", async () => {
    renderWithProviders(<PaymentMethodsPanel />, {
      routes: { "/billing/payment-methods": METHODS, "/billing/mandates": [] },
    });
    const rows = await screen.findAllByTestId("payment-method-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("UPI");
    expect(rows[0]).toHaveTextContent("Default");
    expect(rows[1]).toHaveTextContent("4242");
  });

  it("shows the mandate cap and the 24-hour pre-debit notice", async () => {
    renderWithProviders(<PaymentMethodsPanel />, {
      routes: { "/billing/payment-methods": [], "/billing/mandates": [MANDATE] },
    });
    const row = await screen.findByTestId("mandate-row");
    expect(row).toHaveTextContent("Capped at ₹699 per debit");
    expect(row).toHaveTextContent("24-hour pre-debit notice");
  });

  it("warns before revoking a mandate, then revokes it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentMethodsPanel />, {
      routes: {
        "/billing/payment-methods": [],
        "/billing/mandates": [MANDATE],
        "/billing/mandates/mandate_1/revoke": { ...MANDATE, status: "revoked" },
      },
    });
    await screen.findByTestId("mandate-row");
    await user.click(screen.getByTestId("revoke-mandate"));
    expect(screen.getByText(/cancels the subscription it pays for too/i)).toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-revoke-mandate"));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-revoke-mandate")).toBeNull();
    });
  });
});
