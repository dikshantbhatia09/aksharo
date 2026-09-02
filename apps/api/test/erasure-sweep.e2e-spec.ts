/**
 * Acceptance criterion 1: "Erasure sweep test passes: after cascade, no row in
 * any personal-data table references the user/workspace except billing
 * documents and consent tombstones."
 *
 * A real PostgreSQL, not a mock — `ResidueCheckService` reads the live Prisma
 * DMMF to find every model with a `userId`/`workspaceId` column, so the only
 * way to prove the cascade actually leaves them at zero is to run it against
 * real rows and count what is left with the same mechanism the runbook script
 * and the admin `replay-tombstones` endpoint use.
 */
import { type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { CommonAuditService } from "../src/common/audit/audit.service.js";
import { ErasureCascadeService } from "../src/privacy/erasure-cascade.service.js";
import { ResidueCheckService } from "../src/privacy/residue-check.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { ObjectStore } from "../src/common/storage/index.js";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[erasure-sweep.e2e] SKIPPED - no test database. ${skipReason}`);
}

const ULID_A = "01JQ0000000000000000000001";
function id(suffix: string): string {
  return (ULID_A.slice(0, 26 - suffix.length) + suffix).toUpperCase();
}

function fakeStore(): ObjectStore {
  return {
    bucket: "fake",
    kind: "s3",
    createMultipartUpload: async () => {
      throw new Error("not used");
    },
    completeMultipartUpload: async () => ({}),
    abortMultipartUpload: async () => undefined,
    presignGet: async () => "https://example.test/",
    presignPut: async () => "https://example.test/",
    head: async () => null,
    put: async () => undefined,
    get: async () => Buffer.alloc(0),
    delete: async () => undefined,
    deleteMany: async (keys: readonly string[]) => keys.length,
    tag: async () => undefined,
  };
}

describe.skipIf(!available)("erasure cascade — the sweep (acceptance criterion 1)", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let cascade: ErasureCascadeService;
  let residue: ResidueCheckService;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error("expected a test database");
    db = created;
    prisma = db.prisma;
    const audit = new CommonAuditService(prisma as unknown as PrismaService);
    residue = new ResidueCheckService(prisma as unknown as PrismaService);
    cascade = new ErasureCascadeService(
      prisma as unknown as PrismaService,
      fakeStore(),
      fakeStore(),
      audit,
    );
  }, 60_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("zeroes every personal-data table except billing documents and consent tombstones", async () => {
    const userId = id("U1");
    const workspaceId = id("W1");
    const projectId = id("P1");
    const mediaId = id("M1");
    const folderId = id("F1");

    await prisma.user.create({
      data: { id: userId, email: `${userId.toLowerCase()}@example.test`, name: "Erase Me" },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `ws-${userId.toLowerCase()}`,
        name: "Personal",
        ownerId: userId,
        billingCountry: "IN",
        billingStateCode: "27",
      },
    });
    await prisma.folder.create({
      data: { id: folderId, workspaceId, name: "Reels" },
    });
    await prisma.project.create({
      data: { id: projectId, workspaceId, folderId, title: "My video", createdBy: userId },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId,
        storageKey: `ws/${workspaceId}/p/${projectId}/media/${mediaId}/raw.mp4`,
      },
    });
    await prisma.memoryEntry.create({
      data: {
        id: id("ME1"),
        workspaceId,
        userId,
        consentId: (
          await prisma.consentRecord.create({
            data: {
              id: id("CR1"),
              userId,
              workspaceId,
              purpose: "memory",
              version: "2026-01-01",
              noticeVersion: "2026-01-01",
            },
          })
        ).id,
        kind: "glossary",
        expiresAt: new Date(Date.now() + 1_000),
      },
    });
    await prisma.comment.create({
      data: { id: id("CM1"), projectId, authorId: userId, body: "note to self" },
    });

    // Billing document: retained by design.
    const invoice = await prisma.invoice.create({
      data: {
        id: id("IN1"),
        workspaceId,
        series: "AK",
        number: "AK000001",
        fiscalYear: "2026-27",
        supplierLegalName: "Aksharo",
        recipientLegalName: "Erase Me",
        recipientEmail: `${userId.toLowerCase()}@example.test`,
        recipientCountry: "IN",
        recipientStateCode: "27",
        placeOfSupplyCountry: "IN",
        placeOfSupplyStateCode: "27",
        supplyType: "intra_state",
        sacCode: "998434",
        itemDescription: "Subscription",
      },
    });

    const dsrRequestId = id("DSR1");
    await prisma.dsrRequest.create({
      data: {
        id: dsrRequestId,
        userId,
        kind: "erasure",
        dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        status: "received",
      },
    });

    // Confirm the fixture actually created residue before the cascade runs —
    // otherwise a bug that no-ops would pass by accident.
    const before = await residue.check({ userId, workspaceId });
    expect(before.length).toBeGreaterThan(0);

    const report = await cascade.run(dsrRequestId);
    expect(report).not.toBeNull();
    expect(report?.projectsDeleted).toBe(1);

    const after = await residue.check({ userId, workspaceId });
    expect(after).toEqual([]);

    // Billing document survives, minimised.
    const survivingInvoice = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(survivingInvoice?.recipientEmail).toBeNull();
    expect(survivingInvoice?.recipientLegalName).toBe("Erase Me");

    // Consent tombstone survives, pointing at the now-anonymised user id.
    const survivingConsent = await prisma.consentRecord.findMany({ where: { userId } });
    expect(survivingConsent.length).toBe(1);

    // The DSR request itself is completed, not deleted.
    const finishedRequest = await prisma.dsrRequest.findUnique({ where: { id: dsrRequestId } });
    expect(finishedRequest?.status).toBe("completed");

    // Idempotent: running it again does nothing (status is no longer "received").
    const second = await cascade.run(dsrRequestId);
    expect(second).toBeNull();
  });
});
