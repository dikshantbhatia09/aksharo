import { describe, expect, it } from "vitest";

import { determinePlaceOfSupply } from "./place-of-supply.js";

const MAHARASHTRA_GSTIN = "27AAPFU0939F1ZV";
const KARNATAKA_GSTIN = "29AAGCB7383J1Z4";

describe("determinePlaceOfSupply", () => {
  it("is intra_state when the recipient's recorded State matches the supplier's", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "IN",
      recipientStateCode: "27",
      supplierStateCode: "27",
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { stateCode: "27", country: "IN", supplyType: "intra_state", reverseCharge: false },
    });
  });

  it("is inter_state when the recorded State differs from the supplier's", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "IN",
      recipientStateCode: "29",
      supplierStateCode: "27",
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { stateCode: "29", supplyType: "inter_state", reverseCharge: false },
    });
  });

  it("prefers the GSTIN's own State over the recorded billing State (B2B)", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "IN",
      recipientGstin: KARNATAKA_GSTIN,
      recipientStateCode: "29",
      supplierStateCode: "27",
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { stateCode: "29", supplyType: "inter_state" },
    });
  });

  it("rejects a malformed GSTIN rather than silently falling back", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "IN",
      recipientGstin: "not-a-gstin",
      recipientStateCode: "27",
      supplierStateCode: "27",
    });
    expect(outcome).toMatchObject({ ok: false, problem: "gstin_malformed" });
  });

  it("hard-fails an India B2C invoice with no recorded State (D41)", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "IN",
      supplierStateCode: "27",
    });
    expect(outcome).toMatchObject({ ok: false, problem: "state_required" });
  });

  it("is export, zero-rated, for a non-Indian recipient", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "US",
      supplierStateCode: "27",
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { stateCode: null, country: "US", supplyType: "export", reverseCharge: false },
    });
  });

  it("is sez only when explicitly asserted by the caller", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "US",
      supplierStateCode: "27",
      isSez: true,
    });
    expect(outcome).toMatchObject({ ok: true, result: { supplyType: "sez" } });
  });

  it("is import_rcm, reverse-charged, at our own State, for an imported service self-invoice", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "US", // ignored for RCM: the place of supply is ours
      supplierStateCode: "27",
      isImportOfService: true,
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        stateCode: "27",
        country: "IN",
        supplyType: "import_rcm",
        reverseCharge: true,
      },
    });
  });

  it("normalises a lower-case GSTIN and country code", () => {
    const outcome = determinePlaceOfSupply({
      recipientCountry: "in",
      recipientGstin: MAHARASHTRA_GSTIN.toLowerCase(),
      recipientStateCode: "27",
      supplierStateCode: "27",
    });
    expect(outcome).toMatchObject({ ok: true, result: { stateCode: "27" } });
  });
});
