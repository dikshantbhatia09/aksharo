import { describe, expect, it } from "vitest";

import { NotifyController } from "./notify.controller.js";
import { NotifyService } from "./notify.service.js";
import { MailEventsController } from "./sns/mail-events.controller.js";
import { SuppressionService } from "./suppression.service.js";
import {
  createFakePrisma,
  createMemoryRedis,
  FakeDb,
  FakeQueueRegistry,
} from "../../test/fakes.js";
import { snsFixture, snsNotification } from "../../test/sns-fixture.js";

import type { ListNotificationsQueryDto } from "./notify.dto.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RedisService } from "../common/redis/redis.service.js";
import type { QueueRegistry } from "../jobs/queue.registry.js";
import type { RealtimePublisher } from "../realtime/realtime.publisher.js";

const USER = "01JCUSER00000000000000000A";
const OTHER = "01JCOTHER0000000000000000A";

function buildBell() {
  const db = new FakeDb();
  const service = new NotifyService(
    createFakePrisma(db) as unknown as PrismaService,
    new FakeQueueRegistry() as unknown as QueueRegistry,
    { notificationCreated: async () => undefined } as unknown as RealtimePublisher,
  );
  return { controller: new NotifyController(service), db };
}

describe("GET /me/notifications", () => {
  it("returns the caller's rows as ISO-8601, with the badge count", async () => {
    const { controller, db } = buildBell();
    const created = new Date("2026-09-02T05:00:00.000Z");
    db.notification({
      id: "01JCN0000000000000000000A",
      userId: USER,
      kind: "export-ready",
      data: { project: "Diwali promo" },
      createdAt: created,
    });
    db.notification({ id: "01JCN0000000000000000000B", userId: OTHER });

    const page = await controller.list(USER, {} as ListNotificationsQueryDto);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "01JCN0000000000000000000A",
      kind: "export-ready",
      readAt: null,
      createdAt: "2026-09-02T05:00:00.000Z",
    });
    expect(page.unread).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  it("passes the unread filter through", async () => {
    const { controller, db } = buildBell();
    db.notification({ id: "01JCN0000000000000000000A", userId: USER, readAt: new Date() });
    const page = await controller.list(USER, { unreadOnly: true } as ListNotificationsQueryDto);
    expect(page.items).toHaveLength(0);
    expect(page.unread).toBe(0);
  });
});

describe("POST /me/notifications/{id}/read", () => {
  it("marks the row read and returns it", async () => {
    const { controller, db } = buildBell();
    db.notification({ id: "01JCN0000000000000000000A", userId: USER });
    const row = await controller.markRead(USER, "01JCN0000000000000000000A");
    expect(row.readAt).not.toBeNull();
  });

  it("cannot be used to read someone else's bell", async () => {
    const { controller, db } = buildBell();
    db.notification({ id: "01JCN0000000000000000000A", userId: OTHER });
    await expect(controller.markRead(USER, "01JCN0000000000000000000A")).rejects.toMatchObject({
      code: "notify/not_found",
    });
  });
});

describe.skipIf(!snsFixture.available)("POST /internal/mail/events", () => {
  function buildWebhook(options: { serveCertificate?: boolean } = {}) {
    const redis = createMemoryRedis();
    const db = new FakeDb();
    const suppression = new SuppressionService(
      { client: redis } as unknown as RedisService,
      createFakePrisma(db) as unknown as PrismaService,
    );
    // The signature is real: the fixture signs each message with the key behind
    // the certificate the fetcher serves. `serveCertificate: false` is how a
    // message from something that is not SNS is simulated.
    const controller = new MailEventsController(suppression, async () => {
      if (options.serveCertificate === false) throw new Error("no certificate");
      return snsFixture.certificate;
    });
    return { controller, suppression, db, redis };
  }

  const message = (body: unknown, overrides: Record<string, unknown> = {}) =>
    snsFixture.sign(snsNotification(body, overrides));

  it("rejects a body that is not an SNS message at all", async () => {
    const { controller } = buildWebhook();
    await expect(controller.events({ hello: "world" })).rejects.toMatchObject({
      code: "common/bad_request",
    });
    await expect(controller.events(undefined)).rejects.toMatchObject({
      code: "common/bad_request",
    });
  });

  /**
   * The reason the route can be unauthenticated at all. Without this, anyone who
   * finds the path can suppress any address they can name.
   */
  it("rejects a message whose signature does not verify, and changes nothing", async () => {
    const { controller, suppression } = buildWebhook({ serveCertificate: false });
    await expect(
      controller.events(
        message({
          notificationType: "Bounce",
          bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@b.test" }] },
        }),
      ),
    ).rejects.toMatchObject({ code: "common/unauthorized" });
    expect(await suppression.isSuppressed("a@b.test")).toBe(false);
  });

  it("rejects a forged message signed with the wrong key", async () => {
    const { controller, suppression } = buildWebhook();
    const forged = {
      ...message({
        notificationType: "Complaint",
        complaint: { complainedRecipients: [{ emailAddress: "victim@b.test" }] },
      }),
      Signature: Buffer.from("forged").toString("base64"),
    };
    await expect(controller.events(forged)).rejects.toMatchObject({
      code: "common/unauthorized",
    });
    expect(await suppression.isSuppressed("victim@b.test")).toBe(false);
  });

  it("suppresses every bounced recipient and reports how many", async () => {
    const { controller, suppression, db } = buildWebhook();
    const ack = await controller.events(
      message({
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [{ emailAddress: "one@b.test" }, { emailAddress: "two@b.test" }],
        },
      }),
    );
    expect(ack).toEqual({ status: "ok", handled: "bounce", suppressed: 2, released: 0 });
    expect(await suppression.isSuppressed("one@b.test")).toBe(true);
    expect(await suppression.isSuppressed("two@b.test")).toBe(true);
    expect(db.auditRows).toHaveLength(2);
  });

  it("suppresses a complaint permanently", async () => {
    const { controller, suppression } = buildWebhook();
    await controller.events(
      message({
        notificationType: "Complaint",
        complaint: {
          complainedRecipients: [{ emailAddress: "cross@b.test" }],
          complaintFeedbackType: "abuse",
        },
      }),
    );
    expect(await suppression.lookup("cross@b.test")).toMatchObject({ permanence: "permanent" });
  });

  it("releases a transient suppression when the mailbox delivers again", async () => {
    const { controller, suppression } = buildWebhook();
    await suppression.suppress({
      email: "full@b.test",
      permanence: "transient",
      reason: "Transient/MailboxFull",
      source: "ses-bounce",
    });

    const ack = await controller.events(
      message({ notificationType: "Delivery", delivery: { recipients: ["full@b.test"] } }),
    );

    expect(ack).toEqual({ status: "ok", handled: "delivery", suppressed: 0, released: 1 });
    expect(await suppression.isSuppressed("full@b.test")).toBe(false);
  });

  /**
   * Verified, logged, and deliberately NOT confirmed: confirming would be an
   * outbound GET to a URL that arrived in a request.
   */
  it("acknowledges a subscription confirmation without calling its URL", async () => {
    const { controller } = buildWebhook();
    const ack = await controller.events(
      message(
        {},
        {
          Type: "SubscriptionConfirmation",
          Token: "tok",
          SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription",
        },
      ),
    );
    expect(ack).toEqual({
      status: "ok",
      handled: "SubscriptionConfirmation",
      suppressed: 0,
      released: 0,
    });
  });

  it("acknowledges an event type it does not act on", async () => {
    const { controller } = buildWebhook();
    const ack = await controller.events(message({ eventType: "Send" }));
    expect(ack).toMatchObject({ handled: "other", suppressed: 0, released: 0 });
  });
});
