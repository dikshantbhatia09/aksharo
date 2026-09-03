import { describe, expect, it } from "vitest";

import { EpidemicPartnerCatalogue } from "./epidemic-partner-catalogue.js";
import { PARTNER_CATALOGUE_ERRORS } from "./partner-catalogue.constants.js";
import { AppException } from "../common/errors/error-codes.js";

/**
 * H-28 is unsigned (`_orchestration/D04b-partner-catalogue.md`): every method
 * on the real adapter must throw the contract gate until credentials are
 * configured, proven here so a future PR that quietly wires this up without
 * `isConfigured()` returning true breaks a test rather than shipping live.
 */
describe("EpidemicPartnerCatalogue (H-28 contract gate)", () => {
  it("isConfigured() is false with no credentials", () => {
    const adapter = new EpidemicPartnerCatalogue({});
    expect(adapter.isConfigured()).toBe(false);
  });

  it("isConfigured() is false with only one of the two credentials", () => {
    expect(new EpidemicPartnerCatalogue({ apiKey: "k" }).isConfigured()).toBe(false);
    expect(new EpidemicPartnerCatalogue({ apiSecret: "s" }).isConfigured()).toBe(false);
  });

  it("isConfigured() is true once both credentials are set", () => {
    const adapter = new EpidemicPartnerCatalogue({ apiKey: "k", apiSecret: "s" });
    expect(adapter.isConfigured()).toBe(true);
  });

  it("search throws the contract gate when unconfigured", async () => {
    const adapter = new EpidemicPartnerCatalogue({});
    await expect(adapter.search("test")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.contractGate,
    });
    await expect(adapter.search("test")).rejects.toBeInstanceOf(AppException);
  });

  it("stream throws the contract gate when unconfigured", async () => {
    const adapter = new EpidemicPartnerCatalogue({});
    await expect(adapter.stream("mock-sfx-0001")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.contractGate,
    });
  });

  it("grant throws the contract gate when unconfigured", async () => {
    const adapter = new EpidemicPartnerCatalogue({});
    await expect(
      adapter.grant({ providerAssetId: "x", workspaceId: "ws", useContext: "pass_item" }),
    ).rejects.toMatchObject({ code: PARTNER_CATALOGUE_ERRORS.contractGate });
  });

  it("reportUsage throws the contract gate when unconfigured", async () => {
    const adapter = new EpidemicPartnerCatalogue({});
    await expect(adapter.reportUsage({ grantId: "g", exportId: "e" })).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.contractGate,
    });
  });

  it("revoke throws the contract gate when unconfigured", async () => {
    const adapter = new EpidemicPartnerCatalogue({});
    await expect(adapter.revoke("g")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.contractGate,
    });
  });

  it("the contract gate is still thrown even when configured (H-28 has no real call to make yet)", async () => {
    const adapter = new EpidemicPartnerCatalogue({ apiKey: "k", apiSecret: "s" });
    expect(adapter.isConfigured()).toBe(true);
    await expect(adapter.search("test")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.contractGate,
    });
  });
});
