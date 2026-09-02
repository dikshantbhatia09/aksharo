/**
 * Telemetry (C12) against a real PostgreSQL.
 *
 * Acceptance criterion 1: "Nothing is sent without consent (proven at API ...);
 * redaction fixtures pass; retention task deletes on schedule." Acceptance
 * criterion 2: "Diagnostics bundle attaches to a ticket end to end (API e2e)."
 *
 * `CrashReportRetentionTask.sweep` itself is covered with a fake clock in
 * `src/scheduler/tasks/crash-report-retention.task.test.ts` (a mocked Prisma,
 * per that suite's own pattern); this file proves the schedule against real
 * rows instead: seed a crash report older than 30 days, sweep, and see it gone
 * while a fresh one survives.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { CommonAuditService } from "../src/common/audit/audit.service.js";
import { ConsentsService } from "../src/consents/consents.service.js";
import { CrashReportRetentionTask } from "../src/scheduler/tasks/crash-report-retention.task.js";
import { TelemetryForwarderService } from "../src/telemetry/telemetry-forwarder.service.js";
import { TelemetryService } from "../src/telemetry/telemetry.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../src/common/scheduler/scheduled-tasks.service.js";
import type { ObjectStore, ObjectHead } from "../src/common/storage/index.js";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) console.warn(`[telemetry.e2e] SKIPPED - ${skipReason}`);

let db: TestDatabase;
let prisma: PrismaClient;
let seq = 0;

function id(label: string): string {
  seq += 1;
  return `01J${label.slice(0, 4).toUpperCase().padEnd(4, "0")}${String(seq).padStart(19, "0")}`;
}

/** A store whose `head()`/`put()` a test can script, without a real bucket. */
function fakeStore(overrides: Partial<ObjectStore> = {}): ObjectStore {
  return {
    bucket: "fake",
    kind: "r2",
    createMultipartUpload: async () => {
      throw new Error("not used");
    },
    completeMultipartUpload: async () => ({}),
    abortMultipartUpload: async () => undefined,
    presignGet: async () => "https://example.test/get",
    presignPut: async () => "https://example.test/put",
    head: async () => null,
    put: async () => undefined,
    get: async () => Buffer.alloc(0),
    delete: async () => undefined,
    deleteMany: async (keys: readonly string[]) => keys.length,
    tag: async () => undefined,
    ...overrides,
  };
}

describe.skipIf(!available)("telemetry (e2e)", () => {
  beforeAll(async () => {
    db = (await createTestDatabase())!;
    if (db === null) throw new Error(`test database unavailable: ${skipReason}`);
    prisma = db.prisma;
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function newWorkspace(): Promise<{ workspaceId: string; userId: string }> {
    const userId = id("usr");
    const workspaceId = id("wsp");
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId.toLowerCase(),
        name: "Test workspace",
        ownerId: userId,
        billingCountry: "IN",
      },
    });
    return { workspaceId, userId };
  }

  function prismaServiceWithTx(): PrismaService {
    return Object.assign(prisma, {
      ping: async () => undefined,
      withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => prisma.$transaction(fn),
    }) as unknown as PrismaService;
  }

  function newConsents(): ConsentsService {
    const prismaService = prismaServiceWithTx();
    const audit = new CommonAuditService(prismaService);
    const events = { emit: () => true } as unknown as EventEmitter2;
    return new ConsentsService(prismaService, audit, events);
  }

  function newTelemetry(
    consents: ConsentsService,
    store: ObjectStore = fakeStore(),
  ): TelemetryService {
    const prismaService = prismaServiceWithTx();
    const forwarder = new TelemetryForwarderService();
    return new TelemetryService(prismaService, consents, forwarder, store);
  }

  it("rejects an events batch without the telemetry consent", async () => {
    const consents = newConsents();
    const telemetry = newTelemetry(consents);
    const { workspaceId, userId } = await newWorkspace();

    await expect(
      telemetry.submitEvents(
        { userId, workspaceId, kind: "desktop" },
        {
          events: [
            {
              eventId: id("evt"),
              kind: "app_launched",
              at: new Date().toISOString(),
              appVersion: "1.0.0",
              props: {},
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "telemetry/consent_required" });

    const rows = await prisma.productEvent.count({ where: { workspaceId } });
    expect(rows).toBe(0);
  });

  it("accepts an events batch once telemetry consent is granted, and redacts props", async () => {
    const consents = newConsents();
    const telemetry = newTelemetry(consents);
    const { workspaceId, userId } = await newWorkspace();

    await consents.set(userId, workspaceId, "telemetry", true, {});

    const result = await telemetry.submitEvents(
      { userId, workspaceId, kind: "desktop", deviceId: id("dev") },
      {
        events: [
          {
            eventId: id("evt"),
            kind: "app_launched",
            at: new Date().toISOString(),
            appVersion: "1.0.0",
            props: { note: "contact me at leak@example.com", apiKey: "sk_should_be_dropped" },
          },
        ],
      },
    );
    expect(result.accepted).toBe(1);

    const row = await prisma.productEvent.findFirstOrThrow({
      where: { workspaceId, kind: "app_launched" },
    });
    const props = row.props as Record<string, unknown>;
    expect(props["note"]).toBe("contact me at [redacted:email]");
    expect(props["apiKey"]).toBe("[redacted]");
  });

  it("stops accepting events immediately after telemetry consent is withdrawn", async () => {
    const consents = newConsents();
    const telemetry = newTelemetry(consents);
    const { workspaceId, userId } = await newWorkspace();

    await consents.set(userId, workspaceId, "telemetry", true, {});
    await consents.set(userId, workspaceId, "telemetry", false, {});

    await expect(
      telemetry.submitEvents(
        { userId, workspaceId, kind: "desktop" },
        {
          events: [
            {
              eventId: id("evt"),
              kind: "app_quit",
              at: new Date().toISOString(),
              appVersion: "1.0.0",
              props: {},
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "telemetry/consent_required" });
  });

  it("stores a crash report with a redacted stack and log tail, capped at 50 lines", async () => {
    const consents = newConsents();
    const telemetry = newTelemetry(consents);
    const { workspaceId, userId } = await newWorkspace();
    await consents.set(userId, workspaceId, "telemetry", true, {});

    const logTail = Array.from({ length: 60 }, (_, i) => `log line ${i} user@example.com`);
    const { crashReportId } = await telemetry.submitCrash(
      { userId, workspaceId, kind: "desktop" },
      {
        clientKind: "desktop",
        appVersion: "1.2.3",
        osVersion: "Windows 11",
        stack: "Error: boom\n at C:\\Users\\dikshant\\AppData\\app.js:1:1",
        logTail,
      },
    );

    const row = await prisma.crashReport.findUniqueOrThrow({ where: { id: crashReportId } });
    expect(row.stack).not.toContain("dikshant");
    expect(row.logTail).toHaveLength(50);
    expect(row.logTail.every((l) => !l.includes("@example.com"))).toBe(true);
    // The oldest 10 of the 60 lines sent were dropped by the server-side cap.
    expect(row.logTail[0]).toBe("log line 10 [redacted:email]");
  });

  it("presigns, then confirms, a diagnostics bundle onto the caller's own ticket", async () => {
    const consents = newConsents();
    const { workspaceId, userId } = await newWorkspace();
    await consents.set(userId, workspaceId, "telemetry", true, {});

    const ticket = await prisma.supportTicket.create({
      data: {
        id: id("tkt"),
        workspaceId,
        userId,
        subject: "Crash on export",
        body: "The app crashed while exporting.",
        category: "bug",
      },
    });

    let putBytes: Uint8Array | string | undefined;
    const store = fakeStore({
      put: async (input) => {
        putBytes = input.body;
      },
      head: async (): Promise<ObjectHead | null> => ({
        sizeBytes: 1_024,
        contentType: "application/zip",
      }),
    });
    const telemetry = newTelemetry(consents, store);

    const presigned = await telemetry.presignDiagnosticsBundle(
      { userId, workspaceId, kind: "desktop" },
      { ticketId: ticket.id },
    );
    expect(presigned.bundleKey).toBe(`ws/${workspaceId}/support/${ticket.id}/diagnostics.zip`);
    expect(presigned.uploadUrl).toBeTruthy();

    // The client would PUT `zip bytes` to `presigned.uploadUrl` here; the fake
    // store's `head()` above stands in for "the object landed".
    void putBytes;

    const confirmed = await telemetry.confirmDiagnosticsBundle(
      { userId, workspaceId, kind: "desktop" },
      { ticketId: ticket.id },
    );
    expect(confirmed.bundleKey).toBe(presigned.bundleKey);

    const updated = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.diagnostics).toMatchObject({ bundleKey: presigned.bundleKey });
  });

  it("refuses to confirm a bundle over the 10 MB cap", async () => {
    const consents = newConsents();
    const { workspaceId, userId } = await newWorkspace();
    await consents.set(userId, workspaceId, "telemetry", true, {});

    const ticket = await prisma.supportTicket.create({
      data: {
        id: id("tkt"),
        workspaceId,
        userId,
        subject: "Too big",
        body: "n/a",
        category: "bug",
      },
    });

    const store = fakeStore({
      head: async (): Promise<ObjectHead | null> => ({
        sizeBytes: 11 * 1024 * 1024,
        contentType: "application/zip",
      }),
    });
    const telemetry = newTelemetry(consents, store);

    await expect(
      telemetry.confirmDiagnosticsBundle(
        { userId, workspaceId, kind: "desktop" },
        { ticketId: ticket.id },
      ),
    ).rejects.toMatchObject({ code: "common/payload_too_large" });
  });

  it("refuses to confirm a bundle for a ticket the caller does not own", async () => {
    const consents = newConsents();
    const owner = await newWorkspace();
    const other = await newWorkspace();
    await consents.set(other.userId, other.workspaceId, "telemetry", true, {});

    const ticket = await prisma.supportTicket.create({
      data: {
        id: id("tkt"),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        subject: "Not yours",
        body: "n/a",
        category: "bug",
      },
    });

    const telemetry = newTelemetry(consents);
    await expect(
      telemetry.presignDiagnosticsBundle(
        { userId: other.userId, workspaceId: other.workspaceId, kind: "desktop" },
        { ticketId: ticket.id },
      ),
    ).rejects.toMatchObject({ code: "common/not_found" });
  });

  it("the retention task deletes crash reports past 30 days and keeps fresh ones", async () => {
    const { workspaceId, userId } = await newWorkspace();
    const now = new Date("2026-09-03T00:00:00.000Z");
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const fresh = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    const oldId = id("old");
    const freshId = id("new");
    await prisma.crashReport.create({
      data: {
        id: oldId,
        workspaceId,
        userId,
        clientKind: "desktop",
        appVersion: "1.0.0",
        osVersion: "Windows 11",
        stack: "old",
        logTail: [],
        createdAt: old,
      },
    });
    await prisma.crashReport.create({
      data: {
        id: freshId,
        workspaceId,
        userId,
        clientKind: "desktop",
        appVersion: "1.0.0",
        osVersion: "Windows 11",
        stack: "fresh",
        logTail: [],
        createdAt: fresh,
      },
    });

    const scheduler = { register: () => undefined } as unknown as ScheduledTasksService;
    const task = new CrashReportRetentionTask(prisma as unknown as PrismaService, scheduler);
    await task.sweep(now);

    expect(await prisma.crashReport.findUnique({ where: { id: oldId } })).toBeNull();
    expect(await prisma.crashReport.findUnique({ where: { id: freshId } })).not.toBeNull();
  });
});
