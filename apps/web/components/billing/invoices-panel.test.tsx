import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InvoicesPanel } from "./invoices-panel";

import type { InvoiceRow } from "@/lib/billing/types";

import { renderWithProviders } from "@/test/harness";

const TAX_INVOICE: InvoiceRow = {
  id: "inv_1",
  subscriptionId: "sub_1",
  passPurchaseId: null,
  docType: "tax_invoice",
  series: "AKS",
  number: "0001",
  fiscalYear: "2026-27",
  issuedAt: "2027-01-05T00:00:00.000Z",
  recipientLegalName: "Priya Sharma",
  recipientGstin: null,
  recipientStateCode: "27",
  recipientCountry: "IN",
  placeOfSupplyStateCode: "27",
  placeOfSupplyCountry: "IN",
  supplyType: "intra_state",
  currency: "INR",
  taxableValueMinor: 59_237,
  taxRateBps: 1_800,
  cgstMinor: 5_332,
  sgstMinor: 5_331,
  igstMinor: 0,
  cessMinor: 0,
  totalTaxMinor: 10_663,
  totalMinor: 69_900,
  roundOffMinor: 0,
  relatedInvoiceId: null,
  status: "issued",
};

const CREDIT_NOTE: InvoiceRow = {
  ...TAX_INVOICE,
  id: "inv_2",
  docType: "credit_note",
  number: "0002",
  relatedInvoiceId: "inv_1",
  totalMinor: -69_900,
};

describe("<InvoicesPanel />", () => {
  it("renders an honest empty state, not an error, when GET /invoices 404s (B05 not merged yet)", async () => {
    renderWithProviders(<InvoicesPanel />, {
      routes: {
        "/invoices": new Response(
          JSON.stringify({ error: { code: "common/not_found", message: "Not found." } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      },
    });
    expect(await screen.findByTestId("invoices-empty")).toBeInTheDocument();
  });

  it("lists an invoice with its GST break-up", async () => {
    renderWithProviders(<InvoicesPanel />, { routes: { "/invoices": [TAX_INVOICE] } });
    const rows = await screen.findAllByTestId("invoice-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("AKS/0001");
    expect(rows[0]).toHaveTextContent("₹699");
    const breakup = screen.getByTestId("invoice-gst-breakup");
    expect(breakup).toHaveTextContent("CGST ₹53.32");
    expect(breakup).toHaveTextContent("SGST ₹53.31");
  });

  it("links a credit note to the invoice it refunds", async () => {
    renderWithProviders(<InvoicesPanel />, {
      routes: { "/invoices": [TAX_INVOICE, CREDIT_NOTE] },
    });
    const rows = await screen.findAllByTestId("invoice-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("Linked to invoice AKS/0001");
  });

  it("opens the signed download URL for an invoice", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithProviders(<InvoicesPanel />, {
      routes: {
        "/invoices": [TAX_INVOICE],
        "/invoices/inv_1/download": { url: "https://example.test/signed-invoice.pdf" },
      },
    });
    await screen.findByTestId("invoice-row");
    await user.click(screen.getByTestId("download-invoice"));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        "https://example.test/signed-invoice.pdf",
        "_blank",
        "noopener,noreferrer",
      );
    });
    open.mockRestore();
  });
});
