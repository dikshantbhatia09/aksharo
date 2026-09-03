import { describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { PARTNER_CATALOGUE_ERRORS } from "./partner-catalogue.constants.js";
import { PartnerCatalogueService } from "./partner-catalogue.service.js";
import { AppException } from "../common/errors/error-codes.js";

function fakeEnv(flags: Record<string, unknown>): Env {
  return { FEATURE_FLAGS_JSON: flags } as unknown as Env;
}

function fakePrisma() {
  const grants = new Map<string, Record<string, unknown>>();
  return {
    assetClearanceGrant: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data };
        grants.set(data["id"] as string, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return grants.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const existing = grants.get(where.id);
          if (existing === undefined) throw new Error("not found");
          const updated = { ...existing, ...data };
          grants.set(where.id, updated);
          return updated;
        },
      ),
    },
  };
}

describe("PartnerCatalogueService (D04b) — flag gate", () => {
  it("is disabled by default (flag absent from FEATURE_FLAGS_JSON)", () => {
    const service = new PartnerCatalogueService(fakeEnv({}), fakePrisma() as never);
    expect(service.enabled).toBe(false);
  });

  it("every method refuses with partner-catalogue/disabled while the flag is off", async () => {
    const service = new PartnerCatalogueService(fakeEnv({}), fakePrisma() as never);

    await expect(service.search("test")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.disabled,
    });
    await expect(service.stream("mock-sfx-0001")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.disabled,
    });
    await expect(
      service.grant({
        providerAssetId: "mock-sfx-0001",
        workspaceId: "ws",
        useContext: "pass_item",
      }),
    ).rejects.toMatchObject({ code: PARTNER_CATALOGUE_ERRORS.disabled });
    await expect(service.reportUsage({ grantId: "g", exportId: "e" })).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.disabled,
    });
    await expect(service.revoke("g")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.disabled,
    });
  });

  it("every rejection is an AppException, never a bare Error", async () => {
    const service = new PartnerCatalogueService(fakeEnv({}), fakePrisma() as never);
    await expect(service.search("test")).rejects.toBeInstanceOf(AppException);
  });

  it("explicitly false behaves exactly like absent (both are 'off')", async () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": false }),
      fakePrisma() as never,
    );
    expect(service.enabled).toBe(false);
    await expect(service.search("test")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.disabled,
    });
  });

  it("defaults to the mock provider once enabled", () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      fakePrisma() as never,
    );
    expect(service.enabled).toBe(true);
    expect(service.providerName).toBe("mock");
  });

  it("selects epidemic only when explicitly configured", () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true, "assets.partnerCatalogueProvider": "epidemic" }),
      fakePrisma() as never,
    );
    expect(service.providerName).toBe("epidemic");
  });
});

describe("PartnerCatalogueService (D04b) — grant lifecycle, flag on, mock provider", () => {
  it("search / grant / reportUsage / revoke succeed against the mock adapter", async () => {
    const prisma = fakePrisma();
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      prisma as never,
    );

    const results = await service.search("");
    expect(results.hits.length).toBeGreaterThan(0);
    const first = results.hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");

    const { grantId, licenceSnapshot } = await service.grant({
      providerAssetId: first.providerAssetId,
      workspaceId: "ws_1",
      useContext: "pass_item",
    });
    expect(grantId).toBeTruthy();
    // TODO(H-28): the snapshot is a placeholder until the partner contract signs.
    expect(licenceSnapshot["pending"]).toBe(true);
    expect(prisma.assetClearanceGrant.create).toHaveBeenCalledOnce();

    const report = await service.reportUsage({ grantId, exportId: "exp_1" });
    expect(report.reportRef).toBeTruthy();

    await service.revoke(grantId);
    await expect(service.reportUsage({ grantId, exportId: "exp_2" })).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.grantRevoked,
    });
  });

  it("reportUsage against an unknown grant id is refused", async () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      fakePrisma() as never,
    );
    await expect(
      service.reportUsage({ grantId: "no-such-grant", exportId: "e" }),
    ).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.grantNotFound,
    });
  });
});
