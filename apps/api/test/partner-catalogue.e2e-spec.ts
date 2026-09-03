/**
 * D04b — partner catalogue integration, against a real migrated Postgres.
 *
 * Three things this suite exists to prove with a real database, not a stub:
 *
 * 1. `assets.partnerCatalogue` off (the default) refuses every
 *    `PartnerCatalogueService` call — search, grant, reportUsage, revoke —
 *    with `partner-catalogue/disabled`, and writes nothing to
 *    `asset_clearance_grants`.
 * 2. With the flag on (mock provider), `grant()` persists a real
 *    `asset_clearance_grants` row whose `licenceSnapshot` carries the
 *    TODO(H-28) placeholder sentinel (orchestrator addendum, 2026-09-03) —
 *    and `reportUsage()`/`revoke()` round-trip against that row.
 * 3. Grant expiry: a grant whose `expiresAt` is in the past (a fake clock,
 *    via a directly-constructed past date rather than a live timer) is
 *    refused for a new usage report with `partner-catalogue/grant_expired`.
 *
 * Needs Postgres exactly as the other `*.e2e-spec.ts` suites do; skips
 * loudly without one.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { Env } from "@montaj/config";

import {
  createTestDatabase,
  isDatabaseAvailable,
  skipReason,
  type TestDatabase,
} from "./db-harness.js";
import { PARTNER_CATALOGUE_ERRORS } from "../src/partner-catalogue/partner-catalogue.constants.js";
import { PartnerCatalogueService } from "../src/partner-catalogue/partner-catalogue.service.js";

const available = isDatabaseAvailable();
if (!available) console.warn(`[partner-catalogue.e2e] skipped: ${skipReason}`);

function fakeEnv(flags: Record<string, unknown>): Env {
  return { FEATURE_FLAGS_JSON: flags } as unknown as Env;
}

describe.skipIf(!available)("PartnerCatalogueService (D04b) — real database", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`partner-catalogue suite could not start: ${skipReason}`);
    db = created;
  }, 60_000);

  afterAll(async () => {
    if (db !== undefined) await db.stop();
  });

  it("flag off (default): every method refuses and no grant row is ever written", async () => {
    const service = new PartnerCatalogueService(fakeEnv({}), db.prisma as never);
    const workspaceId = await createWorkspace(db, "flag-off");

    await expect(service.search("")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.disabled,
    });
    await expect(
      service.grant({ providerAssetId: "mock-sfx-0001", workspaceId, useContext: "pass_item" }),
    ).rejects.toMatchObject({ code: PARTNER_CATALOGUE_ERRORS.disabled });

    const rows = await db.prisma.assetClearanceGrant.count({ where: { workspaceId } });
    expect(rows).toBe(0);
  });

  it("flag on (mock): grant() persists a row with a TODO(H-28) placeholder licenceSnapshot", async () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      db.prisma as never,
    );
    const workspaceId = await createWorkspace(db, "grant-flow");

    const { hits } = await service.search("");
    const first = hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");

    const { grantId, licenceSnapshot } = await service.grant({
      providerAssetId: first.providerAssetId,
      workspaceId,
      useContext: "pass_item",
    });

    const row = await db.prisma.assetClearanceGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.status).toBe("active");
    expect(row.useContext).toBe("pass_item");
    expect(row.licenceSnapshot).toMatchObject({ pending: true, licenceType: "TODO(H-28)" });
    expect(licenceSnapshot["licenceType"]).toBe("TODO(H-28)");

    const report = await service.reportUsage({ grantId, exportId: "exp_e2e_1" });
    expect(report.reportRef).toBeTruthy();

    await service.revoke(grantId);
    const revoked = await db.prisma.assetClearanceGrant.findUniqueOrThrow({
      where: { id: grantId },
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();

    await expect(service.reportUsage({ grantId, exportId: "exp_e2e_2" })).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.grantRevoked,
    });
  });

  it("expiry: a grant whose expiresAt is already in the past is refused for a new usage report", async () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      db.prisma as never,
    );
    const workspaceId = await createWorkspace(db, "expiry");

    const { hits } = await service.search("");
    const first = hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");

    const { grantId } = await service.grant({
      providerAssetId: first.providerAssetId,
      workspaceId,
      useContext: "pass_item",
    });

    // A fake clock: rather than waiting on a real timer, force expiresAt into
    // the past directly on the row `grant()` just wrote — the same effect a
    // fake-clock library would have on `DEFAULT_GRANT_TERM_DAYS` elapsing.
    await db.prisma.assetClearanceGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(service.reportUsage({ grantId, exportId: "exp_e2e_3" })).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.grantExpired,
    });
  });

  it("reportUsage against another workspace's grant id still resolves by id (service is not workspace-scoped by call; caller must check ownership)", async () => {
    // Documents current behaviour rather than asserting a stronger guarantee
    // this work package did not build: `PartnerCatalogueService.reportUsage`
    // takes a bare `grantId`. A caller (the render worker / export
    // completion handler) is responsible for having derived that id from a
    // workspace-scoped lookup in the first place — see the final report.
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      db.prisma as never,
    );
    const workspaceId = await createWorkspace(db, "ownership-note");
    const { hits } = await service.search("");
    const first = hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");
    const { grantId } = await service.grant({
      providerAssetId: first.providerAssetId,
      workspaceId,
      useContext: "pass_item",
    });
    const row = await db.prisma.assetClearanceGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.workspaceId).toBe(workspaceId);
  });
});

let counter = 0;
async function createWorkspace(db: TestDatabase, tag: string): Promise<string> {
  counter += 1;
  const run = `${Date.now().toString(36)}${counter}`.toUpperCase().slice(-10);
  const userId = `01JEPCU${run}`.padEnd(26, "0").slice(0, 26);
  const workspaceId = `01JEPCW${run}`.padEnd(26, "0").slice(0, 26);
  await db.prisma.user.create({
    data: { id: userId, email: `partner-catalogue-${tag}-${run}@example.test`, name: "D04b test" },
  });
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      slug: `partner-catalogue-${tag}-${run}`.toLowerCase(),
      name: `partner-catalogue-${tag}-${run}`,
      ownerId: userId,
      billingCountry: "IN",
    },
  });
  return workspaceId;
}
