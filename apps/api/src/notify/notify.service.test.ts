import { describe, expect, it } from "vitest";

import { NO_WORKSPACE, NOTIFY_JOB_NAME, NOTIFY_PRIORITY } from "./notify.constants.js";
import { normaliseKey, NotifyService, toNotificationView } from "./notify.service.js";
import { NotifyJobPayloadSchema } from "./notify.types.js";
import { createFakePrisma, FakeDb, FakeQueueRegistry } from "../../test/fakes.js";
import { isJobEnvelope } from "../jobs/contracts/job-envelope.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { QueueRegistry } from "../jobs/queue.registry.js";
import type { RealtimePublisher } from "../realtime/realtime.publisher.js";

const USER = "01JCUSER00000000000000000A";
const WORKSPACE = "01JCWORKSPACE000000000000A";

/**
 * A queue registry that records what was added AND honours BullMQ's rule that a
 * custom job id is claimed once: the second `add` with the same id returns the
 * first job. That rule is the whole idempotency story, so the fake has to have it.
 */
class DedupingQueueRegistry extends FakeQueueRegistry {
  private readonly claimed = new Set<string>();

  override queue(name: string) {
    const inner = super.queue(name);
    return {
      ...inner,
      add: async (jobName: string, data: unknown, options: Record<string, unknown>) => {
        const id = String(options["jobId"]);
        if (this.claimed.has(id)) return { id: `${id}-existing` };
        this.claimed.add(id);
        await inner.add(jobName, data, options);
        return { id };
      },
    };
  }
}

function build(overrides: { queues?: FakeQueueRegistry } = {}) {
  const db = new FakeDb();
  const queues = overrides.queues ?? new DedupingQueueRegistry();
  const published: { room: string; event: string; data: unknown }[] = [];
  const realtime = {
    notificationCreated: async (workspaceId: string, data: unknown) => {
      published.push({ room: `workspace:${workspaceId}`, event: "notification.created", data });
    },
  } as unknown as RealtimePublisher;

  const service = new NotifyService(
    createFakePrisma(db) as unknown as PrismaService,
    queues as unknown as QueueRegistry,
    realtime,
  );
  return { service, db, queues, published };
}

describe("enqueue", () => {
  it("puts the brief's payload inside the CONTRACTS §3 envelope", async () => {
    const { service, queues } = build();

    await service.enqueue({
      kind: "verify-email",
      to: "asha@example.test",
      locale: "hi-IN",
      data: { link: "https://x.test/v", hours: 24 },
      idempotencyKey: "verify-email-tok1",
      workspaceId: WORKSPACE,
    });

    expect(queues.added).toHaveLength(1);
    const added = queues.added[0];
    expect(added?.queue).toBe("notify");
    expect(added?.name).toBe(NOTIFY_JOB_NAME);
    expect(isJobEnvelope(added?.data)).toBe(true);

    const envelope = added?.data as { payload: unknown; workspaceId: string; jobKey: string };
    expect(envelope.workspaceId).toBe(WORKSPACE);
    expect(envelope.jobKey).toBe("verify-email-tok1");
    const payload = NotifyJobPayloadSchema.parse(envelope.payload);
    expect(payload).toMatchObject({
      kind: "verify-email",
      to: "asha@example.test",
      locale: "hi-IN",
      idempotencyKey: "verify-email-tok1",
      data: { link: "https://x.test/v", hours: 24 },
    });
  });

  it("uses the sentinel workspace for a message sent before there is one", async () => {
    const { service, queues } = build();
    await service.enqueue({
      kind: "verify-email",
      to: "asha@example.test",
      data: { link: "https://x.test", hours: 24 },
    });
    expect((queues.added[0]?.data as { workspaceId: string }).workspaceId).toBe(NO_WORKSPACE);
  });

  it("puts a security message in the fast lane and a nudge in the slow one", async () => {
    const { service, queues } = build();
    await service.enqueue({ kind: "magic-link", to: "a@example.test", data: {} });
    await service.enqueue({ kind: "low-credits", to: "a@example.test", data: {} });
    expect((queues.added[0]?.data as { priority: number }).priority).toBe(NOTIFY_PRIORITY.critical);
    expect((queues.added[1]?.data as { priority: number }).priority).toBe(NOTIFY_PRIORITY.standard);
  });

  it("uses the idempotency key as the BullMQ job id, so a repeat enqueues nothing", async () => {
    const { service, queues } = build();
    const first = await service.enqueue({
      kind: "export-ready",
      to: "a@example.test",
      data: {},
      idempotencyKey: "export-ready-01J",
    });
    const second = await service.enqueue({
      kind: "export-ready",
      to: "a@example.test",
      data: {},
      idempotencyKey: "export-ready-01J",
    });

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(queues.added).toHaveLength(1);
    expect(queues.added[0]?.options["jobId"]).toBe("export-ready-01J");
  });

  it("mints a key when the caller has no unit of work to name", async () => {
    const { service } = build();
    const first = await service.enqueue({ kind: "low-credits", to: "a@example.test", data: {} });
    const second = await service.enqueue({ kind: "low-credits", to: "a@example.test", data: {} });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("rejects an unknown kind and an empty recipient, because both are caller bugs", async () => {
    const { service } = build();
    await expect(
      service.enqueue({ kind: "welcome" as "low-credits", to: "a@example.test" }),
    ).rejects.toThrow(/not a notification kind/);
    await expect(service.enqueue({ kind: "low-credits", to: "   " })).rejects.toThrow(
      /needs a recipient/,
    );
  });

  /**
   * A notification is a side effect of work the caller actually cares about, so a
   * queue that is down must not fail the sign-up that produced it.
   */
  it("never throws when the queue is unavailable", async () => {
    const queues = new FakeQueueRegistry();
    queues.failNextAdd = true;
    const { service } = build({ queues });
    const result = await service.enqueue({ kind: "low-credits", to: "a@example.test", data: {} });
    expect(result.enqueued).toBe(false);
  });
});

describe("the in-app row", () => {
  it("is written for a bell kind, with the realtime event on the workspace room", async () => {
    const { service, db, published } = build();

    const result = await service.enqueue({
      kind: "export-ready",
      to: "asha@example.test",
      userId: USER,
      workspaceId: WORKSPACE,
      data: { project: "Diwali promo", link: "https://x.test/e" },
    });

    expect(result.notificationId).toBeDefined();
    const row = db.notifications.get(result.notificationId ?? "");
    expect(row).toMatchObject({ userId: USER, workspaceId: WORKSPACE, kind: "export-ready" });
    expect(row?.readAt).toBeNull();

    expect(published).toHaveLength(1);
    expect(published[0]?.room).toBe(`workspace:${WORKSPACE}`);
    expect(published[0]?.data).toMatchObject({ userId: USER, kind: "export-ready" });
  });

  it("is not written for a sign-in message, however much context the caller gives", async () => {
    const { service, db, published } = build();
    const result = await service.enqueue({
      kind: "magic-link",
      to: "asha@example.test",
      userId: USER,
      workspaceId: WORKSPACE,
      data: { link: "https://x.test/m", minutes: 15 },
    });
    expect(result.notificationId).toBeUndefined();
    expect(db.notifications.size).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("is skipped, without an event, when there is no user to write it for", async () => {
    const { service, db, published } = build();
    await service.enqueue({ kind: "export-ready", to: "asha@example.test", data: {} });
    expect(db.notifications.size).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("has no room to publish to when the notification has no workspace", async () => {
    const { service, db, published } = build();
    await service.enqueue({ kind: "export-ready", to: "a@example.test", userId: USER, data: {} });
    expect(db.notifications.size).toBe(1);
    expect(published).toHaveLength(0);
  });
});

describe("the bell", () => {
  it("lists newest first, pages by cursor and counts the unread across every page", async () => {
    const { service, db } = build();
    const ids = [
      "01JCN0000000000000000000A",
      "01JCN0000000000000000000B",
      "01JCN0000000000000000000C",
    ];
    for (const id of ids) db.notification({ id, userId: USER });
    db.notification({ id: "01JCN0000000000000000000D", userId: USER, readAt: new Date() });
    db.notification({ id: "01JCN0000000000000000000E", userId: "01JCOTHER0000000000000000" });

    const first = await service.list({ userId: USER, limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual([
      "01JCN0000000000000000000D",
      "01JCN0000000000000000000C",
    ]);
    expect(first.nextCursor).toBe("01JCN0000000000000000000C");
    expect(first.unread).toBe(3);

    const second = await service.list({ userId: USER, limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.items.map((row) => row.id)).toEqual([
      "01JCN0000000000000000000B",
      "01JCN0000000000000000000A",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters to the unread ones on request", async () => {
    const { service, db } = build();
    db.notification({ id: "01JCN0000000000000000000A", userId: USER });
    db.notification({ id: "01JCN0000000000000000000B", userId: USER, readAt: new Date() });
    const page = await service.list({ userId: USER, unreadOnly: true });
    expect(page.items.map((row) => row.id)).toEqual(["01JCN0000000000000000000A"]);
  });

  it("marks one read, and a second call keeps the first timestamp", async () => {
    const { service, db } = build();
    const row = db.notification({ id: "01JCN0000000000000000000A", userId: USER });
    expect(row.readAt).toBeNull();

    const first = await service.markRead(row.id, USER);
    expect(first.readAt).not.toBeNull();
    const second = await service.markRead(row.id, USER);
    expect(second.readAt).toEqual(first.readAt);
  });

  /** A 403 would confirm the id exists; a 404 says nothing (THREAT-MODEL T5). */
  it("is a 404, not a 403, for another user's notification", async () => {
    const { service, db } = build();
    const row = db.notification({ id: "01JCN0000000000000000000A", userId: USER });
    await expect(service.markRead(row.id, "01JCOTHER0000000000000000")).rejects.toMatchObject({
      code: "notify/not_found",
    });
    await expect(service.markRead("01JCMISSING00000000000000", USER)).rejects.toMatchObject({
      code: "notify/not_found",
    });
  });
});

describe("helpers", () => {
  it("strips the characters BullMQ and Redis keys cannot carry", () => {
    expect(normaliseKey("verify-email:tok/1")).toBe("verify-email-tok-1");
    expect(normaliseKey("a".repeat(400))).toHaveLength(200);
    expect(normaliseKey("keep.the_dots-and-dashes")).toBe("keep.the_dots-and-dashes");
  });

  it("turns a row into ISO-8601 timestamps", () => {
    const at = new Date("2026-09-02T05:00:00.000Z");
    const view = toNotificationView({
      id: "01JCN0000000000000000000A",
      userId: USER,
      workspaceId: null,
      kind: "export-ready",
      data: { project: "x" },
      readAt: at,
      createdAt: at,
    });
    expect(view.readAt).toBe("2026-09-02T05:00:00.000Z");
    expect(view.createdAt).toBe("2026-09-02T05:00:00.000Z");
    expect(view.workspaceId).toBeNull();
  });
});
