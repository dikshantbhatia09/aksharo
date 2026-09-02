import { describe, expect, it } from "vitest";

import { ManualFallbackExchangeRateProvider } from "./exchange-rate.js";
import { TaxEngineService } from "./tax-engine.service.js";

const SUPPLIER_STATE = "27"; // Maharashtra

function makeService(): TaxEngineService {
  return new TaxEngineService(
    new ManualFallbackExchangeRateProvider([
      { effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), rate: 87 },
    ]),
  );
}

describe("TaxEngineService.compute — the tax rules table", () => {
  it("intra-state B2C (same State as supplier): CGST 9% + SGST 9%", async () => {
    const outcome = await makeService().compute({
      totalMinor: 69_900,
      currency: "INR",
      recipientCountry: "IN",
      recipientStateCode: SUPPLIER_STATE,
      supplierStateCode: SUPPLIER_STATE,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.computation).toMatchObject({
      supplyType: "intra_state",
      placeOfSupplyStateCode: SUPPLIER_STATE,
      taxRateBps: 1800,
      cgstMinor: 5_331,
      sgstMinor: 5_332,
      igstMinor: 0,
      reverseCharge: false,
      exportEndorsementText: null,
    });
    expect(outcome.computation.exchangeRateToInr).toBeNull();
  });

  it("inter-state B2B (GSTIN in a different State): IGST 18%", async () => {
    const outcome = await makeService().compute({
      totalMinor: 199_900,
      currency: "INR",
      recipientCountry: "IN",
      recipientGstin: "29AAGCB7383J1Z4", // Karnataka
      recipientStateCode: "29",
      supplierStateCode: SUPPLIER_STATE,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.computation.supplyType).toBe("inter_state");
    expect(outcome.computation.igstMinor).toBeGreaterThan(0);
    expect(outcome.computation.cgstMinor).toBe(0);
    expect(outcome.computation.sgstMinor).toBe(0);
  });

  it("export under LUT (non-Indian recipient, USD): zero-rated with the endorsement and an FX rate", async () => {
    const outcome = await makeService().compute({
      totalMinor: 1_900, // $19.00
      currency: "USD",
      recipientCountry: "US",
      supplierStateCode: SUPPLIER_STATE,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.computation).toMatchObject({
      supplyType: "export",
      placeOfSupplyStateCode: null,
      placeOfSupplyCountry: "US",
      taxRateBps: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      taxableValueMinor: 1_900,
      exportEndorsementText: "SUPPLY MEANT FOR EXPORT UNDER LUT WITHOUT PAYMENT OF INTEGRATED TAX",
    });
    expect(outcome.computation.exchangeRateToInr).toBe(87);
    expect(outcome.computation.exchangeRateAt).toBeInstanceOf(Date);
  });

  it("import_rcm self-invoice: reverse charge, our own State, zero output tax", async () => {
    const outcome = await makeService().compute({
      totalMinor: 500_00,
      currency: "USD",
      recipientCountry: "US",
      supplierStateCode: SUPPLIER_STATE,
      isImportOfService: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.computation).toMatchObject({
      supplyType: "import_rcm",
      placeOfSupplyStateCode: SUPPLIER_STATE,
      placeOfSupplyCountry: "IN",
      reverseCharge: true,
      taxRateBps: 0,
    });
  });

  it("fails closed on an India B2C invoice with no recorded State", async () => {
    const outcome = await makeService().compute({
      totalMinor: 69_900,
      currency: "INR",
      recipientCountry: "IN",
      supplierStateCode: SUPPLIER_STATE,
    });
    expect(outcome).toMatchObject({ ok: false, problem: "state_required" });
  });

  it("carries the USD exchange rate for a USD invoice, and none for INR", async () => {
    const usd = await makeService().compute({
      totalMinor: 1_900,
      currency: "USD",
      recipientCountry: "US",
      supplierStateCode: SUPPLIER_STATE,
    });
    const inr = await makeService().compute({
      totalMinor: 69_900,
      currency: "INR",
      recipientCountry: "IN",
      recipientStateCode: SUPPLIER_STATE,
      supplierStateCode: SUPPLIER_STATE,
    });
    expect(usd.ok && usd.computation.exchangeRateToInr).toBe(87);
    expect(inr.ok && inr.computation.exchangeRateToInr).toBeNull();
  });
});
