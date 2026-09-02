import { describe, expect, it } from "vitest";

import { renderInvoicePdf } from "./invoice-pdf.renderer.js";
import { extractPdfText } from "./pdf-text-extract.js";

import type { InvoicePdfInput } from "./invoice-pdf.renderer.js";

/**
 * Golden PDF acceptance tests (brief acceptance criterion 1): India B2C
 * intra-state, India B2B inter-state, USD export under LUT, and a credit
 * note — each rendered, text-extracted (`extractPdfText.ts` — see its
 * doc-comment for why this isn't a library), and asserted against every
 * Rule 46 particular.
 */

const SUPPLIER = {
  legalName: "Aksharo Technologies Private Limited",
  address: { line1: "123 MG Road", city: "Mumbai", postalCode: "400001", country: "IN" },
  gstin: "27AAPFU0939F1ZV",
  stateCode: "27",
  pan: "AAPFU0939F",
};

function baseInput(overrides: Partial<InvoicePdfInput>): InvoicePdfInput {
  return {
    docType: "tax_invoice",
    displayNumber: "AK2627-IN-000123",
    issuedAt: new Date("2026-09-02T00:00:00.000Z"),
    supplier: SUPPLIER,
    recipient: {
      legalName: "Priya Sharma",
      address: { line1: "45 Park Street", city: "Mumbai", postalCode: "400002", country: "IN" },
      stateCode: "27",
    },
    recipientCountry: "IN",
    placeOfSupplyStateCode: "27",
    placeOfSupplyCountry: "IN",
    supplyType: "intra_state",
    reverseCharge: false,
    sacCode: "998316",
    itemDescription: "Aksharo Creator monthly subscription",
    currency: "INR",
    taxableValueMinor: 59_237,
    discountMinor: 0,
    taxRateBps: 1800,
    cgstMinor: 5_331,
    sgstMinor: 5_332,
    igstMinor: 0,
    cessMinor: 0,
    totalTaxMinor: 10_663,
    totalMinor: 69_900,
    roundOffMinor: 0,
    signatureBlock: {
      signerName: "Aksharo Technologies Private Limited",
      signatureId: "01JXAMPLE0000000000000000",
      signedAt: new Date("2026-09-02T00:05:00.000Z"),
    },
    ...overrides,
  };
}

async function extractText(input: InvoicePdfInput): Promise<string> {
  const buffer = await renderInvoicePdf(input);
  return extractPdfText(buffer);
}

describe("golden PDF — India B2C intra-state", () => {
  it("contains every Rule 46 particular", async () => {
    const text = await extractText(baseInput({}));

    expect(text).toContain("TAX INVOICE");
    expect(text).toContain("Invoice No: AK2627-IN-000123");
    expect(text).toContain("Date of Issue: 2026-09-02");
    expect(text).toContain(SUPPLIER.legalName);
    expect(text).toContain(`GSTIN: ${SUPPLIER.gstin}`);
    expect(text).toContain("Supplier State: Maharashtra (27)");
    expect(text).toContain(`PAN: ${SUPPLIER.pan}`);
    expect(text).toContain("Priya Sharma");
    expect(text).toContain("Recipient GSTIN: Unregistered (B2C)");
    expect(text).toContain("Recipient State: Maharashtra (27)");
    expect(text).toContain("Place of Supply: Maharashtra (27), IN");
    expect(text).toContain("HSN/SAC: 998316");
    expect(text).toContain("Reverse Charge Applicable: No");
    expect(text).toContain("Taxable Value: Rs 592.37");
    expect(text).toContain("CGST @ 9.00%: Rs 53.31");
    expect(text).toContain("SGST @ 9.00%: Rs 53.32");
    expect(text).toContain("Total Tax: Rs 106.63");
    expect(text).toContain("Total (incl. GST): Rs 699.00");
    expect(text).toContain("inclusive of GST");
    expect(text).toContain("Digitally signed by: Aksharo Technologies Private Limited");
    expect(text).toContain("Signature ID: 01JXAMPLE0000000000000000");
    // Not an inter-state or export invoice: no IGST line, no LUT endorsement.
    expect(text).not.toContain("IGST @");
    expect(text).not.toContain("EXPORT UNDER LUT");
  });
});

describe("golden PDF — India B2B inter-state", () => {
  it("carries the recipient GSTIN, IGST only, and no CGST/SGST", async () => {
    const text = await extractText(
      baseInput({
        recipient: {
          legalName: "Umbrella Films LLP",
          address: { line1: "1 MG Road", city: "Bengaluru", postalCode: "560001", country: "IN" },
          gstin: "29AAGCB7383J1Z4",
          stateCode: "29",
        },
        placeOfSupplyStateCode: "29",
        supplyType: "inter_state",
        cgstMinor: 0,
        sgstMinor: 0,
        igstMinor: 10_663,
      }),
    );

    expect(text).toContain("Umbrella Films LLP");
    expect(text).toContain("Recipient GSTIN: 29AAGCB7383J1Z4");
    expect(text).toContain("Recipient State: Karnataka (29)");
    expect(text).toContain("Place of Supply: Karnataka (29), IN");
    expect(text).toContain("IGST @ 18.00%: Rs 106.63");
    expect(text).not.toContain("CGST @");
    expect(text).not.toContain("SGST @");
  });
});

describe("golden PDF — USD export under LUT", () => {
  it("is zero-rated, carries the LUT endorsement verbatim, and the FX rate", async () => {
    const text = await extractText(
      baseInput({
        docType: "export_invoice",
        recipient: {
          legalName: "Acme Creators Inc.",
          address: { line1: "500 Market St", city: "San Francisco", country: "US" },
        },
        recipientCountry: "US",
        placeOfSupplyStateCode: null,
        placeOfSupplyCountry: "US",
        supplyType: "export",
        currency: "USD",
        exchangeRateToInr: 87.25,
        taxableValueMinor: 1_900,
        cgstMinor: 0,
        sgstMinor: 0,
        igstMinor: 0,
        totalTaxMinor: 0,
        totalMinor: 1_900,
        lutNumber: "AD270825001234A",
        exportEndorsementText:
          "SUPPLY MEANT FOR EXPORT UNDER LUT WITHOUT PAYMENT OF INTEGRATED TAX",
      }),
    );

    expect(text).toContain("EXPORT INVOICE");
    expect(text).toContain("Acme Creators Inc.");
    expect(text).toContain("Place of Supply: N/A (outside India), US");
    expect(text).toContain("Total Tax: $0.00");
    expect(text).toContain("Total (incl. GST): $19.00");
    expect(text).toContain("SUPPLY MEANT FOR EXPORT UNDER LUT WITHOUT PAYMENT OF INTEGRATED TAX");
    expect(text).toContain("LUT No: AD270825001234A");
    expect(text).toContain("Exchange Rate: 1 USD = Rs 87.2500");
    expect(text).not.toContain("CGST @");
    expect(text).not.toContain("IGST @");
  });
});

describe("golden PDF — credit note", () => {
  it("references the original invoice and the reason code", async () => {
    const text = await extractText(
      baseInput({
        docType: "credit_note",
        relatedInvoiceDisplayNumber: "AK2627-IN-000123",
        reasonCode: "subscription_refund",
      }),
    );

    expect(text).toContain("CREDIT NOTE");
    expect(text).toContain("Original Invoice No: AK2627-IN-000123");
    expect(text).toContain("Reason: subscription_refund");
    expect(text).toContain("Total (incl. GST): Rs 699.00");
  });
});

describe("golden PDF — e-invoicing IRN/QR hook, enabled", () => {
  it("prints the IRN, ack details and signed QR payload when populated", async () => {
    const text = await extractText(
      baseInput({
        irn: "35054cc24d95e3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1",
        irnAckNo: "112010001234567",
        irnAckDate: new Date("2026-09-02T06:00:00.000Z"),
        signedQrPayload: "eyJTZWxsZXJHc3RpbiI6IjI3QUFQRlUwOTM5RjFaViJ9",
      }),
    );

    expect(text).toContain("e-Invoice");
    expect(text).toContain("IRN: 35054cc24d95e3");
    expect(text).toContain("Ack No: 112010001234567");
    expect(text).toContain("Ack Date: 2026-09-02");
    expect(text).toContain("Signed QR Payload:");
  });

  it("omits the e-Invoice block entirely when the flag is off (no IRN populated)", async () => {
    const text = await extractText(baseInput({}));
    expect(text).not.toContain("e-Invoice");
    expect(text).not.toContain("IRN:");
  });
});
