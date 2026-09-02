import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { notifyRedisKeys, notifyWorkerEnabled } from "./notify.constants.js";
import { NotifyConsumer } from "./notify.consumer.js";
import { SuppressionService } from "./suppression.service.js";
import {
  createFakePrisma,
  createMemoryRedis,
  FakeDb,
  FakeQueueRegistry,
} from "../../test/fakes.js";
import { buildJobEnvelope } from "../jobs/contracts/job-envelope.js";

import type { MailMessage, MailProvider } from "./mail/mail.provider.js";
import type { NotifyJobPayload } from "./notify.types.js";
import type { RateLimitService } from "../common/guards/rate-limit.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RedisService } from "../common/redis/redis.service.js";
import type { QueueRegistry } from "../jobs/queue.registry.js";
import type { Job as BullJob } from "bullmq";

class RecordingProvider implements MailProvider {
  readonly name = "dev" as const;
  readonly sent: MailMessage[] = [];
  failNext = false;

  send(message: MailMessage): Promise<{ providerMessageId?: string }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("relay refused"));
    }
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: "1" });
  }
}

function build(options: { allowRate?: boolean } = {}) {
  const redis = createMemoryRedis();
  const db = new FakeDb();
  const prisma = createFakePrisma(db) as unknown as PrismaService;
  const suppression = new SuppressionService({ client: redis } as unknown as RedisService, prisma);
  const mail = new RecordingProvider();
  const consumed: string[] = [];
  const limiter = {
    consume: async (_spec: unknown, subject: string) => {
      consumed.push(subject);
      return {
        allowed: options.allowRate ?? true,
        remaining: 0,
        retryAfterSec: 0,
      };
    },
  } as unknown as RateLimitService;

  const consumer = new NotifyConsumer(
    { client: redis } as unknown as RedisService,
    new FakeQueueRegistry() as unknown as QueueRegistry,
    suppression,
    limiter,
    mail,
    { WEB_ORIGIN: "https://app.example.test" } as Env,
  );

  return { consumer, mail, suppression, redis, db, consumed };
}

function payload(overrides: Partial<NotifyJobPayload> = {}): NotifyJobPayload {
  return {
    kind: "verify-email",
    to: "asha@example.test",
    locale: "en",
    data: { link: "https://app.example.test/verify?token=abc", hours: 24 },
    idempotencyKey: "verify-email-abc",
    ...overrides,
  } as NotifyJobPayload;
}

describe("the worker flag", () => {
  it("defaults on, and only the three off spellings turn it off", () => {
    expect(notifyWorkerEnabled({})).toBe(true);
    expect(notifyWorkerEnabled({ NOTIFY_WORKER_ENABLED: "1" })).toBe(true);
    expect(notifyWorkerEnabled({ NOTIFY_WORKER_ENABLED: "0" })).toBe(false);
    expect(notifyWorkerEnabled({ NOTIFY_WORKER_ENABLED: "false" })).toBe(false);
    expect(notifyWorkerEnabled({ NOTIFY_WORKER_ENABLED: "OFF" })).toBe(false);
  });

  it("does not start a worker when it is off", () => {
    const previous = process.env["NOTIFY_WORKER_ENABLED"];
    process.env["NOTIFY_WORKER_ENABLED"] = "0";
    try {
      const { consumer } = build();
      consumer.onApplicationBootstrap();
      expect(consumer.running).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["NOTIFY_WORKER_ENABLED"];
      else process.env["NOTIFY_WORKER_ENABLED"] = previous;
    }
  });
});

describe("delivering one job", () => {
  it("renders and sends, tagging the kind and the locale but never the token", async () => {
    const { consumer, mail } = build();

    const outcome = await consumer.deliver(
      payload({
        devOutbox: { template: "email_verification", token: "tok-1", link: "https://x.test" },
      }),
    );

    expect(outcome).toBe("sent");
    expect(mail.sent).toHaveLength(1);
    const message = mail.sent[0];
    expect(message?.to).toBe("asha@example.test");
    expect(message?.subject).toBe("Confirm your email address");
    expect(message?.tags).toEqual({ kind: "verify-email", locale: "en" });
    expect(JSON.stringify(message?.tags)).not.toContain("tok-1");
    // The token still reaches the development outbox, which is what A04 reads.
    expect(message?.devOutbox?.token).toBe("tok-1");
  });

  it("unwraps the CONTRACTS §3 envelope a producer put the payload in", async () => {
    const { consumer, mail } = build();
    const envelope = buildJobEnvelope({
      jobId: "01JCJ0B000000000000000000A",
      attemptId: "01JCA0T000000000000000000A",
      workspaceId: "01JCWORKSPACE000000000000A",
      priority: 1,
      jobKey: "verify-email-abc",
      createdAt: new Date(),
      payload: payload() as unknown as Record<string, unknown>,
    });

    const outcome = await consumer.handle({ data: envelope } as BullJob);
    expect(outcome).toBe("sent");
    expect(mail.sent).toHaveLength(1);
  });

  it("renders in the recipient's language", async () => {
    const { consumer, mail } = build();
    await consumer.deliver(payload({ locale: "hi-IN" }));
    expect(mail.sent[0]?.tags?.["locale"]).toBe("hi");
    expect(mail.sent[0]?.html).toContain('lang="hi"');
  });

  it("adds the one-click unsubscribe headers only to a kind that allows it", async () => {
    const { consumer, mail } = build();
    await consumer.deliver(payload());
    expect(mail.sent[0]?.headers).toBeUndefined();

    await consumer.deliver(
      payload({
        kind: "low-credits",
        idempotencyKey: "low-credits-1",
        data: { minutes: 12, link: "https://app.example.test/top-up" },
      }),
    );
    expect(mail.sent[1]?.headers).toEqual({
      "List-Unsubscribe": "<https://app.example.test/settings/notifications>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});

describe("suppression", () => {
  /** Acceptance criterion 2: bounce → suppression → next send skipped, with a row. */
  it("skips a suppressed address and writes the audit row", async () => {
    const { consumer, mail, suppression, db } = build();
    await suppression.suppress({
      email: "asha@example.test",
      permanence: "permanent",
      reason: "Permanent/General",
      source: "ses-bounce",
    });
    db.audit.length = 0;

    const outcome = await consumer.deliver(payload());

    expect(outcome).toBe("suppressed");
    expect(mail.sent).toHaveLength(0);
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ action: "notify.send.skipped" });
    expect(db.audit[0]?.data).toMatchObject({
      kind: "verify-email",
      email: "a***@example.test",
    });
  });

  /**
   * Even the critical kinds. A complaint means the recipient asked us to stop,
   * and continuing is what gets a sending domain blocked for everyone else.
   */
  it("applies to a security message too", async () => {
    const { consumer, mail, suppression } = build();
    await suppression.suppress({
      email: "asha@example.test",
      permanence: "permanent",
      reason: "abuse",
      source: "ses-complaint",
    });
    expect(
      await consumer.deliver(
        payload({ kind: "magic-link", data: { link: "https://x.test", minutes: 15 } }),
      ),
    ).toBe("suppressed");
    expect(mail.sent).toHaveLength(0);
  });
});

describe("the per-recipient limit", () => {
  it("stops a nudge at the hourly cap, keyed on the address hash", async () => {
    const { consumer, mail, consumed } = build({ allowRate: false });
    const outcome = await consumer.deliver(
      payload({
        kind: "low-credits",
        idempotencyKey: "low-credits-1",
        data: { minutes: 5, link: "https://app.example.test/top-up" },
      }),
    );
    expect(outcome).toBe("rate-limited");
    expect(mail.sent).toHaveLength(0);
    expect(consumed).toEqual([SuppressionService.hash("asha@example.test")]);
  });

  it("never applies to a message the recipient needs to get back into their account", async () => {
    const { consumer, mail, consumed } = build({ allowRate: false });
    expect(await consumer.deliver(payload())).toBe("sent");
    expect(mail.sent).toHaveLength(1);
    expect(consumed).toEqual([]);
  });
});

describe("at-most-once", () => {
  it("writes a receipt and skips a retry of a message already sent", async () => {
    const { consumer, mail, redis } = build();

    expect(await consumer.deliver(payload())).toBe("sent");
    expect(redis.store.has(notifyRedisKeys.delivered("verify-email-abc"))).toBe(true);

    expect(await consumer.deliver(payload())).toBe("duplicate");
    expect(mail.sent).toHaveLength(1);
  });

  it("leaves no receipt when the send failed, so the retry actually retries", async () => {
    const { consumer, mail, redis } = build();
    mail.failNext = true;

    await expect(consumer.deliver(payload())).rejects.toThrow("relay refused");
    expect(redis.store.has(notifyRedisKeys.delivered("verify-email-abc"))).toBe(false);

    expect(await consumer.deliver(payload())).toBe("sent");
  });
});

describe("jobs that can never succeed", () => {
  it("fails a malformed payload unrecoverably instead of retrying it five times", async () => {
    const { consumer } = build();
    await expect(consumer.handle({ data: { nonsense: true } } as BullJob)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(
      consumer.handle({ data: { ...payload(), kind: "welcome" } } as BullJob),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("fails a template with a missing variable unrecoverably", async () => {
    const { consumer } = build();
    await expect(
      consumer.deliver(payload({ kind: "renewal-notice", data: { name: "Asha" } })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("shutdown", () => {
  it("closes the transport even when no worker was ever started", async () => {
    const { consumer } = build();
    await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();
  });
});
