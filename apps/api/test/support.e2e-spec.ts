/**
 * Support tickets (B12) against a real PostgreSQL: creation with and without
 * a diagnostics bundle, listing scoped to the workspace, and the "email is a
 * side effect, never the ticket's own failure" contract — a `NotifyService`
 * stub that throws still leaves the ticket created.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { SupportService } from "../src/support/support.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) console.warn(`[support.e2e] SKIPPED - ${skipReason}`);

let db: TestDatabase;
let prisma: PrismaClient;
let seq = 0;

function id(label: string): string {
  seq += 1;
  return `01J${label.slice(0, 4).toUpperCase().padEnd(4, "0")}${String(seq).padStart(19, "0")}`;
}

describe.skipIf(!available)("SupportService (e2e)", () => {
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

  function newService(enqueue: NotifyService["enqueue"]): SupportService {
    const prismaService = prisma as unknown as PrismaService;
    const notify = { enqueue } as unknown as NotifyService;
    return new SupportService(prismaService, notify);
  }

  it("creates a ticket without diagnostics when the caller did not opt in", async () => {
    const enqueue = vi.fn().mockResolvedValue({ idempotencyKey: "k", enqueued: true });
    const support = newService(enqueue);
    const { workspaceId, userId } = await newWorkspace();

    const ticket = await support.createTicket(workspaceId, userId, {
      subject: "Export stuck at 90%",
      body: "My export has been processing for 20 minutes.",
      category: "export",
    });

    expect(ticket.hasDiagnostics).toBe(false);
    expect(ticket.status).toBe("open");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({
      kind: "support-ticket-created",
      data: expect.objectContaining({ diagnostics: "not attached" }),
    });
  });

  it("creates a ticket with a diagnostics bundle when the caller opted in", async () => {
    const enqueue = vi.fn().mockResolvedValue({ idempotencyKey: "k", enqueued: true });
    const support = newService(enqueue);
    const { workspaceId, userId } = await newWorkspace();

    const ticket = await support.createTicket(workspaceId, userId, {
      subject: "Weird caption timing",
      body: "Captions lag by half a second after my last edit.",
      category: "bug",
      diagnostics: {
        appVersion: "0.1.0",
        browser: "Chrome 130",
        os: "Windows 11",
        workspaceId,
        jobs: [{ jobId: "01Jjob0000000000000000000", status: "succeeded" }],
        consoleErrors: ["TypeError: x is not a function"],
      },
    });

    expect(ticket.hasDiagnostics).toBe(true);
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.diagnostics).toMatchObject({ appVersion: "0.1.0", browser: "Chrome 130" });
    expect(enqueue.mock.calls[0]![0]).toMatchObject({
      data: expect.objectContaining({ diagnostics: "attached" }),
    });
  });

  it("still creates the ticket even when the notify enqueue throws", async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error("redis is down"));
    const support = newService(enqueue);
    const { workspaceId, userId } = await newWorkspace();

    const ticket = await support.createTicket(workspaceId, userId, {
      subject: "Billing question",
      body: "Why was I charged twice?",
      category: "billing",
    });

    expect(ticket.id).toBeDefined();
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.subject).toBe("Billing question");
  });

  it("lists only this workspace's tickets, newest first", async () => {
    const enqueue = vi.fn().mockResolvedValue({ idempotencyKey: "k", enqueued: true });
    const support = newService(enqueue);
    const a = await newWorkspace();
    const b = await newWorkspace();

    await support.createTicket(a.workspaceId, a.userId, {
      subject: "A1",
      body: "body",
      category: "other",
    });
    await support.createTicket(b.workspaceId, b.userId, {
      subject: "B1",
      body: "body",
      category: "other",
    });
    await support.createTicket(a.workspaceId, a.userId, {
      subject: "A2",
      body: "body",
      category: "other",
    });

    const { tickets } = await support.listTickets(a.workspaceId);
    expect(tickets.map((t) => t.subject)).toEqual(["A2", "A1"]);
  });
});
